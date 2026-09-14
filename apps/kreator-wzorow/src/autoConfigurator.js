// Auto-konfiguracja kandydatow Kreatora - lokalny, deterministyczny silnik
// (zero AI/sieci - patrz PROMPT_CLAUDE_AUTO_KONFIGURACJA_KREATORA.md sekcja 5).
// Ten modul jest CZYSTY: nigdy nie mutuje draftu, nie zapisuje do pamieci, nie
// dotyka dysku poza odczytem przekazanego juz w pamieci arkusza. Mutacja
// draftu na podstawie wyniku analizy zyje w autoConfigApply.js.
//
// Priorytet (sekcja 63 promptu): zero blednych auto-mappingow > wyjasnialnosc
// > coverage. Progi i marginesy sa celowo konserwatywne - lepiej wiecej
// kandydatow w "review" niz choc jeden zly "auto".
const { normalizeValue, tokenize, isTrivialValue, columnTokenCoverage, guessValueType } = require('./textNormalize');
const domainAliases = require('./domainAliases');

const AUTO_APPLY_THRESHOLD = 0.95;
const REVIEW_THRESHOLD = 0.75;
const MIN_MARGIN_FOR_AUTO = 15; // punkty na skali 0-100, przed kara za kolizje
const COLLISION_BAND = 8; // inna kolumna w tym promieniu od zwyciezcy liczy sie jako kolidujaca

// --- profilowanie kolumn Excela i indeks wartosci ---------------------------

