// Silnik regul Smart Template (Kreator wzorow seryjnych) - czysty, bezpieczny
// modul JS bez zaleznosci npm (lib/ nie moze wymagac pakietow z konkretnej
// aplikacji). Uzywany zarowno przez apps/kreator-wzorow (budowa/podglad wzoru)
// jak i apps/dokumenty-seryjne (generowanie z gotowego smart template) - jedno
// wspolne miejsce interpretacji regul, zeby preview w Kreatorze i prawdziwe
// generowanie w Dokumentach seryjnych NIGDY sie nie rozjechaly.
//
// Model bezpieczenstwa: manifest to WYLACZNIE dane (JSON), nigdy kod. Zaden
// valueSpec/warunek nie jest interpretowany jako `eval`/`new Function` - kazdy
// dozwolony typ jest jawnie rozpoznawany tutaj, nieznany typ jest bledem.
//
// Polski problem z "l": "l" (l z kreska) NIE rozklada sie pod Unicode NFD tak
// jak a/e/c/n/s/z/z (ten sam pulapek co w dokumenty-seryjne/apps innych apkach
// tego repo - patrz CLAUDE.md) - dlatego zamieniamy je na zwykle "l"/"L"
// JAWNIE, PRZED normalize('NFD').

'use strict';

const SUPPORTED_SCHEMA_VERSION = 1;

const MERGE_FIELD_NAME_RE = /^SCY_F_[0-9A-Fa-f]{6,16}$/;
const BOOKMARK_NAME_RE = /^SCYB_[0-9A-Fa-f]{6,20}$/;
const VALUE_SPEC_TYPES = new Set(['column', 'lookup', 'compose']);
const COMPOSE_PART_TYPES = new Set(['literal', 'column', 'field']);
const CONDITION_OPERATORS = new Set([
  'equals', 'notEquals', 'contains', 'notContains', 'oneOf',
  'empty', 'notEmpty', 'lt', 'lte', 'gt', 'gte'
]);
const VARIANT_GROUP_POLICIES = new Set(['exactlyOne', 'zeroOrOne']);
// Obronne, nie "prawdziwe" wykrywanie kodu - manifest jest whitelistowany
// strukturalnie (nieznany typ = blad), to tylko dodatkowa, jawna zapora przed
// polami sugerujacymi wykonywalny kod, ktorej test regresyjny ma pilnowac.
const FORBIDDEN_KEYS = new Set(['code', 'eval', 'script', 'exec', 'function', '__proto__']);

// --- normalizacja tekstu -----------------------------------------------

