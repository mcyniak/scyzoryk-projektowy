// Kreator wzorów seryjnych - logika UI. Bez frameworka/bundlera (wzorzec
// całego repo, patrz CLAUDE.md).
//
// Przebudowa UX 2026-09-28 (przeglad Kreatora): 4 kroki z paskiem postepu,
// paleta wykrywana od razu po wczytaniu plikow (kolory tylko z naglowkow
// tabel odznaczone), lista fragmentow z panelem konfiguracji OBOK (zamiast
// pod lista), "Zapisz i nastepny", edycja istniejacego pola/bloku z
// wczytanymi wartosciami, podglad warunku na zywo, jeden krok "Sprawdz i
// zbuduj" oraz wznowienie pracy po odswiezeniu strony.
const scyzorykMainPanelHost = location.hostname === 'scyzoryk.localhost' ? 'scyzoryk.localhost' : '127.0.0.1';
const scyzorykMainPanelUrl = `http://${scyzorykMainPanelHost}:3000`;
document.querySelectorAll('[data-main-link]').forEach(link => { link.href = scyzorykMainPanelUrl; link.removeAttribute('target'); });

const HEADERS = { 'X-Scyzoryk-Request': '1' };
const LAST_JOB_KEY = 'kreator-wzorow.lastJobId';

const state = {
  jobId: null,
  job: null,
  candidateFilter: 'all',
  openCandidateId: null,
  openType: null,
  openSuggestion: null,
  saveHandler: null,
  columnValuesCache: new Map()
};

function $(sel) { return document.querySelector(sel); }
function escapeHtml(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

// Polska odmiana: 1 wystąpienie, 2-4 wystąpienia, 5+ wystąpień (12-14 -> "wystąpień").
function plural(n, one, few, many) {
  const abs = Math.abs(n);
  if (abs === 1) return one;
  const lastTwo = abs % 100;
  const last = abs % 10;
  if (last >= 2 && last <= 4 && !(lastTwo >= 12 && lastTwo <= 14)) return few;
  return many;
}

function lsGet(key) { try { return localStorage.getItem(key); } catch { return null; } }
function lsSet(key, value) { try { localStorage.setItem(key, value); } catch { /* prywatne okno - wznowienie po prostu nie zadziala */ } }
function lsRemove(key) { try { localStorage.removeItem(key); } catch { /* jw. */ } }

// ---------------------------------------------------------------------------
// Nazwy kolorow (paleta) - "zakreslacz zolty" mowi wiecej niz sam kwadracik.
// ---------------------------------------------------------------------------
const HIGHLIGHT_NAMES = {
  yellow: 'żółty', brightgreen: 'jasnozielony', cyan: 'turkusowy', pink: 'różowy', blue: 'niebieski', red: 'czerwony',
  darkblue: 'granatowy', teal: 'morski', green: 'zielony', violet: 'fioletowy', darkred: 'bordowy', darkyellow: 'oliwkowy',
  gray25: 'jasnoszary', gray50: 'szary', black: 'czarny', white: 'biały'
};
function hexColorName(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
  if (!m) return 'kolor';
  const n = parseInt(m[1], 16);
  const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, d = max - min;
  if (d < 0.08) return l > 0.85 ? 'biały' : l > 0.6 ? 'jasnoszary' : l > 0.3 ? 'szary' : 'czarny';
  let h;
  if (max === r) h = ((g - b) / d) % 6; else if (max === g) h = (b - r) / d + 2; else h = (r - g) / d + 4;
  h = (h * 60 + 360) % 360;
  const light = l > 0.7 ? 'jasno' : '';
  if (h < 15 || h >= 345) return `${light}czerwony`;
  if (h < 40) return `${light}pomarańczowy`;
  if (h < 70) return l > 0.7 ? 'jasnożółty' : 'żółty';
  if (h < 160) return `${light}zielony`;
  if (h < 200) return `${light}turkusowy`;
  if (h < 250) return `${light}niebieski`;
  if (h < 290) return `${light}fioletowy`;
  return `${light}różowy`;
}
function describeMarking(m) {
  const key = String(m.key || '');
  if (m.kind === 'highlight') return `Zakreślacz ${HIGHLIGHT_NAMES[key.split(':')[1]] || ''}`.trim();
  return `Cieniowanie (${hexColorName(m.displayColor)})`;
}

// ---------------------------------------------------------------------------
// Opis kandydata (miejsce w dokumencie + wycinek "w zdaniu")
// ---------------------------------------------------------------------------
const CONTAINER_LABELS = { tableCell: 'komórka tabeli', textbox: 'pole tekstowe', paragraph: 'akapit' };
function describePartUri(partUri) {
  const name = String(partUri || '').split('/').pop() || '';
  if (name.startsWith('document')) return 'dokument główny';
  if (name.startsWith('header')) return 'nagłówek';
  if (name.startsWith('footer')) return 'stopka';
  if (name.startsWith('footnotes')) return 'przypis dolny';
  if (name.startsWith('endnotes')) return 'przypis końcowy';
  if (name.startsWith('comments')) return 'komentarz';
  return name || 'dokument';
}
function describeCandidateLocation(c) {
  const container = CONTAINER_LABELS[c.containerKind] || 'akapit';
  return `${describePartUri(c.partUri)} · ${container}`;
}
function truncateEdge(text, maxLen, fromEnd) {
  const t = String(text || '').trim();
  if (!t) return '';
  if (t.length <= maxLen) return t;
  return (fromEnd ? t.slice(-maxLen) : t.slice(0, maxLen)).trim();
}
function contrastTextColor(hexColor) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hexColor || '').trim());
  if (!m) return '#111';
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.55 ? '#111' : '#fff';
}
function markHtml(candidate) {
  return `<mark class="candidate-inline-mark" style="background:${escapeHtml(candidate.displayColor || '#ffe58a')};color:${contrastTextColor(candidate.displayColor)}">${escapeHtml(candidate.text)}</mark>`;
}
// Podglad kandydata "w zdaniu" - realny fragment dokumentu wokol oznaczenia
// (kontekst ucinany na brzegach, zawsze z "…").
function renderCandidateInlinePreview(candidate, { edgeLen = 60 } = {}) {
  const mark = markHtml(candidate);
  if (candidate.containerKind === 'tableCell') {
    const left = truncateEdge(candidate.leftCellText, edgeLen, true);
    const right = truncateEdge(candidate.rightCellText, edgeLen, false);
    if (!left && !right) return mark;
    return `${left ? `…${escapeHtml(left)} | ` : ''}${mark}${right ? ` | ${escapeHtml(right)}…` : ''}`;
  }
  const prefix = truncateEdge(candidate.paragraphPrefix, edgeLen, true);
  const suffix = truncateEdge(candidate.paragraphSuffix, edgeLen, false);
  if (!prefix && !suffix) return mark;
  return `${prefix ? `…${escapeHtml(prefix)} ` : ''}${mark}${suffix ? ` ${escapeHtml(suffix)}…` : ''}`;
}

const OPERATOR_LABELS = { equals: '=', notEquals: '≠', contains: 'zawiera', notContains: 'nie zawiera', empty: 'jest pusta', notEmpty: 'nie jest pusta', lt: '<', lte: '≤', gt: '>', gte: '≥' };
const OPERATOR_NAMES = { equals: 'równa się', notEquals: 'różna od', contains: 'zawiera', notContains: 'nie zawiera', empty: 'jest pusta', notEmpty: 'nie jest pusta', lt: 'mniejsza niż', lte: 'mniejsza lub równa', gt: 'większa niż', gte: 'większa lub równa' };
function describeCondition(cond) {
  if (!cond) return '';
  const op = OPERATOR_LABELS[cond.operator] || cond.operator;
  return ['empty', 'notEmpty'].includes(cond.operator) ? `${cond.column} ${op}` : `${cond.column} ${op} ${cond.value ?? ''}`;
}

function describeSuggestion(s) {
  if (s.kind === 'field' && s.bestColumn) return `Z Excela → „${s.bestColumn}”`;
  if (s.kind === 'block' && s.proposedBlock) return `Warunek: ${describeCondition(s.proposedBlock.condition)}`;
  if (s.kind === 'manual') return 'Do projektanta';
  if (s.kind === 'constant') return 'Stały tekst (bez zmian)';
  return 'Z Excela';
}
// Uzasadnienie podpowiedzi "po ludzku" - najmocniejszy powod z reasons[].
function topReasonMessage(suggestion) {
  const positive = (suggestion.reasons || []).filter(r => r.weight > 0);
  const pool = positive.length ? positive : (suggestion.reasons || []);
  if (!pool.length) return null;
  return pool.reduce((best, r) => (r.weight > best.weight ? r : best)).message;
}