// Runtime-only (NIGDY nie zapisywane na dysk) - per-kolumnowy profil +
// per-kolumnowy indeks wartosci (do sygnalu EXACT_MATCH_ANYWHERE).
function profileWorkbookColumns(sheet) {
  return sheet.columns.map((name) => {
    const valueIndex = new Map();
    let nonEmptyCount = 0;
    const typeCounts = {};
    const examples = [];

    for (const row of sheet.rows) {
      const raw = row[name];
      if (raw === undefined || raw === null || String(raw).trim() === '') continue;
      nonEmptyCount++;
      if (examples.length < 5) examples.push(raw);
      const norm = normalizeValue(raw);
      const list = valueIndex.get(norm) || [];
      list.push({ recordNumber: row._record, rawValue: raw });
      valueIndex.set(norm, list);
      const type = guessValueType(norm) || 'free-text';
      typeCounts[type] = (typeCounts[type] || 0) + 1;
    }

    const dominantType = Object.entries(typeCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || 'free-text';
    return {
      name,
      normalizedTokens: tokenize(normalizeValue(name)),
      totalCount: sheet.rows.length,
      emptyCount: sheet.rows.length - nonEmptyCount,
      uniqueCount: valueIndex.size,
      uniquenessRatio: nonEmptyCount ? valueIndex.size / nonEmptyCount : 0,
      dominantType,
      examples,
      valueIndex,
    };
  });
}

// Indeks GLOBALNY (wszystkie kolumny razem) - uzywany wylacznie do detekcji
// wiersza wzorcowego (potrzebuje wiedziec, KTORY rekord zbiera najwiecej
// niezaleznych trafien, niezaleznie od tego w ktorej kolumnie).
function buildValueIndex(sheet) {
  const index = new Map();
  for (const row of sheet.rows) {
    for (const columnName of sheet.columns) {
      const raw = row[columnName];
      if (raw === undefined || raw === null || String(raw).trim() === '') continue;
      const norm = normalizeValue(raw);
      const list = index.get(norm) || [];
      list.push({ recordNumber: row._record, columnName, rawValue: raw });
      index.set(norm, list);
    }
  }
  return index;
}

// --- detekcja wiersza wzorcowego ---------------------------------------------

function detectSampleRow(candidates, valueIndex) {
  const nonTrivial = candidates.filter((c) => !isTrivialValue(normalizeValue(c.text)));
  const rowScores = new Map(); // recordNumber -> { score, matched: Set(candidateId) }

  for (const candidate of nonTrivial) {
    const candNorm = normalizeValue(candidate.text);
    const hits = valueIndex.get(candNorm) || [];
    if (!hits.length) continue;
    // Im rzadsza wartosc w calym arkuszu, tym mocniejszy sygnal, ze to
    // TEN kandydat wskazuje TEN konkretny wiersz (a nie przypadek).
    const distinctivenessBonus = hits.length <= 1 ? 2 : hits.length <= 3 ? 1 : 0;
    const countedRecords = new Set();
    for (const hit of hits) {
      if (countedRecords.has(hit.recordNumber)) continue; // ta sama wartosc w kilku kolumnach TEGO rekordu liczy sie raz
      countedRecords.add(hit.recordNumber);
      const entry = rowScores.get(hit.recordNumber) || { score: 0, matched: new Set() };
      entry.score += 3 + distinctivenessBonus;
      entry.matched.add(candidate.id);
      rowScores.set(hit.recordNumber, entry);
    }
  }

  const ranked = [...rowScores.entries()]
    .map(([recordNumber, e]) => ({ recordNumber, score: e.score, matchedCount: e.matched.size }))
    .sort((a, b) => b.score - a.score || b.matchedCount - a.matchedCount);

  if (!ranked.length) return { recordNumber: null, confidence: 0, matchedCandidateCount: 0, reason: 'no-matches' };

  const [top1, top2] = ranked;
  const MIN_SCORE = 9;
  const MIN_MATCHED_CANDIDATES = 2;
  const MIN_MARGIN_RATIO = 1.5;
  const MIN_MARGIN_ABS = 4;

  if (top1.score < MIN_SCORE || top1.matchedCount < MIN_MATCHED_CANDIDATES) {
    return { recordNumber: null, confidence: 0, matchedCandidateCount: top1.matchedCount, reason: 'below-minimum' };
  }

  const runnerUp = top2 ? top2.score : 0;
  const marginOk = (top1.score - runnerUp) >= MIN_MARGIN_ABS && (runnerUp === 0 || top1.score / runnerUp >= MIN_MARGIN_RATIO);
  if (!marginOk) {
    return { recordNumber: null, confidence: 0, matchedCandidateCount: top1.matchedCount, reason: 'ambiguous-top2' };
  }

  return {
    recordNumber: top1.recordNumber,
    confidence: clamp(top1.score / (top1.score + 6), 0, 1),
    matchedCandidateCount: top1.matchedCount,
    reason: 'ok',
  };
}

// --- kontekst kandydata -------------------------------------------------------

// Wszystkie pola kontekstu sa opcjonalne (kompatybilnosc wsteczna z jobami
// zeskanowanymi przed rozszerzeniem CandidateDto o kontekst strukturalny) -
// brakujace pole to po prostu brak wkladu do tokenow, nigdy wyjatek.
function collectContextTokens(candidate) {
  const parts = [candidate.paragraphPrefix, candidate.paragraphSuffix, candidate.leftCellText, candidate.rightCellText, candidate.before, candidate.after];
  const tokens = [];
  for (const part of parts) {
    if (!part) continue;
    tokens.push(...tokenize(normalizeValue(part)));
  }
  return tokens;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

// --- scoring kandydat -> kolumna ----------------------------------------------

// Druga korekta wag (po pierwszej, patrz SAMPLE_ROW_EXACT/EXACT_MATCH_ANYWHERE
// nizej) - znaleziona przy tescie na PRAWDZIWYM wzorze/arkuszu (2026-09-14,
// "Wzór PV.docx" + "Kazimierz Biskupi 2026..."): tam wiersz wzorcowy w ogole
// nie zostal wykryty (przykladowe wartosci we wzorze NIE byly kopia zadnego
// konkretnego rekordu Excela - zalozenie sekcji 6 promptu nie zawsze sie
// sprawdza w praktyce), wiec JEDYNYM dostepnym sygnalem byl kontekst. Przy
// poprzednich wagach (CONTEXT max +20, ALIAS +15, TYPE +6, UNIQ +4 = 45 pkt
// maks. bez zadnego dopasowania wartosci) nawet oczywiste dla czlowieka
// przypadki ("Falownik: XXX" obok kolumny "falownik") nigdy nie osiagaly
// REVIEW_THRESHOLD (75) - caly wzor ladowal w "nierozwiazane". Podniesione
// tak, zeby SILNY kontekst+alias+typ+unikalnosc (bez zadnego dopasowania
// wartosci) osiagal max ~80 pkt - powyzej progu review, ale wciaz PONIZEJ
// auto (95), bo sam kontekst - bez potwierdzenia wartoscia - nigdy nie
// powinien wystarczyc do automatycznego zastosowania.
function scoreCandidateColumn(candidate, column, { sampleRowRecord, mappingPrior } = {}) {
  const candNorm = normalizeValue(candidate.text);
  const trivial = isTrivialValue(candNorm);
  let score = 0;
  const reasons = [];

  if (sampleRowRecord && candNorm && normalizeValue(sampleRowRecord[column.name]) === candNorm) {
    score += 65;
    reasons.push({ code: 'SAMPLE_ROW_EXACT', weight: 65, message: `Wartość zgodna z wykrytym wierszem wzorcowym w kolumnie "${column.name}".` });
  } else {
    const hits = column.valueIndex.get(candNorm) || [];
    if (hits.length > 0) {
      score += 30;
      reasons.push({ code: 'EXACT_MATCH_ANYWHERE', weight: 30, message: `Wartość znaleziona w ${hits.length} wierszu/wierszach kolumny "${column.name}".` });
    }
  }

  const ctxTokens = collectContextTokens(candidate);
  // Pokrycie tokenow KOLUMNY w kontekscie (nie Jaccard) - dlugie, techniczne
  // zdania w realnych wzorach maja dziesiatki niezwiazanych slow, ktore w
  // Jaccardzie (dzielonym przez sume obu zbiorow) topily sygnal na zero.
  // Patrz komentarz przy columnTokenCoverage w textNormalize.js.
  const sim = columnTokenCoverage(ctxTokens, column.normalizedTokens);
  if (sim > 0) {
    const w = Math.round(sim * 42);
    score += w;
    reasons.push({ code: 'CONTEXT_HEADER_SIMILARITY', weight: w, message: `Podobieństwo kontekstu do nazwy kolumny: ${Math.round(sim * 100)}%.` });
  }

  const candConcepts = domainAliases.findConceptsForText(ctxTokens.join(' '));
  const colConcepts = domainAliases.findConceptsForText(column.normalizedTokens.join(' '));
  const sharedConcept = candConcepts.find((c) => colConcepts.includes(c));
  if (sharedConcept) {
    score += 24;
    reasons.push({ code: 'DOMAIN_ALIAS_MATCH', weight: 24, message: `Kontekst i nazwa kolumny pasują do pojęcia "${sharedConcept}".` });
  }

  if (mappingPrior && mappingPrior.columnName === column.name) {
    const total = mappingPrior.accepted + mappingPrior.rejected;
    const w = Math.round((15 * (mappingPrior.accepted + 1)) / (total + 2));
    if (w > 0) {
      score += w;
      reasons.push({ code: 'MEMORY_PRIOR', weight: w, message: `Wcześniej zaakceptowano to mapowanie ${mappingPrior.accepted}/${total} razy.` });
    }
  }

  const candType = guessValueType(candNorm);
  if (candType && candType === column.dominantType) {
    score += 8;
    reasons.push({ code: 'TYPE_MATCH', weight: 8, message: 'Typ wartości zgodny z kolumną.' });
  } else if ((candType === 'numeric' && column.dominantType === 'free-text') || (candType === 'free-text' && column.dominantType === 'numeric')) {
    score -= 10;
    reasons.push({ code: 'TYPE_MISMATCH', weight: -10, message: 'Typ wartości NIE pasuje do kolumny.' });
  }

  if (trivial) {
    score -= 15;
    reasons.push({ code: 'TRIVIAL_VALUE', weight: -15, message: 'Wartość zbyt ogólna do wiarygodnego dopasowania.' });
  } else if (column.uniquenessRatio > 0.8) {
    score += 6;
    reasons.push({ code: 'HIGH_UNIQUENESS', weight: 6, message: 'Kolumna ma wysoką unikalność wartości.' });
  }

  return { column: column.name, score: clamp(score, 0, 100), reasons };
}

function scoreCandidate(candidate, columns, ctx = {}) {
  const perColumn = columns.map((col) => scoreCandidateColumn(candidate, col, ctx)).sort((a, b) => b.score - a.score);
  const [top1, top2] = perColumn;
  if (!top1) return { bestColumn: null, score: 0, margin: 0, reasons: [], alternatives: [] };

  const colliders = perColumn.filter((p) => p !== top1 && p.score > 0 && top1.score - p.score <= COLLISION_BAND);
  let score = top1.score;
  const reasons = [...top1.reasons];
  if (colliders.length) {
    const penalty = Math.min(20, colliders.length * 6);
    score -= penalty;
    reasons.push({ code: 'MULTI_COLUMN_COLLISION', weight: -penalty, message: `Pasuje niemal równie dobrze do ${colliders.length} innej/innych kolumn.` });
  }

  return {
    bestColumn: top1.column,
    score: clamp(score, 0, 100),
    margin: top1.score - (top2 ? top2.score : 0),
    reasons,
    alternatives: perColumn.slice(0, 3),
  };
}

function classifyTier(scored) {
  const confidence = scored.score / 100;
  if (confidence >= AUTO_APPLY_THRESHOLD && scored.margin >= MIN_MARGIN_FOR_AUTO) return 'auto';
  if (confidence >= REVIEW_THRESHOLD) return 'review';
  return 'unresolved';
}

// --- klasyfikator "DO PROJEKTANTA" (konserwatywny) ---------------------------

// Slowa "mocne" - same, w dlugim bloku, wystarczaja do auto; slowa "zwykle"
// zawsze ladują co najwyzej w review. Formy juz bez polskich diakrytykow
// (porownywane z normalizeValue, ktore je usuwa).
const MANUAL_STRONG_KEYWORDS = ['obliczenia', 'obliczenie', 'spadek napiecia', 'prad zwarciowy', 'pv*sol', 'pvsol'];
const MANUAL_KEYWORDS = ['dobor przewodu', 'dobor kabla', 'obciazenie', 'snieg', 'wiatr', 'nosnosc', 'konstrukcja', 'zabezpieczenie', 'symulacja', 'schemat', 'analiza statyczna'];
const MANUAL_MIN_BLOCK_LENGTH = 40;
const MANUAL_STRONG_MIN_LENGTH = 80;

function classifyManualCandidate(candidate, scoredColumns) {
  const bestScore = scoredColumns && scoredColumns.length ? scoredColumns[0].score : 0;
  // Wyraznie dopasowane do kolumny Excela - to dane, nie tresc do projektanta,
  // niezaleznie od tego, jakie slowo akurat pada w kontekscie.
  if (bestScore >= REVIEW_THRESHOLD * 100) return { tier: 'none' };

  const blockText = candidate.paragraphText || candidate.text || '';
  const contextText = normalizeValue(`${blockText} ${candidate.before || ''} ${candidate.after || ''}`);
  const hasStrong = MANUAL_STRONG_KEYWORDS.some((k) => contextText.includes(k));
  const hasWeak = MANUAL_KEYWORDS.some((k) => contextText.includes(k));
  if (!hasStrong && !hasWeak) return { tier: 'none' };

  // Krotki fragment dzielacy TYLKO slowo-klucz (np. samo "konstrukcja" w
  // niezwiazanym zdaniu) nie ma stac sie automatycznie "Do projektanta".
  if (blockText.trim().length < MANUAL_MIN_BLOCK_LENGTH) return { tier: 'none' };

  const reasons = [{ code: 'MANUAL_KEYWORD_CONTEXT', weight: 0, message: 'Kontekst zawiera język typowy dla obliczeń/opisu technicznego.' }];
  if (hasStrong && blockText.trim().length >= MANUAL_STRONG_MIN_LENGTH) {
    return { tier: 'auto', reasons };
  }
  return { tier: 'review', reasons };
}

// --- detekcja stalych (konserwatywna, nigdy auto w tej turze) ----------------

function detectConstantCandidate(candidate, scoredColumns, repeatCount = 1) {
  const bestScore = scoredColumns && scoredColumns.length ? scoredColumns[0].score : 0;
  if (bestScore >= REVIEW_THRESHOLD * 100) return { tier: 'none' }; // wyraznie dynamiczne

  const norm = normalizeValue(candidate.text);
  if (!norm || isTrivialValue(norm)) return { tier: 'none' };

  if (repeatCount > 1 && bestScore < 20) {
    return {
      tier: 'review',
      reasons: [{ code: 'CONSTANT_REPEATED_NO_MATCH', weight: 0, message: 'Tekst powtarza się w dokumencie i nie pasuje do żadnej kolumny Excela - może być stałym tekstem.' }],
    };
  }
  return { tier: 'none' };
}

// --- grupowanie powtarzajacych sie pol ----------------------------------------

const VALUE_MATCH_CODES = new Set(['SAMPLE_ROW_EXACT', 'EXACT_MATCH_ANYWHERE']);

function sanitizeForId(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, '') || 'col';
}

// Grupuje TYLKO kandydatow, ktorzy trafili w te sama kolumne PRZEZ
// dopasowanie WARTOSCI (sample-row albo exact-match-anywhere) - nie samym
// kontekstem/aliasem. Bez tego warunku dwa niezwiazane pola, ktore przez
// przypadek scoruja najwyzej na tej samej kolumnie (np. etykieta jednostki
// obok wartosci), zostalyby blednie sklejone w jedno pole.
function groupRepeatedFields(candidateSuggestions) {
  const byColumn = new Map();
  for (const s of candidateSuggestions) {
    if (s.kind !== 'field' || !s.bestColumn) continue;
    const hasValueMatch = (s.reasons || []).some((r) => VALUE_MATCH_CODES.has(r.code));
    if (!hasValueMatch) continue;
    const list = byColumn.get(s.bestColumn) || [];
    list.push(s);
    byColumn.set(s.bestColumn, list);
  }

  const groups = [];
  let seq = 0;
  for (const [column, members] of byColumn.entries()) {
    if (members.length < 2) continue;
    seq++;
    const groupId = `grp_${seq}_${sanitizeForId(column)}`;
    for (const member of members) member.fieldGroupId = groupId;
    groups.push({ groupId, label: column, column, candidateIds: members.map((m) => m.candidateId) });
  }
  return groups;
}

// --- kompozycja: cala analiza --------------------------------------------------

function analyzeAutoConfiguration({ candidates, workbook, sheetName, draft, mappingMemory, options = {} }) {
  const resolvedSheetName = sheetName || (draft && draft.preferredSheet) || workbook.defaultSheet;
  const sheet = workbook.sheets[resolvedSheetName];
  if (!sheet) throw new Error(`Nieznany arkusz: ${resolvedSheetName}`);

  const columns = profileWorkbookColumns(sheet);
  const globalValueIndex = buildValueIndex(sheet);
  const sampleRowResult = detectSampleRow(candidates, globalValueIndex);
  const sampleRowRecord = sampleRowResult.recordNumber != null ? sheet.rows.find((r) => r._record === sampleRowResult.recordNumber) || null : null;

  const textCounts = new Map();
  for (const c of candidates) {
    const key = normalizeValue(c.text);
    textCounts.set(key, (textCounts.get(key) || 0) + 1);
  }

  const candidateSuggestions = candidates.map((candidate) => {
    const mappingPrior = mappingMemory ? mappingMemory.getPrior(mappingMemory.buildContextKey(candidate)) : null;
    const scored = scoreCandidate(candidate, columns, { sampleRowRecord, mappingPrior });

    const manual = classifyManualCandidate(candidate, scored.alternatives);
    if (manual.tier !== 'none') {
      return {
        candidateId: candidate.id, kind: 'manual', tier: manual.tier,
        score: manual.tier === 'auto' ? 96 : 80, margin: 0, bestColumn: null, fieldGroupId: null,
        reasons: (manual.reasons || []).slice(0, 5),
      };
    }

    const constant = detectConstantCandidate(candidate, scored.alternatives, textCounts.get(normalizeValue(candidate.text)) || 1);
    if (constant.tier !== 'none') {
      return {
        candidateId: candidate.id, kind: 'constant', tier: constant.tier,
        score: 80, margin: 0, bestColumn: null, fieldGroupId: null,
        reasons: (constant.reasons || []).slice(0, 5),
      };
    }

    return {
      candidateId: candidate.id, kind: 'field', tier: classifyTier(scored),
      score: scored.score, margin: scored.margin, bestColumn: scored.bestColumn, fieldGroupId: null,
      reasons: (scored.reasons || []).slice(0, 5),
    };
  });

  const fieldGroups = groupRepeatedFields(candidateSuggestions);

  const summary = candidateSuggestions.reduce((acc, s) => {
    acc.total++;
    if (s.tier === 'auto') acc.auto++;
    else if (s.tier === 'review') acc.review++;
    else acc.unresolved++;
    return acc;
  }, { total: 0, auto: 0, review: 0, unresolved: 0 });

  return {
    sheetName: resolvedSheetName,
    sampleRow: sampleRowResult.recordNumber != null
      ? { recordNumber: sampleRowResult.recordNumber, confidence: sampleRowResult.confidence, matchedCandidateCount: sampleRowResult.matchedCandidateCount }
      : null,
    candidateSuggestions,
    fieldGroups,
    variantSuggestions: [],
    summary,
  };
}

module.exports = {
  AUTO_APPLY_THRESHOLD,
  REVIEW_THRESHOLD,
  MIN_MARGIN_FOR_AUTO,
  COLLISION_BAND,
  profileWorkbookColumns,
  buildValueIndex,
  detectSampleRow,
  collectContextTokens,
  scoreCandidateColumn,
  scoreCandidate,
  classifyTier,
  classifyManualCandidate,
  detectConstantCandidate,
  groupRepeatedFields,
  analyzeAutoConfiguration,
};