function normalizeSmartText(value) {
  return String(value == null ? '' : value)
    .replace(/ł/g, 'l')
    .replace(/Ł/g, 'L')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

// Rozumie "5,52", "5.52", "5,52 kWp". Wiecej niz jedna liczba w tekscie (np.
// "5/6", "10+2") jest NIEJEDNOZNACZNA i traktowana jak blad, nie sklejana w
// jedna wieksza liczbe (ten sam blad klasy juz raz naprawiony w kilku innych
// apkach tego repo dla podobnych pol - patrz test/group4-ecodan.test.js).
function parseSmartNumber(value) {
  const raw = String(value == null ? '' : value).trim();
  if (!raw) return { value: null, present: false, valid: true, raw, error: null };
  const normalized = raw.replace(/,/g, '.');
  const groups = normalized.match(/-?\d+(?:\.\d+)?/g) || [];
  if (groups.length !== 1) {
    return { value: null, present: true, valid: false, raw, error: `nie rozpoznaję jednoznacznej liczby w "${raw}"` };
  }
  return { value: Number(groups[0]), present: true, valid: true, raw, error: null };
}

// Zwraca undefined gdy kolumna NAPRAWDE nie istnieje w rekordzie (odrozniane
// od '' - komorka istnieje, ale jest pusta). Tolerowana jest wylacznie roznica
// bialych znakow na poczatku/koncu nazwy kolumny - to NIE jest fuzzy
// dopasowanie po podobienstwie tekstu (zakazane w sekcji 32 specyfikacji),
// tylko odpornosc na przypadkowa spacje przy wklejaniu nazwy kolumny w UI.
function getColumnValue(record, column) {
  if (record == null || !column) return undefined;
  if (Object.prototype.hasOwnProperty.call(record, column)) return record[column];
  const target = String(column).trim();
  for (const key of Object.keys(record)) {
    if (String(key).trim() === target) return record[key];
  }
  return undefined;
}

// --- warunki bloku --------------------------------------------------------

function evaluateCondition(condition, context) {
  const column = condition && condition.column;
  const operator = condition && condition.operator;
  const rawValue = getColumnValue(context.record, column);
  if (rawValue === undefined) {
    return { matched: false, valid: false, error: `Kolumna "${column}" nie istnieje w arkuszu.` };
  }
  const text = String(rawValue == null ? '' : rawValue);
  const normText = normalizeSmartText(text);

  switch (operator) {
    case 'empty':
      return { matched: normText === '', valid: true };
    case 'notEmpty':
      return { matched: normText !== '', valid: true };
    case 'equals':
      return { matched: normText === normalizeSmartText(condition.value), valid: true };
    case 'notEquals':
      return { matched: normText !== normalizeSmartText(condition.value), valid: true };
    case 'contains':
      return { matched: normText.includes(normalizeSmartText(condition.value)), valid: true };
    case 'notContains':
      return { matched: !normText.includes(normalizeSmartText(condition.value)), valid: true };
    case 'oneOf': {
      const list = Array.isArray(condition.value) ? condition.value : [];
      return { matched: list.some(v => normalizeSmartText(v) === normText), valid: true };
    }
    case 'lt':
    case 'lte':
    case 'gt':
    case 'gte': {
      const parsedValue = parseSmartNumber(text);
      const parsedThreshold = parseSmartNumber(condition.value);
      if (!parsedValue.present || !parsedValue.valid) {
        return { matched: false, valid: false, error: `Wartość "${text}" w kolumnie "${column}" nie jest jednoznaczną liczbą - to tylko warunek wyboru treści, nie obliczenie techniczne, ale wartość musi dać się jednoznacznie odczytać.` };
      }
      if (!parsedThreshold.present || !parsedThreshold.valid) {
        return { matched: false, valid: false, error: `Próg warunku "${condition.value}" nie jest jednoznaczną liczbą.` };
      }
      const a = parsedValue.value;
      const b = parsedThreshold.value;
      const matched = operator === 'lt' ? a < b : operator === 'lte' ? a <= b : operator === 'gt' ? a > b : a >= b;
      return { matched, valid: true };
    }
    default:
      return { matched: false, valid: false, error: `Nieznany operator warunku: "${operator}".` };
  }
}

// --- wartosc pola -----------------------------------------------------

function applyNumberFormat(text, numberFormat) {
  if (!numberFormat || !text) return text;
  const parsed = parseSmartNumber(text);
  if (!parsed.valid) return { error: `Wartość "${text}" nie jest jednoznaczną liczbą - nie można sformatować.` };
  if (!parsed.present) return text;
  const decimals = Number.isInteger(numberFormat.decimals) ? numberFormat.decimals : null;
  let numText = decimals != null ? parsed.value.toFixed(decimals) : String(parsed.value);
  if (numberFormat.trimTrailingZeros && decimals != null) {
    numText = numText.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
  }
  if (numberFormat.decimalComma) numText = numText.replace('.', ',');
  return numText;
}

// context = { record: surowy rekord z Excela, fields: dotad wyliczone SCY pola
// (mapa fieldId -> tekst) }. `compose` moze odwolywac sie WYLACZNIE do pol juz
// obecnych w `fields` (czyli zdefiniowanych WCZESNIEJ w manifest.fields) -
// walidacja "do przodu" pilnuje tego w validateManifest, wiec runtime moze
// bezpiecznie zalozyc, ze referencja albo istnieje, albo manifest jest
// niepoprawny i nie powinien byl przejsc walidacji.
function evaluateValueSpec(spec, context) {
  if (!spec || typeof spec !== 'object' || !VALUE_SPEC_TYPES.has(spec.type)) {
    return { value: '', valid: false, error: 'Nieznany lub brakujący typ wartości pola.' };
  }

  if (spec.type === 'column') {
    const raw = getColumnValue(context.record, spec.column);
    if (raw === undefined) return { value: '', valid: false, error: `Kolumna "${spec.column}" nie istnieje w arkuszu.` };
    let text = String(raw == null ? '' : raw).trim();
    if (text && spec.numberFormat) {
      const formatted = applyNumberFormat(text, spec.numberFormat);
      if (formatted && typeof formatted === 'object' && formatted.error) return { value: '', valid: false, error: formatted.error };
      text = formatted;
    }
    if (text && spec.prefix) text = String(spec.prefix) + text;
    if (text && spec.suffix) text = text + String(spec.suffix);
    return { value: text, valid: true };
  }

  if (spec.type === 'lookup') {
    const raw = getColumnValue(context.record, spec.column);
    if (raw === undefined) return { value: '', valid: false, error: `Kolumna "${spec.column}" nie istnieje w arkuszu.` };
    const text = String(raw == null ? '' : raw).trim();
    if (!text) return { value: '', valid: true };
    const map = spec.map && typeof spec.map === 'object' ? spec.map : {};
    if (Object.prototype.hasOwnProperty.call(map, text)) return { value: String(map[text]), valid: true };
    const normKey = normalizeSmartText(text);
    const foundKey = Object.keys(map).find(k => normalizeSmartText(k) === normKey);
    if (foundKey) return { value: String(map[foundKey]), valid: true };
    // Nie zgadujemy - brak mapowania to jawny, osobno raportowany stan
    // ("unmapped"), o ktorym decyduje field.unknownPolicy w evaluateSmartRecord,
    // nie cichy fallback na pusty tekst.
    return { value: '', valid: true, unmapped: true, unmappedValue: text };
  }

  // compose
  const parts = Array.isArray(spec.parts) ? spec.parts : null;
  if (!parts) return { value: '', valid: false, error: 'compose wymaga tablicy "parts".' };
  let result = '';
  for (const part of parts) {
    if (!part || !COMPOSE_PART_TYPES.has(part.type)) {
      return { value: '', valid: false, error: `Nieznany typ fragmentu compose: "${part && part.type}".` };
    }
    if (part.type === 'literal') {
      result += String(part.value == null ? '' : part.value);
      continue;
    }
    if (part.type === 'column') {
      const raw = getColumnValue(context.record, part.column);
      if (raw === undefined) return { value: '', valid: false, error: `Kolumna "${part.column}" nie istnieje w arkuszu.` };
      result += String(raw == null ? '' : raw).trim();
      continue;
    }
    // part.type === 'field'
    if (!context.fields || !Object.prototype.hasOwnProperty.call(context.fields, part.fieldId)) {
      return { value: '', valid: false, error: `Pole "${part.fieldId}" nie zostało jeszcze wyliczone (musi być zdefiniowane wcześniej w liście pól).` };
    }
    result += String(context.fields[part.fieldId] == null ? '' : context.fields[part.fieldId]);
  }
  return { value: result, valid: true };
}

// --- caly rekord ------------------------------------------------------

// Zwraca { record, warnings, errors } - NIGDY nie modyfikuje sourceRecord
// (rozklada go plytko w nowym obiekcie). `record` na wyjsciu ma dolozone
// syntetyczne wlasciwosci SCY_F_xxx (gotowe do podmiany jako prawdziwe
// MERGEFIELD przez istniejacy PowerShell) oraz _scyBlocksJson (mapa
// bookmarkName -> bool, ktora bookmarki zostawic/usunac).
function evaluateSmartRecord(manifest, sourceRecord) {
  const warnings = [];
  const errors = [];
  const fieldsOut = {};
  const record = Object.assign({}, sourceRecord);

  for (const field of (manifest && manifest.fields) || []) {
    const context = { record: sourceRecord, fields: fieldsOut };
    const result = evaluateValueSpec(field.valueSpec, context);
    let value = '';
    if (!result.valid) {
      errors.push({ fieldId: field.id, label: field.label, message: result.error || 'Nie udało się wyliczyć wartości pola.' });
    } else if (result.unmapped) {
      const policy = field.unknownPolicy || 'error';
      const column = field.valueSpec && field.valueSpec.column;
      const message = `Wartość "${result.unmappedValue}" w kolumnie "${column}" nie ma mapowania dla pola "${field.label || field.id}".`;
      (policy === 'error' ? errors : warnings).push({ fieldId: field.id, label: field.label, message });
    } else {
      value = result.value;
      if (!String(value).trim() && field.required) {
        const policy = field.emptyPolicy || 'error';
        const message = `Pole "${field.label || field.id}" jest wymagane, ale wartość jest pusta.`;
        (policy === 'error' ? errors : warnings).push({ fieldId: field.id, label: field.label, message });
      }
    }
    fieldsOut[field.id] = value;
    if (field.mergeFieldName) record[field.mergeFieldName] = value;
  }

  const blocksState = {};
  const variantMatches = {};
  for (const block of (manifest && manifest.blocks) || []) {
    const evalResult = evaluateCondition(block.condition, { record: sourceRecord, fields: fieldsOut });
    if (!evalResult.valid) {
      errors.push({ blockId: block.id, label: block.label, message: evalResult.error || 'Nie udało się ocenić warunku bloku.' });
      blocksState[block.bookmarkName] = false;
      continue;
    }
    blocksState[block.bookmarkName] = Boolean(evalResult.matched);
    if (block.variantGroupId) {
      if (!variantMatches[block.variantGroupId]) variantMatches[block.variantGroupId] = [];
      if (evalResult.matched) variantMatches[block.variantGroupId].push(block.id);
    }
  }

  for (const group of (manifest && manifest.variantGroups) || []) {
    const matches = variantMatches[group.id] || [];
    if (group.policy === 'exactlyOne' && matches.length !== 1) {
      errors.push({
        variantGroupId: group.id,
        label: group.label,
        message: matches.length === 0
          ? `Grupa wariantów "${group.label || group.id}" - żaden blok nie pasuje dla tego rekordu.`
          : `Grupa wariantów "${group.label || group.id}" - pasuje więcej niż jeden blok naraz (${matches.join(', ')}).`
      });
    } else if (group.policy === 'zeroOrOne' && matches.length > 1) {
      errors.push({
        variantGroupId: group.id,
        label: group.label,
        message: `Grupa wariantów "${group.label || group.id}" - pasuje więcej niż jeden blok naraz (${matches.join(', ')}).`
      });
    }
  }

  record._scyBlocksJson = JSON.stringify(blocksState);
  return { record, warnings, errors };
}

// --- manifest: walidacja struktury (bez danych rekordow) ---------------

function scanForbiddenKeys(node, nodePath, errors) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    node.forEach((item, i) => scanForbiddenKeys(item, `${nodePath}[${i}]`, errors));
    return;
  }
  for (const key of Object.keys(node)) {
    if (FORBIDDEN_KEYS.has(key)) {
      errors.push(`Niedozwolone pole "${key}" w ${nodePath} - manifest nie może zawierać wykonywalnego kodu.`);
    }
    scanForbiddenKeys(node[key], `${nodePath}.${key}`, errors);
  }
}