// Krotki opis JUZ PODJETEJ decyzji w wierszu listy (np. "Excel: „Adres”").
function describeDecision(decision) {
  const draft = state.job.draft;
  if (decision.status === 'field') {
    const f = draft.fields[decision.fieldId];
    if (!f) return 'Z Excela';
    const spec = f.valueSpec || {};
    return spec.type === 'lookup' ? `Wariant z kolumny „${spec.column}”` : `Excel: „${spec.column || f.label}”`;
  }
  if (decision.status === 'block') {
    const b = draft.blocks[decision.blockId];
    return b ? `Tylko gdy ${describeCondition(b.condition)}` : 'Warunek';
  }
  if (decision.status === 'constant') return decision.constantText != null ? `Stały: „${truncateEdge(decision.constantText, 40)}”` : 'Stały tekst (bez zmian)';
  if (decision.status === 'manual') return decision.label ? `Do projektanta: ${decision.label}` : 'Do projektanta';
  if (decision.status === 'photoGallery') return 'Galeria zdjęć';
  return 'Brak decyzji';
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------
async function apiJson(method, url, body) {
  const opts = { method, headers: { ...HEADERS } };
  if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  const res = await fetch(url, opts);
  const json = await res.json().catch(() => null);
  if (!res.ok || !json || json.ok === false) {
    const message = (json && json.message) || `Błąd żądania (${res.status}).`;
    const err = new Error(message);
    err.payload = json;
    err.status = res.status;
    throw err;
  }
  return json;
}
const jobUrl = (suffix = '') => `/api/jobs/${state.jobId}${suffix}`;

// Przykladowe wartosci kolumny (ograniczone po stronie serwera) - cache per
// arkusz+kolumna, bo panel pyta o nie przy kazdym wpisanym znaku.
async function fetchColumnValues(sheetName, columnName) {
  const key = `${sheetName}\u0000${columnName}`;
  if (state.columnValuesCache.has(key)) return state.columnValuesCache.get(key);
  try {
    const res = await apiJson('GET', jobUrl(`/sheets/${encodeURIComponent(sheetName)}/columns/${encodeURIComponent(columnName)}/values`));
    state.columnValuesCache.set(key, res.values || []);
    return res.values || [];
  } catch {
    return [];
  }
}
function renderValueChips(container, values, max = 6) {
  if (!container) return;
  if (!values.length) { container.innerHTML = '<span class="hint">Brak przykładowych wartości w tej kolumnie.</span>'; return; }
  const shown = values.slice(0, max);
  const extra = values.length - shown.length;
  container.innerHTML = `<span class="value-preview-label">W Excelu:</span>` +
    shown.map(v => `<span class="value-chip">${escapeHtml(v)}</span>`).join('') +
    (extra > 0 ? `<span class="value-chip more">+${extra}</span>` : '');
}
// Kolumna jako input+datalist - przy arkuszach z dziesiatkami kolumn zwykly
// select jest trudny do przeszukania.
function columnPickerHtml({ inputId, listId, columns, suggestedColumn }) {
  const ordered = suggestedColumn && columns.includes(suggestedColumn)
    ? [suggestedColumn, ...columns.filter(c => c !== suggestedColumn)]
    : columns;
  return `
    <input type="text" id="${inputId}" class="input" list="${listId}" autocomplete="off" placeholder="Zacznij pisać, aby wyszukać kolumnę…" />
    <datalist id="${listId}">${ordered.map(c => `<option value="${escapeHtml(c)}">${c === suggestedColumn ? ' (podpowiedź)' : ''}</option>`).join('')}</datalist>`;
}

function setStatus(elId, message, ok) {
  const el = $(elId);
  if (!el) return;
  el.textContent = message || '';
  el.className = `step-status${ok === true ? ' ok' : ok === false ? ' err' : ''}`;
}
function showNotice(message) {
  const el = $('#globalNotice');
  el.textContent = message;
  el.classList.remove('hidden');
}
function hideNotice() { $('#globalNotice').classList.add('hidden'); }
function showPanel(step) {
  $(`#step${step}Panel`).classList.remove('hidden');
  // Wejscie do kroku 3/4 zwija ukonczone kroki 1-2 do jednej linii z
  // podsumowaniem (mniej przewijania) - "Zmień" rozwija je z powrotem.
  if (step >= 3) { collapsePanel(1, true); collapsePanel(2, true); }
  updateStepper();
}
function scrollToPanel(step) {
  if (Number(step) <= 2) collapsePanel(step, false);
  $(`#step${step}Panel`).scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function stepSummary(step) {
  const job = state.job;
  if (!job) return '';
  if (step === 1) return `${job.templateName} + ${job.excelName} · arkusz „${currentSheetName()}” · adres: „${$('#addressColumnSelect').value}”`;
  const selected = document.querySelectorAll('.marking-checkbox:checked').length;
  return `${selected} ${plural(selected, 'rodzaj', 'rodzaje', 'rodzajów')} oznaczeń · ${(job.candidates || []).length} ${plural((job.candidates || []).length, 'fragment', 'fragmenty', 'fragmentów')}`;
}
function collapsePanel(step, collapsed) {
  const panel = $(`#step${step}Panel`);
  const header = panel.querySelector('.panel-header');
  let toggle = header.querySelector('.collapse-toggle');
  let summary = header.querySelector('.step-summary');
  if (!toggle) {
    toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'btn btn-ghost btn-sm collapse-toggle';
    toggle.addEventListener('click', () => collapsePanel(step, !panel.classList.contains('is-collapsed')));
    header.appendChild(toggle);
    summary = document.createElement('div');
    summary.className = 'step-summary';
    header.firstElementChild.appendChild(summary);
  }
  panel.classList.toggle('is-collapsed', collapsed);
  toggle.classList.toggle('hidden', !state.job || !state.job.candidates);
  toggle.textContent = collapsed ? 'Zmień' : 'Zwiń';
  summary.textContent = collapsed ? stepSummary(step) : '';
  const desc = header.querySelector('.panel-desc');
  if (desc) desc.classList.toggle('hidden', collapsed);
}

// ---------------------------------------------------------------------------
// Pasek krokow
// ---------------------------------------------------------------------------
function currentProgress() {
  const job = state.job;
  if (!job) return { done: 0, unresolved: 0 };
  const candidates = job.candidates || [];
  const unresolved = candidates.filter(c => !job.draft.candidates[c.id] || job.draft.candidates[c.id].status === 'unresolved').length;
  let done = 1;
  if (job.candidates) done = 2;
  if (job.candidates && candidates.length && unresolved === 0) done = 3;
  if (done === 3 && job.lastBuild) done = 4;
  return { done, unresolved };
}
function updateStepper() {
  const stepper = $('#stepper');
  if (!state.job) { stepper.classList.add('hidden'); $('#heroSection').classList.remove('hidden'); return; }
  stepper.classList.remove('hidden');
  $('#heroSection').classList.add('hidden');
  const { done } = currentProgress();
  document.querySelectorAll('#stepper .step').forEach(el => {
    const step = Number(el.dataset.step);
    const visible = !$(`#step${step}Panel`).classList.contains('hidden');
    el.classList.toggle('is-done', step <= done);
    el.classList.toggle('is-active', step === done + 1 && visible);
    el.classList.toggle('is-locked', !visible);
    if (step === 4 && !visible && done >= 3) { el.classList.add('is-active'); el.classList.remove('is-locked'); }
  });
}
$('#stepper').addEventListener('click', (e) => {
  const step = e.target.closest('.step');
  if (!step) return;
  // Krok 4 jest "zamkniety" tylko dopoki nie wejdzie sie do niego pierwszy raz -
  // klik na pasku dziala tak samo jak przycisk "Dalej", gdy krok 3 jest pokazany.
  if (step.dataset.step === '4' && $('#step4Panel').classList.contains('hidden') && !$('#step3Panel').classList.contains('hidden')) {
    enterStep4().catch(err => showNotice(err.message));
    return;
  }
  if (step.classList.contains('is-locked')) return;
  scrollToPanel(step.dataset.step);
});

// ---------------------------------------------------------------------------
// Stan zadania
// ---------------------------------------------------------------------------
async function loadJob() {
  const res = await apiJson('GET', jobUrl());
  state.job = res.job;
  updateStepper();
  return res.job;
}
// Cialo PUT /config na podstawie AKTUALNEGO job.draft + nadpisan.
function buildConfigPutBody(overrides = {}) {
  const draft = state.job.draft;
  return {
    templateName: draft.templateName,
    preferredSheet: draft.preferredSheet,
    addressColumn: draft.addressColumn,
    candidates: draft.candidates,
    fields: draft.fields,
    blocks: draft.blocks,
    variantGroups: draft.variantGroups,
    ...overrides
  };
}
function currentSheetName() { return $('#sheetSelect').value; }
function currentSheetColumns() { return Array.from($('#addressColumnSelect').options).map(o => o.value); }

// ---------------------------------------------------------------------------
// KROK 1 - pliki
// ---------------------------------------------------------------------------
$('#uploadForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  hideNotice();
  const templateFile = $('#templateFile').files[0];
  const excelFile = $('#excelFile').files[0];
  if (!templateFile || !excelFile) { setStatus('#uploadStatus', 'Wybierz oba pliki.', false); return; }

  const form = new FormData();
  form.append('template', templateFile);
  form.append('excel', excelFile);
  setStatus('#uploadStatus', 'Wczytuję pliki...', null);
  $('#uploadBtn').disabled = true;
  try {
    const res = await fetch('/api/jobs', { method: 'POST', headers: HEADERS, body: form });
    const json = await res.json();
    if (!res.ok || !json.ok) throw new Error(json.message || 'Nie udało się wczytać plików.');
    resetWorkspace();
    $('#resumeBanner').classList.add('hidden');
    state.jobId = json.jobId;
    lsSet(LAST_JOB_KEY, json.jobId);
    setStatus('#uploadStatus', `Wczytano: ${json.templateName} + ${json.excelName}.`, true);
    await loadJob();
    populateSheetSelect(json.workbook.sheetNames, json.workbook.defaultSheet);
    await onSheetChange({ save: false });
    $('#afterUpload').classList.remove('hidden');
    // Paleta od razu - bez osobnego klikania "Wykryj oznaczenia".
    await detectMarkings();
  } catch (err) {
    setStatus('#uploadStatus', err.message, false);
  } finally {
    $('#uploadBtn').disabled = false;
  }
});

// Nowe pliki = nowy wzor: chowamy wszystko, co dotyczylo poprzedniego.
function resetWorkspace() {
  state.job = null;
  state.candidateFilter = 'all';
  state.columnValuesCache.clear();
  closeCandidateConfig();
  for (const step of [2, 3, 4]) $(`#step${step}Panel`).classList.add('hidden');
  for (const step of [1, 2]) $(`#step${step}Panel`).classList.remove('is-collapsed');
  document.querySelectorAll('.collapse-toggle, .step-summary').forEach(el => el.remove());
  document.querySelectorAll('[data-step-panel] .panel-desc').forEach(el => el.classList.remove('hidden'));
  ['#markingsList', '#validationResult', '#previewResult', '#buildResult', '#candidateList'].forEach(sel => { $(sel).innerHTML = ''; });
  $('#templateNameInput').value = '';
  setStatus('#scanStatus', '', null);
  setStatus('#markingsStatus', '', null);
  $('#autoConfigPanel').classList.add('hidden');
}

function populateSheetSelect(sheetNames, selected) {
  $('#sheetSelect').innerHTML = sheetNames.map(name => `<option value="${escapeHtml(name)}"${name === selected ? ' selected' : ''}>${escapeHtml(name)}</option>`).join('');
}

async function onSheetChange({ save = true, preferredAddress = null } = {}) {
  const sheetName = currentSheetName();
  const res = await apiJson('GET', jobUrl(`/sheets/${encodeURIComponent(sheetName)}/rows?limit=1`));
  const addrSel = $('#addressColumnSelect');
  addrSel.innerHTML = res.columns.map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');
  const guess = (preferredAddress && res.columns.includes(preferredAddress) ? preferredAddress : null)
    || res.columns.find(c => /adres/i.test(c)) || res.columns[0];
  if (guess) addrSel.value = guess;
  const rowCount = Number(res.total ?? res.totalRows ?? 0);
  $('#sheetInfo').textContent = `Arkusz „${sheetName}”: ${rowCount} ${plural(rowCount, 'wiersz', 'wiersze', 'wierszy')} danych, ${res.columns.length} ${plural(res.columns.length, 'kolumna', 'kolumny', 'kolumn')}.`;
  // Zmiana arkusza PO skanie: zapisz w drafcie i przelicz podpowiedzi (wczesniej
  // zmiana w UI nie trafiala do konfiguracji).
  if (save && state.job && state.job.candidates) {
    state.columnValuesCache.clear();
    await apiJson('PUT', jobUrl('/config'), buildConfigPutBody({ preferredSheet: sheetName, addressColumn: addrSel.value }));
    await loadJob();
    await runAutoConfigureAnalyze();
  }
}
$('#sheetSelect').addEventListener('change', () => onSheetChange().catch(err => showNotice(err.message)));
$('#addressColumnSelect').addEventListener('change', async () => {
  if (!state.job || !state.job.candidates) return;
  try {
    await apiJson('PUT', jobUrl('/config'), buildConfigPutBody({ addressColumn: $('#addressColumnSelect').value }));
    await loadJob();
  } catch (err) { showNotice(err.message); }
});

// ---------------------------------------------------------------------------
// KROK 2 - paleta oznaczen
// ---------------------------------------------------------------------------
async function detectMarkings() {
  showPanel(2);
  setStatus('#markingsStatus', 'Wykrywam oznaczenia we wzorze...', null);
  $('#detectMarkingsBtn').disabled = true;
  try {
    const res = await apiJson('POST', jobUrl('/scan-markings'), {});
    const markings = res.markings || [];
    renderMarkingsPalette(markings, null);
    setStatus('#markingsStatus', markings.length
      ? `Znaleziono ${markings.length} ${plural(markings.length, 'rodzaj', 'rodzaje', 'rodzajów')} oznaczeń.`
      : 'We wzorze nie ma zakreśleń ani cieniowania. Zaznacz kolorem miejsca do wypełnienia w Wordzie i wczytaj plik ponownie.', markings.length > 0);
    $('#scanBtn').disabled = !markings.length;
    await loadJob();
    scrollToPanel(2);
  } catch (err) {
    setStatus('#markingsStatus', err.message, false);
  } finally {
    $('#detectMarkingsBtn').disabled = false;
  }
}
$('#detectMarkingsBtn').addEventListener('click', () => detectMarkings());

// Domyslnie zaznaczone wszystko poza kolorami wystepujacymi WYLACZNIE w
// naglowkach tabel (m.suggested === false, patrz PaletteScanner.cs).
function renderMarkingsPalette(markings, selectedKeys) {
  const selected = selectedKeys ? new Set(selectedKeys) : null;
  $('#markingsList').innerHTML = markings.map(m => {
    const checked = selected ? selected.has(m.key) : m.suggested !== false;
    const examples = (m.examples || []).map(e => `<span class="marking-example">${escapeHtml(e.text)}</span>`).join('');
    const headerNote = m.suggested === false ? '<span class="badge badge-neutral">tylko nagłówki tabel</span>' : '';
    return `<label class="marking-row${checked ? ' is-checked' : ''}">
      <input type="checkbox" class="marking-checkbox" value="${escapeHtml(m.key)}" ${checked ? 'checked' : ''} />
      <span class="marking-swatch" style="background:${escapeHtml(m.displayColor)}"></span>
      <span class="marking-meta">
        <span class="marking-title">${escapeHtml(describeMarking(m))} <span class="marking-count">· ${m.count} ${plural(m.count, 'wystąpienie', 'wystąpienia', 'wystąpień')}</span> ${headerNote}</span>
        <span class="marking-examples">${examples || '—'}</span>
      </span>
    </label>`;
  }).join('');
}
$('#markingsList').addEventListener('change', (e) => {
  const row = e.target.closest('.marking-row');
  if (row) row.classList.toggle('is-checked', e.target.checked);
});

$('#scanBtn').addEventListener('click', async () => {
  const selected = Array.from(document.querySelectorAll('.marking-checkbox:checked')).map(el => el.value);
  if (!selected.length) { setStatus('#scanStatus', 'Zaznacz przynajmniej jedno oznaczenie.', false); return; }
  setStatus('#scanStatus', 'Szukam zaznaczonych fragmentów...', null);
  $('#scanBtn').disabled = true;
  try {
    const sheetName = currentSheetName();
    const res = await apiJson('POST', jobUrl('/scan'), { sheetName, selectedMarkings: selected });
    setStatus('#scanStatus', `Znaleziono ${res.candidates.length} ${plural(res.candidates.length, 'fragment', 'fragmenty', 'fragmentów')} do skonfigurowania.`, true);
    await loadJob();
    await apiJson('PUT', jobUrl('/config'), buildConfigPutBody({ addressColumn: $('#addressColumnSelect').value, preferredSheet: sheetName }));
    await loadJob();
    state.candidateFilter = 'all';
    closeCandidateConfig();
    showPanel(3);
    renderCandidates();
    scrollToPanel(3);
    await runAutoConfigureAnalyze();
  } catch (err) {
    setStatus('#scanStatus', err.message, false);
  } finally {
    $('#scanBtn').disabled = false;
  }
});

// ---------------------------------------------------------------------------
// KROK 3 - podpowiedzi (auto-konfiguracja, lokalny silnik bez AI)
// ---------------------------------------------------------------------------
async function runAutoConfigureAnalyze() {
  try {
    await apiJson('POST', jobUrl('/auto-configure/analyze'), { sheetName: state.job.draft.preferredSheet });
    await loadJob();
    renderAutoConfigSummary();
    renderCandidates();
  } catch (err) {
    setStatus('#autoConfigStatus', `Automatyczna analiza nie powiodła się: ${err.message}`, false);
  }
}

function suggestionsMap() {
  return new Map(((state.job.autoConfig && state.job.autoConfig.candidateSuggestions) || []).map(s => [s.candidateId, s]));
}

function renderAutoConfigSummary() {
  const ac = state.job && state.job.autoConfig;
  $('#autoConfigPanel').classList.toggle('hidden', !ac);
  if (!ac) return;
  const s = ac.summary;
  const parts = [];
  if (s.auto) parts.push(`<strong>${s.auto}</strong> ${plural(s.auto, 'pewna podpowiedź', 'pewne podpowiedzi', 'pewnych podpowiedzi')}`);
  if (s.review) parts.push(`<strong>${s.review}</strong> do przejrzenia`);
  if (s.unresolved) parts.push(`<strong>${s.unresolved}</strong> bez podpowiedzi`);
  // Liczby z serwera (nie tekst uzytkownika) - innerHTML z <strong> bezpieczny.
  $('#autoConfigSummary').innerHTML = parts.length ? `Dla fragmentów bez decyzji: ${parts.join(', ')}.` : 'Wszystkie fragmenty mają już decyzję.';
  $('#sampleRowInfo').textContent = ac.sampleRow
    ? `Wzór wygląda na wypełniony danymi z wiersza ${ac.sampleRow.recordNumber} Excela (pewność ${Math.round(ac.sampleRow.confidence * 100)}%).`
    : '';
  $('#applyHighConfidenceBtn').textContent = `Zastosuj ${s.auto} ${plural(s.auto, 'pewną', 'pewne', 'pewnych')}`;
  // Bez pewnych podpowiedzi przycisk "Zastosuj" nic by nie zrobil - chowamy go
  // zamiast pokazywac wylaczony; bez fragmentow do analizy chowamy tez "Przeanalizuj".
  $('#applyHighConfidenceBtn').classList.toggle('hidden', s.auto === 0);
  $('#reanalyzeBtn').classList.toggle('hidden', !s.analyzed);
  const hasAutoOrigin = state.job.candidateDecisionMeta && Object.values(state.job.candidateDecisionMeta).some(m => m.origin === 'auto');
  $('#undoAutoConfigBtn').classList.toggle('hidden', !hasAutoOrigin);
}

$('#reanalyzeBtn').addEventListener('click', () => runAutoConfigureAnalyze());
$('#applyHighConfidenceBtn').addEventListener('click', async () => {
  setStatus('#autoConfigStatus', 'Stosuję pewne podpowiedzi...', null);
  try {
    const res = await apiJson('POST', jobUrl('/auto-configure/apply'), {
      applyHighConfidence: true,
      analysisId: state.job.autoConfig && state.job.autoConfig.analysisId
    });
    setStatus('#autoConfigStatus', `Zastosowano ${res.appliedCount} ${plural(res.appliedCount, 'podpowiedź', 'podpowiedzi', 'podpowiedzi')}.`, true);
    await loadJob();
    await runAutoConfigureAnalyze();
    // Od razu tam, gdzie jest jeszcze co zrobic.
    const s = state.job.autoConfig && state.job.autoConfig.summary;
    state.candidateFilter = s && s.review > 0 ? 'review' : 'unresolved';
    renderCandidates();
  } catch (err) {
    setStatus('#autoConfigStatus', err.message, false);
  }
});
$('#undoAutoConfigBtn').addEventListener('click', async () => {
  if (!confirm('Cofnąć wszystkie automatyczne przypisania (ręczne decyzje zostają)?')) return;
  try {
    const res = await apiJson('POST', jobUrl('/auto-configure/undo'), {});
    setStatus('#autoConfigStatus', `Cofnięto ${res.undoneCount} automatycznych przypisań.`, true);
    await loadJob();
    renderAutoConfigSummary();
    renderCandidates();
  } catch (err) {
    setStatus('#autoConfigStatus', err.message, false);
  }
});

async function acceptSuggestion(candidateId) {
  try {
    const res = await apiJson('POST', jobUrl('/auto-configure/apply'), {
      suggestionIds: [candidateId],
      analysisId: state.job.autoConfig && state.job.autoConfig.analysisId
    });
    if (!res.appliedCount) throw new Error('Nie udało się zastosować tej podpowiedzi - ustaw fragment ręcznie w panelu obok.');
    await loadJob();
    renderAutoConfigSummary();
    renderCandidates();
    if (state.openCandidateId === candidateId) openNextUnresolved(candidateId);
  } catch (err) {
    if (err.status === 409) await runAutoConfigureAnalyze();
    setStatus('#autoConfigStatus', err.message, false);
  }
}
async function rejectSuggestion(candidateId) {
  try {
    await apiJson('POST', jobUrl('/auto-configure/reject'), {
      suggestionIds: [candidateId],
      analysisId: state.job.autoConfig && state.job.autoConfig.analysisId
    });
    await loadJob();
    renderAutoConfigSummary();
    renderCandidates();
  } catch (err) {
    setStatus('#autoConfigStatus', err.message, false);
  }
}

// ---------------------------------------------------------------------------
// KROK 3 - lista fragmentow
// ---------------------------------------------------------------------------
const FILTERS = [
  { key: 'all', label: 'Wszystkie' },
  { key: 'unresolved', label: 'Bez decyzji' },
  { key: 'auto', label: 'Pewne podpowiedzi' },
  { key: 'review', label: 'Do przejrzenia' },
  { key: 'field', label: 'Excel' },
  { key: 'constant', label: 'Stałe' },
  { key: 'block', label: 'Warunek' },
  { key: 'manual', label: 'Do projektanta' },
  { key: 'photoGallery', label: 'Zdjęcia' }
];
const BADGE_TEXT = { constant: 'Stały', field: 'Excel', block: 'Warunek', manual: 'Projektant', photoGallery: 'Zdjęcia', unresolved: 'Bez decyzji' };

function decisionOf(candidateId) {
  return state.job.draft.candidates[candidateId] || { status: 'unresolved' };
}
function candidateMatchesFilter(c, filter, suggestions) {
  const status = decisionOf(c.id).status;
  if (filter === 'all') return true;
  if (filter === 'auto' || filter === 'review') {
    if (status !== 'unresolved') return false;
    const s = suggestions.get(c.id);
    return Boolean(s && s.tier === filter);
  }
  return status === filter;
}

function renderCandidates() {
  const job = state.job;
  if (!job || !job.candidates) return;
  const suggestions = suggestionsMap();
  const counts = Object.fromEntries(FILTERS.map(f => [f.key, 0]));
  for (const c of job.candidates) for (const f of FILTERS) if (candidateMatchesFilter(c, f.key, suggestions)) counts[f.key]++;

  const total = job.candidates.length;
  const configured = total - counts.unresolved;
  const percent = total ? Math.round((configured / total) * 100) : 0;
  $('#configProgressLabel').textContent = total
    ? `Skonfigurowano ${configured} z ${total} ${plural(total, 'fragmentu', 'fragmentów', 'fragmentów')}${counts.unresolved ? ` · zostało ${counts.unresolved}` : ' · wszystko gotowe'}`
    : 'Brak fragmentów do skonfigurowania.';
  $('#configProgressPercent').textContent = `${percent}%`;
  $('#configProgressBar').style.width = `${percent}%`;

  // Pusty filtr (np. po "Zastosuj pewne") nie zostaje wybrany - przeskok tam, gdzie jest praca.
  if (counts[state.candidateFilter] === 0 && state.candidateFilter !== 'all') state.candidateFilter = counts.unresolved ? 'unresolved' : 'all';
  $('#candidateFilters').innerHTML = FILTERS.filter(f => f.key === 'all' || counts[f.key] > 0).map(f =>
    `<button type="button" data-filter="${f.key}" class="${state.candidateFilter === f.key ? 'active' : ''}">${f.label} <span>${counts[f.key]}</span></button>`
  ).join('');

  const filtered = job.candidates.filter(c => candidateMatchesFilter(c, state.candidateFilter, suggestions));
  $('#candidateList').innerHTML = filtered.map(c => {
    const decision = decisionOf(c.id);
    const suggestion = decision.status === 'unresolved' ? suggestions.get(c.id) : null;
    const hasSuggestion = suggestion && suggestion.tier !== 'unresolved';
    const reason = hasSuggestion ? topReasonMessage(suggestion) : null;
    const suggestionHtml = hasSuggestion
      ? `<div class="candidate-suggestion">
          <span class="badge ${suggestion.tier === 'auto' ? 'badge-success' : 'badge-warning'}">${suggestion.tier === 'auto' ? 'Pewne' : 'Podpowiedź'}: ${escapeHtml(describeSuggestion(suggestion))}</span>
          ${reason ? `<div class="suggestion-reason">${escapeHtml(reason)}</div>` : ''}
          <div class="candidate-suggestion-actions">
            <button type="button" class="btn btn-primary btn-sm" data-suggestion-action="accept" data-candidate-id="${escapeHtml(c.id)}">Akceptuj</button>
            <button type="button" class="btn btn-ghost btn-sm" data-suggestion-action="reject" data-candidate-id="${escapeHtml(c.id)}">Odrzuć</button>
          </div>
        </div>`
      : '';
    const decisionHtml = decision.status !== 'unresolved' ? `<div class="candidate-decision">${escapeHtml(describeDecision(decision))}</div>` : '';
    const selected = state.openCandidateId === c.id;
    return `<div class="candidate-row${selected ? ' is-selected' : ''}" data-candidate-id="${escapeHtml(c.id)}" role="option" tabindex="0" aria-selected="${selected}">
      <span class="candidate-body">
        <div class="candidate-text">${renderCandidateInlinePreview(c, { edgeLen: 36 })}</div>
        <div class="candidate-context">${escapeHtml(describeCandidateLocation(c))}</div>
        ${decisionHtml}
        ${suggestionHtml}
      </span>
      <span class="candidate-badge ${decision.status}">${BADGE_TEXT[decision.status] || 'Bez decyzji'}</span>
    </div>`;
  }).join('') || '<p class="hint">Brak fragmentów dla tego filtra.</p>';
  updateStepper();
}

// Jeden delegowany listener zamiast podpinania przy kazdym renderze.
$('#candidateFilters').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-filter]');
  if (!btn) return;
  state.candidateFilter = btn.dataset.filter;
  renderCandidates();
});
$('#candidateList').addEventListener('click', (e) => {
  const actionBtn = e.target.closest('[data-suggestion-action]');
  if (actionBtn) {
    e.stopPropagation();
    const id = actionBtn.dataset.candidateId;
    if (actionBtn.dataset.suggestionAction === 'accept') acceptSuggestion(id);
    else rejectSuggestion(id);
    return;
  }
  const row = e.target.closest('.candidate-row');
  if (row) openCandidateConfig(row.dataset.candidateId);
});
$('#candidateList').addEventListener('keydown', (e) => {
  const row = e.target.closest('.candidate-row');
  if (!row || e.target !== row) return;
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openCandidateConfig(row.dataset.candidateId); }
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const sibling = e.key === 'ArrowDown' ? row.nextElementSibling : row.previousElementSibling;
    if (sibling && sibling.classList.contains('candidate-row')) sibling.focus();
  }
});