function validateManifest(manifest) {
  if (!manifest || typeof manifest !== 'object') {
    return { valid: false, futureVersion: false, errors: ['Manifest nie jest obiektem.'] };
  }
  const version = manifest.schemaVersion;
  if (version !== SUPPORTED_SCHEMA_VERSION) {
    const future = Number.isInteger(version) && version > SUPPORTED_SCHEMA_VERSION;
    return {
      valid: false,
      futureVersion: future,
      errors: [future
        ? `Wzór zapisany nowszą wersją Kreatora (schemaVersion=${version}) - zaktualizuj Scyzoryka, żeby go otworzyć.`
        : `Nieobsługiwana wersja manifestu smart template: ${JSON.stringify(version)}.`]
    };
  }

  const errors = [];
  scanForbiddenKeys(manifest, 'manifest', errors);
  if (typeof manifest.templateId !== 'string' || !manifest.templateId.trim()) errors.push('Brak templateId.');
  if (typeof manifest.templateName !== 'string' || !manifest.templateName.trim()) errors.push('Brak templateName.');
  if (typeof manifest.addressColumn !== 'string' || !manifest.addressColumn.trim()) errors.push('Brak addressColumn.');

  const fields = Array.isArray(manifest.fields) ? manifest.fields : [];
  const fieldIds = new Set();
  fields.forEach((field, index) => {
    const ctx = `fields[${index}]`;
    if (!field || typeof field !== 'object') { errors.push(`${ctx}: nie jest obiektem.`); return; }
    if (typeof field.id !== 'string' || !field.id.trim()) { errors.push(`${ctx}: brak id.`); return; }
    if (fieldIds.has(field.id)) errors.push(`${ctx}: zduplikowane id pola "${field.id}".`);
    fieldIds.add(field.id);
    if (!MERGE_FIELD_NAME_RE.test(String(field.mergeFieldName || ''))) {
      errors.push(`${ctx} (${field.id}): nieprawidłowa nazwa mergeFieldName "${field.mergeFieldName}".`);
    }
    const spec = field.valueSpec;
    if (!spec || !VALUE_SPEC_TYPES.has(spec.type)) {
      errors.push(`${ctx} (${field.id}): nieprawidłowy typ valueSpec.`);
      return;
    }
    if (spec.type === 'column' || spec.type === 'lookup') {
      if (typeof spec.column !== 'string' || !spec.column.trim()) errors.push(`${ctx} (${field.id}): brak kolumny źródłowej.`);
      if (spec.type === 'lookup' && (typeof spec.map !== 'object' || spec.map === null || Array.isArray(spec.map))) {
        errors.push(`${ctx} (${field.id}): lookup wymaga obiektu "map".`);
      }
    } else {
      const parts = Array.isArray(spec.parts) ? spec.parts : null;
      if (!parts) {
        errors.push(`${ctx} (${field.id}): compose wymaga tablicy "parts".`);
      } else {
        parts.forEach((part, pIndex) => {
          const pctx = `${ctx} (${field.id}).parts[${pIndex}]`;
          if (!part || !COMPOSE_PART_TYPES.has(part.type)) { errors.push(`${pctx}: nieprawidłowy typ fragmentu.`); return; }
          if (part.type === 'field') {
            const seenEarlier = fields.slice(0, index).some(f => f && f.id === part.fieldId);
            if (!seenEarlier) errors.push(`${pctx}: pole "${part.fieldId}" musi być zdefiniowane WCZEŚNIEJ w liście pól (bez odwołań "do przodu").`);
          }
          if (part.type === 'column' && (typeof part.column !== 'string' || !part.column.trim())) errors.push(`${pctx}: brak kolumny.`);
          if (part.type === 'literal' && typeof part.value !== 'string') errors.push(`${pctx}: literal wymaga tekstu "value".`);
        });
      }
    }
  });

  const variantGroupIds = new Set();
  const groups = Array.isArray(manifest.variantGroups) ? manifest.variantGroups : [];
  groups.forEach((group, index) => {
    if (!group || typeof group.id !== 'string' || !group.id.trim()) { errors.push(`variantGroups[${index}]: brak id.`); return; }
    if (variantGroupIds.has(group.id)) errors.push(`variantGroups[${index}]: zduplikowane id grupy "${group.id}".`);
    variantGroupIds.add(group.id);
    if (!VARIANT_GROUP_POLICIES.has(group.policy)) errors.push(`variantGroups[${index}] (${group.id}): nieprawidłowa polityka "${group.policy}".`);
  });

  const bookmarkNames = new Set();
  const blocks = Array.isArray(manifest.blocks) ? manifest.blocks : [];
  blocks.forEach((block, index) => {
    const ctx = `blocks[${index}]`;
    if (!block || typeof block.id !== 'string' || !block.id.trim()) { errors.push(`${ctx}: brak id.`); return; }
    const bookmarkName = String(block.bookmarkName || '');
    if (!BOOKMARK_NAME_RE.test(bookmarkName) || bookmarkName.length > 40) {
      errors.push(`${ctx} (${block.id}): nieprawidłowa nazwa bookmarkName "${block.bookmarkName}".`);
    } else if (bookmarkNames.has(bookmarkName)) {
      errors.push(`${ctx} (${block.id}): zduplikowany bookmarkName "${bookmarkName}".`);
    } else {
      bookmarkNames.add(bookmarkName);
    }
    const cond = block.condition;
    if (!cond || !CONDITION_OPERATORS.has(cond.operator)) {
      errors.push(`${ctx} (${block.id}): nieprawidłowy operator warunku.`);
    } else if (cond.operator !== 'empty' && cond.operator !== 'notEmpty' && typeof cond.value === 'undefined') {
      errors.push(`${ctx} (${block.id}): warunek wymaga wartości "value".`);
    }
    if (!cond || typeof cond.column !== 'string' || !cond.column.trim()) errors.push(`${ctx} (${block.id}): warunek wymaga kolumny.`);
    if (block.variantGroupId && !variantGroupIds.has(block.variantGroupId)) {
      errors.push(`${ctx} (${block.id}): variantGroupId "${block.variantGroupId}" nie istnieje w variantGroups.`);
    }
  });

  const manualRegions = Array.isArray(manifest.manualRegions) ? manifest.manualRegions : [];
  manualRegions.forEach((region, index) => {
    if (!region || typeof region.candidateId !== 'string' || !region.candidateId.trim()) {
      errors.push(`manualRegions[${index}]: brak candidateId.`);
    }
  });

  return { valid: errors.length === 0, futureVersion: false, errors };
}