// ---------------------------------------------------------------------------
// KROK 3 - panel konfiguracji (obok listy)
// ---------------------------------------------------------------------------
function openCandidateConfig(candidateId) {
  const candidate = state.job.candidates.find(c => c.id === candidateId);
  if (!candidate) return;
  state.openCandidateId = candidateId;
  $('#configEmpty').classList.add('hidden');
  $('#configBody').classList.remove('hidden');
  hideConfigError();
  $('#candidateConfigContext').innerHTML = `<div class="config-context-text">${renderCandidateInlinePreview(candidate, { edgeLen: 90 })}</div><div class="candidate-context">${escapeHtml(describeCandidateLocation(candidate))}</div>`;

  // Typ startowy: istniejaca decyzja > podpowiedz > "Z Excela".
  const decision = decisionOf(candidateId);
  const suggestion = decision.status === 'unresolved' ? suggestionsMap().get(candidateId) : null;
  state.openSuggestion = suggestion && suggestion.tier !== 'unresolved' ? suggestion : null;
  const initialType = decision.status !== 'unresolved' ? decision.status : ((state.openSuggestion && state.openSuggestion.kind) || 'field');
  selectConfigType(initialType);

  document.querySelectorAll('.candidate-row').forEach(r => {
    const selected = r.dataset.candidateId === candidateId;
    r.classList.toggle('is-selected', selected);
    r.setAttribute('aria-selected', String(selected));
  });
  // Waski ekran: panel jest pod lista - przewijamy do niego. Szeroki: lista
  // i panel maja wysokosc okna - wystarczy, zeby cala siatka byla widoczna.
  if (window.matchMedia('(max-width: 1099px)').matches) {
    $('#candidateConfigPanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } else {
    const rect = $('.config-grid').getBoundingClientRect();
    if (rect.top < 120 || rect.top > window.innerHeight * 0.5) $('.config-grid').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

function closeCandidateConfig() {
  state.openCandidateId = null;
  state.openSuggestion = null;
  state.saveHandler = null;
  $('#configBody').classList.add('hidden');
  $('#configEmpty').classList.remove('hidden');
  $('#configEmpty').innerHTML = '<strong>Wybierz fragment z listy</strong><span>Tu ustawisz, skąd ma pochodzić jego wartość w każdym dokumencie.</span>';
  document.querySelectorAll('.candidate-row.is-selected').forEach(r => r.classList.remove('is-selected'));
}
$('#closeConfigBtn').addEventListener('click', closeCandidateConfig);

function selectConfigType(type) {
  state.openType = type;
  document.querySelectorAll('.config-type-btn').forEach(btn => btn.classList.toggle('active', btn.dataset.type === type));
  const candidate = state.job.candidates.find(c => c.id === state.openCandidateId);
  hideConfigError();
  renderConfigTypeBody(type, candidate, decisionOf(state.openCandidateId), state.openSuggestion);
}
$('#configTypeChoices').addEventListener('click', (e) => {
  const btn = e.target.closest('.config-type-btn');
  if (btn) selectConfigType(btn.dataset.type);
});

function showConfigError(message) {
  const el = $('#configError');
  el.textContent = message;
  el.classList.remove('hidden');
}
function hideConfigError() { $('#configError').classList.add('hidden'); }

$('#saveConfigBtn').addEventListener('click', async () => {
  if (!state.saveHandler || !state.openCandidateId) return;
  const candidateId = state.openCandidateId;
  const btn = $('#saveConfigBtn');
  btn.disabled = true;
  hideConfigError();
  try {
    const saved = await state.saveHandler();
    if (saved === false) return;
    await loadJob();
    renderAutoConfigSummary();
    renderCandidates();
    if ($('#autoNextToggle').checked) openNextUnresolved(candidateId);
    else openCandidateConfig(candidateId);
  } catch (err) {
    showConfigError(err.message);
  } finally {
    btn.disabled = false;
  }
});

// Nastepny fragment bez decyzji (w kolejnosci dokumentu, od biezacego w dol,
// potem od poczatku). Brak takich = panel zamkniety + zacheta do kroku 4.
function openNextUnresolved(afterCandidateId) {
  const list = state.job.candidates;
  const start = afterCandidateId ? list.findIndex(c => c.id === afterCandidateId) : -1;
  for (let i = 1; i <= list.length; i++) {
    const c = list[(start + i + list.length) % list.length];
    if (decisionOf(c.id).status === 'unresolved') {
      if (!candidateMatchesFilter(c, state.candidateFilter, suggestionsMap())) {
        state.candidateFilter = 'unresolved';
        renderCandidates();
      }
      openCandidateConfig(c.id);
      const row = document.querySelector(`.candidate-row[data-candidate-id="${CSS.escape(c.id)}"]`);
      if (row) row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      return;
    }
  }
  closeCandidateConfig();
  $('#configEmpty').innerHTML = '<strong>Wszystkie fragmenty mają decyzję</strong><span>Przejdź dalej, żeby sprawdzić i zbudować wzór.</span>';
}

function renderConfigTypeBody(type, candidate, decision, suggestion) {
  const body = $('#configTypeBody');
  if (type === 'constant') {
    const override = decision.status === 'constant' && decision.constantText != null;
    body.innerHTML = `
      <p class="hint">Ten fragment będzie taki sam we wszystkich dokumentach.</p>
      <label class="check u-mt-2"><input type="checkbox" id="constantOverride" ${override ? 'checked' : ''}> Zastąp innym tekstem</label>
      <textarea id="constantText" class="input u-mt-2 ${override ? '' : 'hidden'}" rows="2" placeholder="Nowy tekst">${escapeHtml(override ? decision.constantText : candidate.text)}</textarea>`;
    $('#constantOverride').addEventListener('change', (e) => $('#constantText').classList.toggle('hidden', !e.target.checked));
    state.saveHandler = async () => {
      const text = $('#constantOverride').checked ? $('#constantText').value : null;
      await apiJson('POST', jobUrl(`/candidates/${encodeURIComponent(candidate.id)}/constant`), { text });
    };
  } else if (type === 'manual') {
    body.innerHTML = `
      <p class="hint">Fragment zostanie bez zmian, razem z kolorem oznaczenia — projektant uzupełni go w gotowym dokumencie.</p>
      <label class="label u-mt-2" for="manualLabel">Notatka dla projektanta (opcjonalnie)</label>
      <input type="text" id="manualLabel" class="input" value="${escapeHtml(decision.label || '')}" placeholder="np. Obliczenia spadku napięcia" />`;
    state.saveHandler = async () => {
      await apiJson('POST', jobUrl(`/candidates/${encodeURIComponent(candidate.id)}/manual`), { label: $('#manualLabel').value });
    };
  } else if (type === 'field') {
    renderFieldConfig(candidate, decision, suggestion);
  } else if (type === 'block') {
    renderBlockConfig(candidate, decision, suggestion);
  } else if (type === 'photoGallery') {
    body.innerHTML = `
      <p class="hint">W tym miejscu Dokumenty seryjne wstawią wszystkie zdjęcia z folderu dopasowanego do adresu danego wiersza.</p>
      <p class="hint">Próbka w kroku 4 nie pokaże zdjęć — Kreator nie zna folderu ze zdjęciami.</p>`;
    state.saveHandler = async () => {
      await apiJson('POST', jobUrl(`/candidates/${encodeURIComponent(candidate.id)}/photo-gallery`), {});
    };
  }
}

function countUsage(kind, id) {
  return Object.values(state.job.draft.candidates).filter(d => d && d.status === kind && (kind === 'field' ? d.fieldId : d.blockId) === id).length;
}
function usageLabel(count) {
  return count ? ` · ${count} ${plural(count, 'miejsce', 'miejsca', 'miejsc')}` : '';
}

// "Z Excela": wybor pola (nowe albo istniejace, z liczba miejsc), formularz
// ZAWSZE wypelniony aktualna definicja - edycja zmienia pole wszedzie, gdzie
// jest uzyte (PUT /fields/:id), zamiast tworzyc duplikat.
function renderFieldConfig(candidate, decision, suggestion) {
  const body = $('#configTypeBody');
  const columns = currentSheetColumns();
  const fields = state.job.draft.fields || {};
  const usedFieldEntries = Object.entries(fields).filter(([id]) => countUsage('field', id) > 0 || id === decision.fieldId);
  const suggestedColumn = suggestion && suggestion.kind === 'field' && !decision.fieldId ? suggestion.bestColumn : null;
  const reason = suggestion ? topReasonMessage(suggestion) : null;
  body.innerHTML = `
    ${usedFieldEntries.length ? `<label class="label" for="fieldPick">Pole</label>
      <select id="fieldPick" class="input">
        <option value="">+ Nowe pole</option>
        ${usedFieldEntries.map(([id, f]) => `<option value="${escapeHtml(id)}" ${decision.fieldId === id ? 'selected' : ''}>${escapeHtml(f.label)}${usageLabel(countUsage('field', id))}</option>`).join('')}
      </select>
      <span class="field-help" id="fieldPickHelp"></span>` : ''}
    ${suggestedColumn ? `<div class="suggestion-box u-mt-3">Podpowiedź: kolumna „${escapeHtml(suggestedColumn)}”.${reason ? ` ${escapeHtml(reason)}` : ''}</div>` : ''}
    <label class="label u-mt-3" for="fieldColumn">Kolumna Excela</label>
    ${columnPickerHtml({ inputId: 'fieldColumn', listId: 'fieldColumnList', columns, suggestedColumn })}
    <div id="fieldColumnPreview" class="value-preview"></div>
    <label class="label u-mt-3" for="fieldLabel">Nazwa pola</label>
    <input type="text" id="fieldLabel" class="input" placeholder="np. Adres obiektu" />
    <label class="label u-mt-3" for="fieldType">Wstawiana wartość</label>
    <select id="fieldType" class="input">
      <option value="column">Wartość z kolumny bez zmian</option>
      <option value="lookup">Własny tekst dla każdej wartości (wariant)</option>
    </select>
    <div id="lookupBox" class="hidden u-mt-3">
      <p class="hint">Dla każdej wartości z Excela wpisz tekst, który ma trafić do dokumentu.</p>
      <table class="lookup-table" id="lookupTable"></table>
    </div>
    <label class="check u-mt-3"><input type="checkbox" id="fieldRequired"> Wymagane — pusta komórka zablokuje generowanie</label>`;

  const pick = $('#fieldPick');
  const labelInput = $('#fieldLabel');
  const columnInput = $('#fieldColumn');
  const typeSelect = $('#fieldType');
  let lookupPrefill = {};

  function fillFromField(f) {
    const spec = (f && f.valueSpec) || {};
    labelInput.value = f ? f.label : (suggestedColumn || '');
    columnInput.value = f ? (spec.column || '') : (suggestedColumn || '');
    typeSelect.value = spec.type === 'lookup' ? 'lookup' : 'column';
    $('#fieldRequired').checked = f ? (f.required !== false && f.emptyPolicy !== 'warn') : false;
    lookupPrefill = spec.type === 'lookup' ? (spec.map || {}) : {};
    const help = $('#fieldPickHelp');
    if (help) {
      const usage = f && pick && pick.value ? countUsage('field', pick.value) : 0;
      help.textContent = f
        ? (usage > 1 ? `Zmiana ustawień dotyczy wszystkich ${usage} miejsc tego pola.` : 'Możesz zmienić ustawienia tego pola.')
        : 'Nowe pole — albo wybierz istniejące, jeśli ta sama wartość jest już w innym miejscu.';
    }
  }
  async function refreshColumnPreview() {
    const column = columnInput.value.trim();
    const preview = $('#fieldColumnPreview');
    if (!column || !columns.includes(column)) { preview.innerHTML = ''; return; }
    renderValueChips(preview, await fetchColumnValues(currentSheetName(), column));
    // Nazwa pola domyslnie = nazwa kolumny (mniej pisania), dopoki user jej nie zmienil.
    if (!labelInput.dataset.touched && (!pick || !pick.value)) labelInput.value = column;
  }
  async function refreshLookupTable() {
    const column = columnInput.value.trim();
    const box = $('#lookupBox');
    if (typeSelect.value !== 'lookup' || !column || !columns.includes(column)) { box.classList.add('hidden'); return; }
    box.classList.remove('hidden');
    const values = await fetchColumnValues(currentSheetName(), column);
    $('#lookupTable').innerHTML = values.map(v => `<tr><td>${escapeHtml(v)}</td><td><input type="text" class="input lookup-value" data-key="${escapeHtml(v)}" value="${escapeHtml(lookupPrefill[v] || '')}" placeholder="tekst w dokumencie" /></td></tr>`).join('');
  }

  fillFromField(decision.fieldId ? fields[decision.fieldId] : null);
  labelInput.addEventListener('input', () => { labelInput.dataset.touched = '1'; });
  if (pick) pick.addEventListener('change', () => { delete labelInput.dataset.touched; fillFromField(pick.value ? fields[pick.value] : null); refreshColumnPreview(); refreshLookupTable(); });
  typeSelect.addEventListener('change', refreshLookupTable);
  columnInput.addEventListener('input', () => { refreshColumnPreview(); refreshLookupTable(); });
  refreshColumnPreview();
  refreshLookupTable();

  state.saveHandler = async () => {
    const label = labelInput.value.trim();
    const column = columnInput.value.trim();
    if (!column || !columns.includes(column)) { showConfigError('Wybierz kolumnę z listy podpowiedzi (zacznij pisać, aby ją znaleźć).'); return false; }
    if (!label) { showConfigError('Podaj nazwę pola.'); return false; }
    let valueSpec = { type: 'column', column };
    if (typeSelect.value === 'lookup') {
      const map = {};
      document.querySelectorAll('.lookup-value').forEach(inp => { if (inp.value.trim()) map[inp.dataset.key] = inp.value.trim(); });
      if (!Object.keys(map).length) { showConfigError('Wpisz tekst dla przynajmniej jednej wartości z Excela.'); return false; }
      valueSpec = { type: 'lookup', column, map };
    }
    const required = $('#fieldRequired').checked;
    const def = { label, required, emptyPolicy: required ? 'error' : 'warn', unknownPolicy: required ? 'error' : 'warn', valueSpec };
    const existingId = pick ? pick.value : '';
    if (existingId) {
      const current = fields[existingId];
      const before = JSON.stringify({ l: current.label, r: current.required !== false && current.emptyPolicy !== 'warn', v: current.valueSpec });
      const after = JSON.stringify({ l: label, r: required, v: valueSpec });
      if (before !== after) await apiJson('PUT', jobUrl(`/fields/${encodeURIComponent(existingId)}`), def);
      if (decision.fieldId !== existingId || decision.status !== 'field') {
        await apiJson('POST', jobUrl(`/candidates/${encodeURIComponent(candidate.id)}/assign-field`), { fieldId: existingId });
      }
    } else {
      await apiJson('POST', jobUrl('/fields'), { candidateId: candidate.id, ...def });
    }
  };
}

// "Warunek": wybor istniejacego (dolaczenie fragmentu) albo nowego, formularz
// wypelniony aktualnym warunkiem albo podpowiedzia, podglad "w ilu
// dokumentach sie pojawi" liczony przez serwer tymi samymi regulami co generowanie.
function renderBlockConfig(candidate, decision, suggestion) {
  const body = $('#configTypeBody');
  const columns = currentSheetColumns();
  const blocks = state.job.draft.blocks || {};
  const groups = Object.entries(state.job.draft.variantGroups || {});
  const usedBlocks = Object.entries(blocks).filter(([id]) => countUsage('block', id) > 0 || id === decision.blockId);
  const proposed = suggestion && suggestion.kind === 'block' && suggestion.proposedBlock ? suggestion.proposedBlock : null;
  body.innerHTML = `
    <p class="hint">Fragment pojawi się tylko w dokumentach, dla których warunek jest spełniony — w pozostałych zniknie.</p>
    ${usedBlocks.length ? `<label class="label u-mt-2" for="blockPick">Warunek</label>
      <select id="blockPick" class="input">
        <option value="">+ Nowy warunek</option>
        ${usedBlocks.map(([id, b]) => `<option value="${escapeHtml(id)}" ${decision.blockId === id ? 'selected' : ''}>${escapeHtml(b.label)} (${escapeHtml(describeCondition(b.condition))})${usageLabel(countUsage('block', id))}</option>`).join('')}
      </select>
      <span class="field-help">Wybierz istniejący, żeby ten fragment pokazywał się razem z nim.</span>` : ''}
    ${proposed ? `<div class="suggestion-box u-mt-3">Podpowiedź: ${escapeHtml(describeCondition(proposed.condition))}. ${escapeHtml(topReasonMessage(suggestion) || '')}</div>` : ''}
    <div class="condition-row u-mt-3">
      <div>
        <label class="label" for="condColumn">Kolumna</label>
        ${columnPickerHtml({ inputId: 'condColumn', listId: 'condColumnList', columns, suggestedColumn: null })}
      </div>
      <div>
        <label class="label" for="condOperator">Warunek</label>
        <select id="condOperator" class="input">
          ${Object.keys(OPERATOR_LABELS).map(k => `<option value="${k}">${escapeHtml(OPERATOR_NAMES[k])}</option>`).join('')}
        </select>
      </div>
      <div id="condValueWrap">
        <label class="label" for="condValue">Wartość</label>
        <input type="text" id="condValue" class="input" list="condValueList" autocomplete="off" placeholder="np. 6.5 albo mieszkalny" />
        <datalist id="condValueList"></datalist>
      </div>
    </div>
    <div id="condColumnPreview" class="value-preview"></div>
    <div id="condMatchPreview" class="cond-match"></div>
    <label class="label u-mt-3" for="blockLabel">Nazwa warunku</label>
    <input type="text" id="blockLabel" class="input" placeholder="np. PPOŻ poniżej 6,5 kWp" />
    <details class="u-mt-3" id="variantDetails">
      <summary>Grupa wariantów (dokładnie jeden z kilku fragmentów)</summary>
      <select id="variantGroupSelect" class="input u-mt-2">
        <option value="">— brak —</option>
        ${groups.map(([id, g]) => `<option value="${escapeHtml(id)}">${escapeHtml(g.label)}</option>`).join('')}
        <option value="__new__">+ Nowa grupa</option>
      </select>
      <input type="text" id="newGroupLabel" class="input u-mt-2 hidden" placeholder="Nazwa nowej grupy, np. System montażowy" />
    </details>`;

  const pick = $('#blockPick');
  const labelInput = $('#blockLabel');
  const columnInput = $('#condColumn');
  const operatorSelect = $('#condOperator');
  const valueInput = $('#condValue');
  const groupSelect = $('#variantGroupSelect');

  // Nazwa warunku wygenerowana automatycznie ("Moc kWp < 6.5") nadaza za
  // zmianami warunku; nazwa wpisana recznie zostaje nietknieta.
  function syncAutoLabel() {
    if (labelInput.dataset.auto === '1') labelInput.value = describeCondition(currentCondition());
  }
  function fillFromBlock(b) {
    const cond = (b && b.condition) || (!b && proposed ? proposed.condition : null) || {};
    labelInput.value = b ? b.label : (proposed ? proposed.label : '');
    labelInput.dataset.auto = (!labelInput.value || labelInput.value === describeCondition(cond)) ? '1' : '';
    columnInput.value = cond.column || '';
    operatorSelect.value = cond.operator || 'equals';
    valueInput.value = cond.value ?? '';
    groupSelect.value = b && b.variantGroupId ? b.variantGroupId : '';
    $('#newGroupLabel').classList.add('hidden');
    if (b && b.variantGroupId) $('#variantDetails').open = true;
    toggleValueInput();
  }
  function toggleValueInput() {
    $('#condValueWrap').classList.toggle('hidden', ['empty', 'notEmpty'].includes(operatorSelect.value));
  }
  function currentCondition() {
    const cond = { column: columnInput.value.trim(), operator: operatorSelect.value };
    if (!['empty', 'notEmpty'].includes(cond.operator)) cond.value = valueInput.value;
    return cond;
  }
  async function refreshColumnHints() {
    const column = columnInput.value.trim();
    if (!column || !columns.includes(column)) { $('#condColumnPreview').innerHTML = ''; $('#condValueList').innerHTML = ''; return; }
    const values = await fetchColumnValues(currentSheetName(), column);
    renderValueChips($('#condColumnPreview'), values);
    $('#condValueList').innerHTML = values.map(v => `<option value="${escapeHtml(v)}">`).join('');
  }
  let previewTimer = null;
  function scheduleMatchPreview() {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(refreshMatchPreview, 250);
  }
  async function refreshMatchPreview() {
    const box = $('#condMatchPreview');
    if (!box) return;
    const cond = currentCondition();
    if (!cond.column || !columns.includes(cond.column)) { box.innerHTML = ''; box.className = 'cond-match'; return; }
    try {
      const res = await apiJson('POST', jobUrl('/condition-preview'), { sheetName: currentSheetName(), condition: cond });
      const names = res.matchedSample.map(m => escapeHtml(m.label)).join(', ');
      const edge = res.matchedCount === 0 || res.matchedCount === res.total;
      box.className = `cond-match ${res.invalidCount || edge ? 'is-warning' : 'is-ok'}`;
      box.innerHTML = res.invalidCount
        ? `W ${res.invalidCount} ${plural(res.invalidCount, 'wierszu', 'wierszach', 'wierszach')} warunku nie da się sprawdzić: ${escapeHtml(res.invalidSample[0].error)}`
        : `Fragment pojawi się w <strong>${res.matchedCount} z ${res.total}</strong> dokumentów${names ? `: ${names}${res.matchedCount > res.matchedSample.length ? '…' : ''}` : ''}.`
          + (res.matchedCount === 0 ? ' Sprawdź wartość warunku.' : res.matchedCount === res.total ? ' Pojawi się wszędzie — może wystarczy „Stały tekst”?' : '');
    } catch (err) {
      box.className = 'cond-match is-warning';
      box.textContent = err.message;
    }
  }

  fillFromBlock(decision.blockId ? blocks[decision.blockId] : null);
  if (pick) pick.addEventListener('change', () => { fillFromBlock(pick.value ? blocks[pick.value] : null); refreshColumnHints(); scheduleMatchPreview(); });
  labelInput.addEventListener('input', () => { labelInput.dataset.auto = labelInput.value.trim() ? '' : '1'; });
  operatorSelect.addEventListener('change', () => { toggleValueInput(); syncAutoLabel(); scheduleMatchPreview(); });
  columnInput.addEventListener('input', () => { refreshColumnHints(); syncAutoLabel(); scheduleMatchPreview(); });
  valueInput.addEventListener('input', () => { syncAutoLabel(); scheduleMatchPreview(); });
  groupSelect.addEventListener('change', () => $('#newGroupLabel').classList.toggle('hidden', groupSelect.value !== '__new__'));
  refreshColumnHints();
  refreshMatchPreview();

  state.saveHandler = async () => {
    const cond = currentCondition();
    if (!cond.column || !columns.includes(cond.column)) { showConfigError('Wybierz kolumnę z listy podpowiedzi (zacznij pisać, aby ją znaleźć).'); return false; }
    if (!['empty', 'notEmpty'].includes(cond.operator) && !String(cond.value || '').trim()) { showConfigError('Podaj wartość warunku.'); return false; }
    const label = labelInput.value.trim() || describeCondition(cond);
    let variantGroupId = groupSelect.value;
    if (variantGroupId === '__new__') {
      const groupLabel = $('#newGroupLabel').value.trim();
      if (!groupLabel) { showConfigError('Podaj nazwę nowej grupy wariantów.'); return false; }
      const res = await apiJson('POST', jobUrl('/variant-groups'), { label: groupLabel, policy: 'exactlyOne' });
      variantGroupId = res.groupId;
    }
    const def = { label, condition: cond, variantGroupId: variantGroupId || undefined };
    const existingId = pick ? pick.value : '';
    if (existingId) {
      await apiJson('PUT', jobUrl(`/blocks/${encodeURIComponent(existingId)}`), def);
      if (decision.blockId !== existingId || decision.status !== 'block') {
        await apiJson('POST', jobUrl(`/candidates/${encodeURIComponent(candidate.id)}/assign-block`), { blockId: existingId });
      }
    } else {
      await apiJson('POST', jobUrl('/blocks'), { candidateId: candidate.id, ...def });
    }
  };
}

$('#toStep4Btn').addEventListener('click', () => enterStep4().catch(err => showNotice(err.message)));

// ---------------------------------------------------------------------------
// KROK 4 - sprawdzenie (automatycznie), probka, budowa
// ---------------------------------------------------------------------------
async function enterStep4() {
  showPanel(4);
  if (!$('#templateNameInput').value) $('#templateNameInput').value = state.job.draft.templateName || '';
  scrollToPanel(4);
  await Promise.all([populatePreviewRecordSelect(), runValidation()]);
}

async function runValidation() {
  const box = $('#validationResult');
  box.innerHTML = '<p class="hint">Sprawdzam wzór na wszystkich wierszach Excela...</p>';
  try {
    const res = await apiJson('POST', jobUrl('/validate'), { sheetName: currentSheetName() });
    renderValidation(res.validation);
  } catch (err) {
    box.innerHTML = `<div class="alert alert-danger"><div class="alert-body"><div class="alert-desc">${escapeHtml(err.message)}</div></div></div>`;
  }
}
$('#validateBtn').addEventListener('click', runValidation);

function renderValidation(v) {
  const { unresolved } = currentProgress();
  const parts = [];
  if (unresolved) {
    parts.push(`<div class="alert alert-warning"><div class="alert-body">
      <div class="alert-title">${unresolved} ${plural(unresolved, 'fragment nie ma', 'fragmenty nie mają', 'fragmentów nie ma')} decyzji</div>
      <div class="alert-desc">Przed zbudowaniem wzoru każdy fragment musi mieć źródło. Próbkę możesz wygenerować już teraz — te fragmenty zostaną bez zmian.</div>
      <div class="alert-actions"><button type="button" class="btn btn-secondary btn-sm" id="showUnresolvedBtn">Pokaż je</button></div>
    </div></div>`);
  }
  if (v.errors.length) {
    parts.push(`<div class="alert alert-danger"><div class="alert-body"><div class="alert-title">Błędy konfiguracji (${v.errors.length})</div><ul>${v.errors.map(e => `<li>${escapeHtml(e.message)}</li>`).join('')}</ul></div></div>`);
  }
  if (v.recordErrorsTotal) {
    parts.push(`<div class="alert alert-danger"><div class="alert-body"><div class="alert-title">${v.recordErrorsTotal} ${plural(v.recordErrorsTotal, 'wiersz ma', 'wiersze mają', 'wierszy ma')} błędy danych</div>
      ${v.recordErrorsSample.map(e => `<div class="record-error-row">Wiersz ${e.row}${e.address ? ' (' + escapeHtml(e.address) + ')' : ''}: ${escapeHtml(e.reasons.join('; '))}</div>`).join('')}
    </div></div>`);
  }
  if (v.warnings.length) {
    parts.push(`<div class="alert alert-info"><div class="alert-body"><div class="alert-title">Ostrzeżenia</div><ul>${v.warnings.map(w => `<li>${escapeHtml(w.message)}</li>`).join('')}</ul></div></div>`);
  }
  if (!parts.length) {
    parts.push('<div class="alert alert-success"><div class="alert-body"><div class="alert-title">Wzór jest gotowy do zbudowania</div><div class="alert-desc">Konfiguracja działa dla wszystkich wierszy przykładowego Excela.</div></div></div>');
  }
  $('#validationResult').innerHTML = parts.join('');
  const showBtn = $('#showUnresolvedBtn');
  if (showBtn) showBtn.addEventListener('click', () => { state.candidateFilter = 'unresolved'; renderCandidates(); scrollToPanel(3); openNextUnresolved(null); });
  $('#buildBtn').disabled = Boolean(unresolved || v.errors.length || v.recordErrorsTotal);
}

async function populatePreviewRecordSelect() {
  const res = await apiJson('GET', jobUrl(`/sheets/${encodeURIComponent(currentSheetName())}/rows?limit=200`));
  const addressColumn = state.job.draft.addressColumn;
  const sampleRow = state.job.autoConfig && state.job.autoConfig.sampleRow ? state.job.autoConfig.sampleRow.recordNumber : null;
  // Domyslnie wiersz INNY niz wzorcowy - dopiero na nim widac, czy dane sie podmieniaja.
  const preferred = res.rows.find(r => r._record !== sampleRow) || res.rows[0];
  $('#previewRecordSelect').innerHTML = res.rows.map(r => `<option value="${r._record}"${preferred && r._record === preferred._record ? ' selected' : ''}>Wiersz ${r._record}${r[addressColumn] ? ' – ' + escapeHtml(r[addressColumn]) : ''}${r._record === sampleRow ? ' (wiersz wzorcowy)' : ''}</option>`).join('');
}

$('#previewBtn').addEventListener('click', async () => {
  const box = $('#previewResult');
  box.innerHTML = '<p class="hint">Generuję próbkę...</p>';
  $('#previewBtn').disabled = true;
  try {
    const recordNumber = Number($('#previewRecordSelect').value);
    const res = await apiJson('POST', jobUrl('/preview'), { sheetName: currentSheetName(), recordNumber });
    const p = res.preview;
    const errors = p.errors || [];
    const issues = [...errors, ...(p.warnings || [])];
    const bust = Date.now();
    box.innerHTML = `<div class="alert ${errors.length ? 'alert-warning' : 'alert-success'}"><div class="alert-body">
      <div class="alert-title">${errors.length ? 'Próbka gotowa, ale z problemami' : 'Próbka gotowa'}</div>
      ${issues.length ? `<ul>${issues.map(w => `<li>${escapeHtml(w.message)}</li>`).join('')}</ul>` : ''}
      <div class="alert-actions">
        ${p.hasPdf ? `<a class="btn btn-primary btn-sm" href="${jobUrl('/download/preview/pdf')}?inline=1&t=${bust}" target="_blank" rel="noopener">Otwórz PDF</a>` : ''}
        ${p.hasDocx ? `<a class="btn btn-secondary btn-sm" href="${jobUrl('/download/preview/docx')}?t=${bust}">Pobierz DOCX</a>` : ''}
      </div>
    </div></div>`;
  } catch (err) {
    const details = err.payload && err.payload.errors ? `<ul>${err.payload.errors.map(e => `<li>${escapeHtml(e.message)}</li>`).join('')}</ul>` : '';
    box.innerHTML = `<div class="alert alert-danger"><div class="alert-body"><div class="alert-desc">${escapeHtml(err.message)}</div>${details}</div></div>`;
  } finally {
    $('#previewBtn').disabled = false;
  }
});

$('#buildBtn').addEventListener('click', async () => {
  const box = $('#buildResult');
  box.innerHTML = '<p class="hint">Buduję wzór...</p>';
  $('#buildBtn').disabled = true;
  try {
    const templateName = $('#templateNameInput').value.trim();
    const res = await apiJson('POST', jobUrl('/build'), { sheetName: currentSheetName(), templateName });
    const warnings = (res.warnings || []).length ? `<ul>${res.warnings.map(w => `<li>${escapeHtml(w.message || w)}</li>`).join('')}</ul>` : '';
    const url = jobUrl('/download/template');
    box.innerHTML = `<div class="alert alert-success"><div class="alert-body">
      <div class="alert-title">Gotowe: ${escapeHtml(res.downloadName)}</div>${warnings}
      <div class="alert-desc">Pobieranie ruszy samo. Wgraj plik do „Dokumenty seryjne PDF” razem z Excelem inwestycji.</div>
      <div class="alert-actions"><a class="btn btn-secondary btn-sm" href="${url}">Pobierz ponownie</a></div>
    </div></div>`;
    await loadJob();
    const a = document.createElement('a');
    a.href = url;
    a.download = res.downloadName;
    document.body.appendChild(a);
    a.click();
    a.remove();
  } catch (err) {
    const details = err.payload && err.payload.recordErrorsSample
      ? `<ul>${err.payload.recordErrorsSample.map(e => `<li>Wiersz ${e.row}: ${escapeHtml(e.reasons.join('; '))}</li>`).join('')}</ul>`
      : (err.payload && err.payload.errors ? `<ul>${err.payload.errors.map(e => `<li>${escapeHtml(e.message)}</li>`).join('')}</ul>` : '');
    box.innerHTML = `<div class="alert alert-danger"><div class="alert-body"><div class="alert-desc">${escapeHtml(err.message)}</div>${details}</div></div>`;
  } finally {
    $('#buildBtn').disabled = false;
  }
});

// ---------------------------------------------------------------------------
// Wznowienie pracy po odswiezeniu strony (serwer pamieta zadanie - JOB_TTL)
// ---------------------------------------------------------------------------
async function offerResume() {
  const lastJobId = lsGet(LAST_JOB_KEY);
  if (!lastJobId) return;
  try {
    const res = await apiJson('GET', `/api/jobs/${encodeURIComponent(lastJobId)}`);
    const job = res.job;
    const candidates = job.candidates || [];
    const configured = candidates.filter(c => job.draft.candidates[c.id] && job.draft.candidates[c.id].status !== 'unresolved').length;
    $('#resumeDesc').textContent = `${job.templateName} + ${job.excelName}` + (candidates.length ? ` — skonfigurowano ${configured} z ${candidates.length} ${plural(candidates.length, 'fragmentu', 'fragmentów', 'fragmentów')}.` : '.');
    $('#resumeBanner').classList.remove('hidden');
    $('#resumeBtn').onclick = () => resumeJob(lastJobId).catch(err => showNotice(err.message));
    $('#resumeDismissBtn').onclick = () => { lsRemove(LAST_JOB_KEY); $('#resumeBanner').classList.add('hidden'); };
  } catch {
    lsRemove(LAST_JOB_KEY); // zadanie wygaslo albo serwer je usunal
  }
}

async function resumeJob(jobId) {
  $('#resumeBanner').classList.add('hidden');
  resetWorkspace();
  state.jobId = jobId;
  const job = await loadJob();
  populateSheetSelect(job.workbook.sheetNames, job.draft.preferredSheet || job.workbook.defaultSheet);
  await onSheetChange({ save: false, preferredAddress: job.draft.addressColumn });
  $('#afterUpload').classList.remove('hidden');
  setStatus('#uploadStatus', `Wczytano: ${job.templateName} + ${job.excelName}.`, true);
  if (job.markingsPalette) {
    showPanel(2);
    renderMarkingsPalette(job.markingsPalette, job.selectedMarkings);
  }
  if (job.candidates) {
    showPanel(3);
    renderAutoConfigSummary();
    renderCandidates();
    scrollToPanel(3);
    await runAutoConfigureAnalyze(); // swieze podpowiedzi (np. po aktualizacji Kreatora)
  } else if (job.markingsPalette) {
    scrollToPanel(2);
  } else {
    await detectMarkings();
  }
}

offerResume();