// Zestaw wszystkich nazw kolumn Excela, ktorych manifest realnie potrzebuje -
// addressColumn + kazda kolumna uzyta w polach (column/lookup/compose) i w
// warunkach blokow. Uzywane przez Dokumenty seryjne do preflight walidacji
// PRZED generowaniem ("czy ten konkretny Excel w ogole ma to, czego wzor
// wymaga"), zamiast generowac "na oko" i wywalic sie w polowie paczki.
function collectRequiredColumns(manifest) {
  const columns = new Set();
  if (manifest && manifest.addressColumn) columns.add(manifest.addressColumn);
  for (const field of (manifest && manifest.fields) || []) {
    const spec = field.valueSpec;
    if (!spec) continue;
    if ((spec.type === 'column' || spec.type === 'lookup') && spec.column) columns.add(spec.column);
    if (spec.type === 'compose') {
      for (const part of spec.parts || []) {
        if (part && part.type === 'column' && part.column) columns.add(part.column);
      }
    }
  }
  for (const block of (manifest && manifest.blocks) || []) {
    if (block && block.condition && block.condition.column) columns.add(block.condition.column);
  }
  return Array.from(columns);
}

module.exports = {
  SUPPORTED_SCHEMA_VERSION,
  normalizeSmartText,
  parseSmartNumber,
  getColumnValue,
  evaluateValueSpec,
  evaluateCondition,
  evaluateSmartRecord,
  validateManifest,
  collectRequiredColumns
};
