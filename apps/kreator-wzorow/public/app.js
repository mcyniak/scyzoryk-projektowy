// Kreator wzorów seryjnych - logika UI. Bez frameworka/bundlera (wzorzec
// całego repo, patrz CLAUDE.md).
const scyzorykMainPanelHost = location.hostname === 'scyzoryk.localhost' ? 'scyzoryk.localhost' : '127.0.0.1';
const scyzorykMainPanelUrl = `http://${scyzorykMainPanelHost}:3000`;
document.querySelectorAll('[data-main-link]').forEach(link => { link.href = scyzorykMainPanelUrl; link.removeAttribute('target'); });

const HEADERS = { 'X-Scyzoryk-Request': '1' };

const state = {
  jobId: null,
  job: null,
  candidateFilter: 'all',
  openCandidateId: null,
  openCandidateSuggestion: null
};

function $(sel) { return document.querySelector(sel); }
function escapeHtml(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

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

// Podglad kandydata "w zdaniu" (sekcja "latwiej uzupelniac") - pokazuje
// realny fragment dokumentu wokol podswietlenia zamiast samego wyrwanego z
// kontekstu tekstu, zeby user od razu widzial O CO CHODZI, bez otwierania
// samego Worda. Ucina brzegi kontekstu (paragraphPrefix/Suffix moga byc
// calym akapitem, nawet kilkaset znakow) i zawsze pokazuje "..." na obcietym
// koncu - to tylko WYCINEK, nie caly akapit.
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
function buildInlinePreviewHtml(candidate, { edgeLen = 60 } = {}) {
  const markStyle = `background:${escapeHtml(candidate.displayColor || '#ffe58a')};color:${contrastTextColor(candidate.displayColor)}`;
  const mark = `<mark class="candidate-inline-mark" style="${markStyle}">${escapeHtml(candidate.text)}</mark>`;
  if (candidate.containerKind === 'tableCell') {
    const left = truncateEdge(candidate.leftCellText, edgeLen, true);
    const right = truncateEdge(candidate.rightCellText, edgeLen, false);
    if (!left && !right) return null;
    return `${left ? `…${escapeHtml(left)} | ` : ''}${mark}${right ? ` | ${escapeHtml(right)}…` : ''}`;
  }
  const prefix = truncateEdge(candidate.paragraphPrefix, edgeLen, true);
  const suffix = truncateEdge(candidate.paragraphSuffix, edgeLen, false);
  if (!prefix && !suffix) return null;
  return `${prefix ? `…${escapeHtml(prefix)} ` : ''}${mark}${suffix ? ` ${escapeHtml(suffix)}…` : ''}`;
}
// Wrapper z bezpiecznym fallbackiem - gdy brak kontekstu (stare zeskanowane
// joby sprzed dodania paragraphPrefix/Suffix, albo kandydat naprawde bez
// sasiadow), pokaz chociaz sam tekst kandydata podswietlony, nigdy pusto.
function renderCandidateInlinePreview(candidate, opts) {
  return buildInlinePreviewHtml(candidate, opts) || `<mark class="candidate-inline-mark" style="background:${escapeHtml(candidate.displayColor || '#ffe58a')};color:${contrastTextColor(candidate.displayColor)}">${escapeHtml(candidate.text)}</mark>`;
}

// Krotki opis propozycji auto-konfiguracji (sekcja 26 promptu: karta
// sugestii) - tylko etykieta typu + ewentualna kolumna, procent pewnosci
// dolaczany osobno przez wywolujacego.
function describeSuggestion(s) {
  if (s.kind === 'field' && s.bestColumn) return `Z Excela → „${s.bestColumn}”`;
  if (s.kind === 'manual') return 'Do projektanta';
  if (s.kind === 'constant') return 'Stałe';
  return 'Z Excela';
}

// Krotkie uzasadnienie sugestii "po ludzku" - najwyzej wazony pozytywny powod
// z reasons[] (patrz autoConfigurator.js), zeby user nie musial ufac samemu
// procentowi.
function topReasonMessage(suggestion) {
  const positive = (suggestion.reasons || []).filter(r => r.weight > 0);
  if (!positive.length) return null;
  return positive.reduce((best, r) => (r.weight > best.weight ? r : best)).message;
}

// Podglad przykladowych wartosci kolumny (sekcja "podglady/podpowiedzi") -
// uzywa juz istniejacego, ograniczonego do MAX_UNIQUE_VALUES endpointu (patrz
// tez lookup w renderFieldConfig), wiec bezpieczne nawet dla duzych arkuszy.
async function fetchColumnValues(sheetName, columnName) {
  try {
    const res = await apiJson('GET', `/api/jobs/${state.jobId}/sheets/${encodeURIComponent(sheetName)}/columns/${encodeURIComponent(columnName)}/values`);
    return res.values || [];
  } catch {
    return [];
  }
}
function renderValueChips(container, values, max = 5) {
  if (!container) return;
  if (!values.length) { container.innerHTML = '<span class="hint">Brak przykładowych wartości w tej kolumnie.</span>'; return; }
  const shown = values.slice(0, max);
  const extra = values.length - shown.length;
  container.innerHTML = `<span class="value-preview-label">Przykładowe wartości:</span>` +
    shown.map(v => `<span class="value-chip">${escapeHtml(v)}</span>`).join('') +
    (extra > 0 ? `<span class="value-chip more">+${extra} więcej</span>` : '');
}

// Pole "kolumna" jako input+datalist zamiast <select> - przy arkuszach z
// dziesiatkami kolumn (realne pliki klienta miewaly ich ~90) zwykly select
// jest trudny do przeszukania; datalist daje wpisywanie/filtrowanie "za
// darmo" w kazdej przegladarce, bez wlasnej logiki filtrowania.
function columnPickerHtml({ inputId, listId, columns, selected, suggestedColumn }) {
  const ordered = suggestedColumn && columns.includes(suggestedColumn)
    ? [suggestedColumn, ...columns.filter(c => c !== suggestedColumn)]
    : columns;
  return `
    <input type="text" id="${inputId}" class="input" list="${listId}" autocomplete="off"
      value="${escapeHtml(selected || suggestedColumn || '')}" placeholder="Zacznij pisać, aby wyszukać kolumnę…" />
    <datalist id="${listId}">${ordered.map(c => `<option value="${escapeHtml(c)}">${c === suggestedColumn ? ' (sugerowane)' : ''}</option>`).join('')}</datalist>`;
}

async function apiJson(method, url, body) {
  const opts = { method, headers: { ...HEADERS } };
  if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  const res = await fetch(url, opts);
  const json = await res.json().catch(() => null);
  if (!res.ok || !json || json.ok === false) {
    const message = (json && json.message) || `Błąd żądania (${res.status}).`;
    const err = new Error(message);
    err.payload = json;
    throw err;
  }
  return json;
}

function showNotice(message, kind = 'err') {
  const el = $('#globalNotice');
  el.textContent = message;
  el.className = `panel notice ${kind === 'ok' ? 'blue' : ''}`.trim();
  el.classList.remove('hidden');
}
function hideNotice() { $('#globalNotice').classList.add('hidden'); }

function setStatus(elId, message, ok) {
  const el = $(elId);
  el.textContent = message;
  el.className = ok === true ? 'ok' : ok === false ? 'err' : '';
}

// ---------------------------------------------------------------------------
// KROK 1 - upload
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
    state.jobId = json.jobId;
    setStatus('#uploadStatus', `Wczytano: ${json.templateName} + ${json.excelName} (arkusz: ${json.workbook.defaultSheet}).`, true);
    await loadJob();
    populateSheetSelect(json.workbook.sheetNames, json.workbook.defaultSheet);
    await onSheetChange();
    $('#afterUpload').classList.remove('hidden');
  } catch (err) {
    setStatus('#uploadStatus', err.message, false);
  } finally {
    $('#uploadBtn').disabled = false;
  }
});

function populateSheetSelect(sheetNames, selected) {
  const sel = $('#sheetSelect');
  sel.innerHTML = sheetNames.map(name => `<option value="${escapeHtml(name)}"${name === selected ? ' selected' : ''}>${escapeHtml(name)}</option>`).join('');
}

async function onSheetChange() {
  const sheetName = $('#sheetSelect').value;
  const res = await apiJson('GET', `/api/jobs/${state.jobId}/sheets/${encodeURIComponent(sheetName)}/rows?limit=1`);
  const addrSel = $('#addressColumnSelect');
  addrSel.innerHTML = res.columns.map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');
  const guess = res.columns.find(c => /adres/i.test(c)) || res.columns[0];
  if (guess) addrSel.value = guess;
}
$('#sheetSelect').addEventListener('change', onSheetChange);

$('#detectMarkingsBtn').addEventListener('click', async () => {
  setStatus('#markingsStatus', 'Wykrywam oznaczenia (może to potrwać, jeśli Word jest zajęty)...', null);
  $('#detectMarkingsBtn').disabled = true;
  try {
    const res = await apiJson('POST', `/api/jobs/${state.jobId}/scan-markings`, {});
    renderMarkingsPalette(res.markings || []);
    setStatus('#markingsStatus', res.markings.length ? `Znaleziono ${res.markings.length} rodzajów oznaczeń.` : 'Nie znaleziono żadnych oznaczeń (Highlight/cieniowanie) we wzorze.', true);
    $('#markingsPaletteBox').classList.toggle('hidden', !res.markings.length);
  } catch (err) {
    setStatus('#markingsStatus', err.message, false);
  } finally {
    $('#detectMarkingsBtn').disabled = false;
  }
});

function renderMarkingsPalette(markings) {
  const list = $('#markingsList');
  list.innerHTML = markings.map(m => {
    const examples = (m.examples || []).map(e => escapeHtml(e.text)).join(' · ');
    return `<label class="marking-row">
      <input type="checkbox" class="marking-checkbox" value="${escapeHtml(m.key)}" />
      <span class="marking-swatch" style="background:${escapeHtml(m.displayColor)}"></span>
      <span class="marking-meta">
        <div><span class="marking-kind">${m.kind === 'highlight' ? 'Highlight' : 'Cieniowanie'}</span> · <span class="marking-count">${m.count} wystąpień</span></div>
        <div class="marking-examples">${examples || '—'}</div>
      </span>
    </label>`;
  }).join('') || '<p class="hint">Brak oznaczeń.</p>';
}

$('#scanBtn').addEventListener('click', async () => {
  const selected = Array.from(document.querySelectorAll('.marking-checkbox:checked')).map(el => el.value);
  if (!selected.length) { setStatus('#scanStatus', 'Zaznacz przynajmniej jedno oznaczenie.', false); return; }
  setStatus('#scanStatus', 'Skanuję wybrane oznaczenia...', null);
  $('#scanBtn').disabled = true;
  try {
    const sheetName = $('#sheetSelect').value;
    const res = await apiJson('POST', `/api/jobs/${state.jobId}/scan`, { sheetName, selectedMarkings: selected });
    setStatus('#scanStatus', `Znaleziono ${res.candidates.length} kandydatów.`, true);
    await loadJob();
    // addressColumn od razu ustawiamy w drafcie (Kreator wymaga jawnego wyboru).
    await apiJson('PUT', `/api/jobs/${state.jobId}/config`, buildConfigPutBody({ addressColumn: $('#addressColumnSelect').value, preferredSheet: sheetName }));
    await loadJob();
    $('#step2Panel').classList.remove('hidden');
    renderCandidates();
    $('#step2Panel').scrollIntoView({ behavior: 'smooth' });
    await runAutoConfigureAnalyze();
  } catch (err) {
    setStatus('#scanStatus', err.message, false);
  } finally {
    $('#scanBtn').disabled = false;
  }
});

// ---------------------------------------------------------------------------
// Job state
// ---------------------------------------------------------------------------
async function loadJob() {
  const res = await apiJson('GET', `/api/jobs/${state.jobId}`);
  state.job = res.job;
  updateJobStatusBar();
  return res.job;
}
function updateJobStatusBar() {
  const bar = $('#jobStatusBar');
  if (!state.job) { bar.classList.add('hidden'); return; }
  bar.classList.remove('hidden');
  bar.textContent = `Status: ${state.job.statusMessage || state.job.status}`;
}

// Buduje cialo PUT /config na podstawie AKTUALNEGO job.draft + nadpisan.
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

// ---------------------------------------------------------------------------
// KROK 2 - lista kandydatów
// ---------------------------------------------------------------------------
const FILTERS = [
  { key: 'all', label: 'Wszystkie' },
  { key: 'unresolved', label: 'Nierozwiązane' },
  { key: 'auto', label: 'Automatyczne' },
  { key: 'review', label: 'Do przejrzenia' },
  { key: 'constant', label: 'Stałe' },
  { key: 'field', label: 'Excel' },
  { key: 'block', label: 'Warunek' },
  { key: 'manual', label: 'Do projektanta' }
];

// Auto-konfiguracja (PROMPT_CLAUDE_AUTO_KONFIGURACJA_KREATORA.md) - lokalny,
// deterministyczny silnik sugestii (zero AI/sieci). Uzupelnia reczny panel
// ponizej, nigdy go nie zastepuje: sugestia to tylko odznaka przy kandydacie,
// ktory NADAL nie ma zadnej decyzji - jesli user rozstrzygnie recznie, badge
// znika (bo filtr auto/review patrzy WYLACZNIE na status 'unresolved').
async function runAutoConfigureAnalyze() {
  try {
    await apiJson('POST', `/api/jobs/${state.jobId}/auto-configure/analyze`, { sheetName: state.job.draft.preferredSheet });
    await loadJob();
    renderAutoConfigSummary();
    renderCandidates();
  } catch (err) {
    // Nie-fatalne: skan juz sie udal, to tylko dodatkowa, opcjonalna analiza.
    setStatus('#autoConfigStatus', `Automatyczna analiza nie powiodła się: ${err.message}`, false);
  }
}

function renderAutoConfigSummary() {
  const ac = state.job && state.job.autoConfig;
  $('#autoConfigPanel').classList.toggle('hidden', !ac);
  if (!ac) return;
  const s = ac.summary;
  // Liczby pochodza z policzonego przez serwer podsumowania (nie z tekstu
  // kandydata/Excela), wiec innerHTML z <strong> jest tu bezpieczny - w
  // odroznieniu od renderowania samego tekstu kandydata (escapeHtml ponizej).
  const already = s.alreadyResolved ? ` (${s.alreadyResolved} już skonfigurowanych pominięto).` : '';
  $('#autoConfigSummary').innerHTML = `Rozpoznano automatycznie <strong>${s.auto}</strong> z <strong>${s.total}</strong> kandydatów, <strong>${s.review}</strong> wymaga przejrzenia, <strong>${s.unresolved}</strong> zostaje bez propozycji.${already}`;
  $('#sampleRowInfo').textContent = ac.sampleRow
    ? `Wykryto rekord wzorcowy #${ac.sampleRow.recordNumber} (pewność ${Math.round(ac.sampleRow.confidence * 100)}%).`
    : 'Nie udało się jednoznacznie wskazać rekordu wzorcowego — dopasowania oparte wyłącznie o kontekst.';
  $('#applyHighConfidenceBtn').textContent = `Zastosuj ${s.auto} pewnych`;
  $('#applyHighConfidenceBtn').disabled = s.auto === 0;

  const hasAutoOrigin = state.job.candidateDecisionMeta && Object.values(state.job.candidateDecisionMeta).some(m => m.origin === 'auto');
  $('#undoAutoConfigBtn').classList.toggle('hidden', !hasAutoOrigin);
}

$('#reanalyzeBtn').addEventListener('click', () => runAutoConfigureAnalyze());
$('#applyHighConfidenceBtn').addEventListener('click', async () => {
  setStatus('#autoConfigStatus', 'Stosuję pewne sugestie...', null);
  try {
    const res = await apiJson('POST', `/api/jobs/${state.jobId}/auto-configure/apply`, {
      applyHighConfidence: true,
      analysisId: state.job.autoConfig && state.job.autoConfig.analysisId,
    });
    setStatus('#autoConfigStatus', `Zastosowano ${res.appliedCount} sugestii.`, true);
    await loadJob();
    await runAutoConfigureAnalyze();
    // Po zastosowaniu pewnych przejdz od razu tam, gdzie jest jeszcze co
    // zrobic (sekcja 25) - nie zostawiaj widoku na filtrze, ktory wlasnie
    // opustoszal.
    const s = state.job.autoConfig && state.job.autoConfig.summary;
    state.candidateFilter = s && s.review > 0 ? 'review' : 'unresolved';
    renderCandidates();
  } catch (err) {
    setStatus('#autoConfigStatus', err.message, false);
  }
});

$('#undoAutoConfigBtn').addEventListener('click', async () => {
  if (!confirm('Cofnąć wszystkie automatyczne przypisania (nie ręczne, nie zaakceptowane osobno)?')) return;
  setStatus('#autoConfigStatus', 'Cofam automatyczne przypisania...', null);
  try {
    const res = await apiJson('POST', `/api/jobs/${state.jobId}/auto-configure/undo`, {});
    setStatus('#autoConfigStatus', `Cofnięto ${res.undoneCount} automatycznych przypisań.`, true);
    await loadJob();
    renderAutoConfigSummary();
    renderCandidates();
  } catch (err) {
    setStatus('#autoConfigStatus', err.message, false);
  }
});

// 1-klikowe akcje na pojedynczej sugestii (sekcja 9/11) - Akceptuj/Odrzuć nie
// otwieraja duzego panelu, dzialaja bezposrednio z wiersza kandydata.
async function acceptSuggestion(candidateId) {
  try {
    const res = await apiJson('POST', `/api/jobs/${state.jobId}/auto-configure/apply`, {
      suggestionIds: [candidateId],
      analysisId: state.job.autoConfig && state.job.autoConfig.analysisId,
    });
    await loadJob();
    renderAutoConfigSummary();
    renderCandidates();
    setStatus('#autoConfigStatus', res.appliedCount ? 'Zaakceptowano sugestię.' : 'Nie udało się zastosować tej sugestii.', Boolean(res.appliedCount));
  } catch (err) {
    setStatus('#autoConfigStatus', err.message, false);
  }
}

async function rejectSuggestion(candidateId) {
  try {
    await apiJson('POST', `/api/jobs/${state.jobId}/auto-configure/reject`, {
      suggestionIds: [candidateId],
      analysisId: state.job.autoConfig && state.job.autoConfig.analysisId,
    });
    await loadJob();
    renderAutoConfigSummary();
    renderCandidates();
  } catch (err) {
    setStatus('#autoConfigStatus', err.message, false);
  }
}

function renderCandidates() {
  const job = state.job;
  if (!job || !job.candidates) return;
  const decisions = job.draft.candidates || {};
  const suggestions = new Map((job.autoConfig && job.autoConfig.candidateSuggestions || []).map(s => [s.candidateId, s]));

  const counts = { all: job.candidates.length, unresolved: 0, auto: 0, review: 0, constant: 0, field: 0, block: 0, manual: 0 };
  for (const c of job.candidates) {
    const status = (decisions[c.id] && decisions[c.id].status) || 'unresolved';
    counts[status] = (counts[status] || 0) + 1;
    if (status === 'unresolved') {
      const suggestion = suggestions.get(c.id);
      if (suggestion && suggestion.tier === 'auto') counts.auto++;
      else if (suggestion && suggestion.tier === 'review') counts.review++;
    }
  }
  $('#candidateMetrics').innerHTML = `
    <span class="candidate-metric">Znalezione: ${counts.all}</span>
    <span class="candidate-metric">Skonfigurowane: ${counts.all - counts.unresolved}</span>
    <span class="candidate-metric">Do projektanta: ${counts.manual || 0}</span>
    <span class="candidate-metric">Pozostało: ${counts.unresolved}</span>`;

  $('#candidateFilters').innerHTML = FILTERS.map(f =>
    `<button type="button" data-filter="${f.key}" class="${state.candidateFilter === f.key ? 'active' : ''}">${f.label} (${counts[f.key] || 0})</button>`
  ).join('');
  document.querySelectorAll('#candidateFilters button').forEach(btn => btn.addEventListener('click', () => { state.candidateFilter = btn.dataset.filter; renderCandidates(); }));

  const filtered = job.candidates.filter(c => {
    if (state.candidateFilter === 'all') return true;
    const status = (decisions[c.id] && decisions[c.id].status) || 'unresolved';
    if (state.candidateFilter === 'auto' || state.candidateFilter === 'review') {
      if (status !== 'unresolved') return false;
      const suggestion = suggestions.get(c.id);
      return suggestion && suggestion.tier === state.candidateFilter;
    }
    return status === state.candidateFilter;
  });

  $('#candidateList').innerHTML = filtered.map(c => {
    const decision = decisions[c.id] || { status: 'unresolved' };
    const badgeText = { constant: 'Stałe', field: 'Excel', block: 'Warunek', manual: 'Projektant', unresolved: 'Brak decyzji' }[decision.status] || 'Brak decyzji';
    const suggestion = decision.status === 'unresolved' ? suggestions.get(c.id) : null;
    const hasSuggestion = suggestion && suggestion.tier !== 'unresolved';
    const topReason = hasSuggestion ? topReasonMessage(suggestion) : null;
    const suggestionBadge = hasSuggestion
      ? `<div class="u-mt-2">
          <span class="badge ${suggestion.tier === 'auto' ? 'badge-success' : 'badge-warning'}">Sugestia: ${escapeHtml(describeSuggestion(suggestion))} (${suggestion.score}%)</span>
          ${topReason ? `<div class="suggestion-reason">${escapeHtml(topReason)}</div>` : ''}
        </div>`
      : '';
    // 1-klikowe Akceptuj/Zmień/Odrzuć (sekcja 9/11) - TYLKO gdy jest sugestia
    // do rozstrzygniecia, zeby nie zaslaniac zwyklych, juz nierozwiazanych
    // bez propozycji kandydatow niepotrzebnymi przyciskami.
    const suggestionActions = hasSuggestion
      ? `<div class="candidate-suggestion-actions u-mt-2">
          <button type="button" class="btn btn-primary btn-sm" data-suggestion-action="accept" data-candidate-id="${escapeHtml(c.id)}">Akceptuj</button>
          <button type="button" class="btn btn-secondary btn-sm" data-suggestion-action="change" data-candidate-id="${escapeHtml(c.id)}">Zmień</button>
          <button type="button" class="btn btn-ghost btn-sm" data-suggestion-action="reject" data-candidate-id="${escapeHtml(c.id)}">Odrzuć</button>
        </div>`
      : '';
    return `<div class="candidate-row" data-candidate-id="${escapeHtml(c.id)}">
      <span class="candidate-swatch" style="background:${escapeHtml(c.displayColor)}"></span>
      <span class="candidate-body">
        <div class="candidate-text">${renderCandidateInlinePreview(c, { edgeLen: 36 })}</div>
        <div class="candidate-context">${escapeHtml(describeCandidateLocation(c))}</div>
        ${suggestionBadge}
        ${suggestionActions}
      </span>
      <span class="candidate-badge ${decision.status}">${badgeText}</span>
    </div>`;
  }).join('') || '<p class="hint">Brak kandydatów dla tego filtra.</p>';

  document.querySelectorAll('.candidate-row').forEach(row => row.addEventListener('click', () => openCandidateConfig(row.dataset.candidateId)));
  document.querySelectorAll('[data-suggestion-action]').forEach(btn => btn.addEventListener('click', (e) => {
    e.stopPropagation(); // nie otwieraj panelu konfiguracji pod spodem
    const candidateId = btn.dataset.candidateId;
    const action = btn.dataset.suggestionAction;
    if (action === 'accept') acceptSuggestion(candidateId);
    else if (action === 'reject') rejectSuggestion(candidateId);
    else if (action === 'change') openCandidateConfig(candidateId);
  }));
}

// ---------------------------------------------------------------------------
// Panel konfiguracji kandydata
// ---------------------------------------------------------------------------
function openCandidateConfig(candidateId) {
  state.openCandidateId = candidateId;
  const candidate = state.job.candidates.find(c => c.id === candidateId);
  if (!candidate) return;
  $('#candidateConfigPanel').classList.remove('hidden');
  $('#candidateConfigContext').innerHTML = `${renderCandidateInlinePreview(candidate, { edgeLen: 90 })}<br><span class="candidate-context">${escapeHtml(describeCandidateLocation(candidate))}</span>`;
  const decision = state.job.draft.candidates[candidateId] || { status: 'unresolved' };

  // Prefill z sugestii (sekcja 10) - TYLKO gdy user jeszcze nic recznie nie
  // ustawil (status unresolved) i jest co prefillowac. "Zmień" z listy
  // kandydatow prowadzi wlasnie tutaj, wiec to jest jego realizacja.
  const suggestions = new Map((state.job.autoConfig && state.job.autoConfig.candidateSuggestions || []).map(s => [s.candidateId, s]));
  const suggestion = decision.status === 'unresolved' ? suggestions.get(candidateId) : null;
  state.openCandidateSuggestion = suggestion && suggestion.tier !== 'unresolved' ? suggestion : null;
  const suggestedType = state.openCandidateSuggestion
    ? { field: 'field', manual: 'manual', constant: 'constant' }[state.openCandidateSuggestion.kind]
    : null;
  const initialType = suggestedType || (decision.status === 'unresolved' ? 'constant' : decision.status);

  document.querySelectorAll('.config-type-btn').forEach(btn => btn.classList.toggle('active', btn.dataset.type === initialType));
  renderConfigTypeBody(initialType, candidate, decision, state.openCandidateSuggestion);
  $('#candidateConfigPanel').scrollIntoView({ behavior: 'smooth' });
}

document.querySelectorAll('.config-type-btn').forEach(btn => btn.addEventListener('click', () => {
  document.querySelectorAll('.config-type-btn').forEach(b => b.classList.toggle('active', b === btn));
  const candidate = state.job.candidates.find(c => c.id === state.openCandidateId);
  renderConfigTypeBody(btn.dataset.type, candidate, state.job.draft.candidates[state.openCandidateId] || {}, state.openCandidateSuggestion);
}));

$('#closeConfigBtn').addEventListener('click', () => { $('#candidateConfigPanel').classList.add('hidden'); state.openCandidateId = null; state.openCandidateSuggestion = null; });

function renderConfigTypeBody(type, candidate, decision, suggestion) {
  const body = $('#configTypeBody');
  if (type === 'constant') {
    body.innerHTML = `
      <label class="check"><input type="checkbox" id="constantOverride" ${decision.constantText != null ? 'checked' : ''}> Zastąp innym stałym tekstem</label>
      <textarea id="constantText" class="input u-mt-2" rows="2" placeholder="Pozostaw obecną treść">${escapeHtml(decision.constantText || '')}</textarea>
      <div class="hero-actions u-mt-3"><button type="button" class="btn btn-primary" id="saveConstantBtn">Zapisz</button></div>`;
    $('#saveConstantBtn').addEventListener('click', async () => {
      const override = $('#constantOverride').checked;
      await apiJson('POST', `/api/jobs/${state.jobId}/candidates/${encodeURIComponent(candidate.id)}/constant`, { text: override ? $('#constantText').value : null });
      await afterCandidateSave();
    });
  } else if (type === 'manual') {
    body.innerHTML = `
      <p class="hint">Fragment pozostanie bez zmian i zachowa dokładnie swoje oryginalne oznaczenie oraz kolor w gotowym wzorze.</p>
      <label>Etykieta (opcjonalnie, dla projektanta)
        <input type="text" id="manualLabel" class="input" value="${escapeHtml(decision.label || '')}" placeholder="np. Obliczenia PV" />
      </label>
      <div class="hero-actions u-mt-3"><button type="button" class="btn btn-primary" id="saveManualBtn">Zapisz</button></div>`;
    $('#saveManualBtn').addEventListener('click', async () => {
      await apiJson('POST', `/api/jobs/${state.jobId}/candidates/${encodeURIComponent(candidate.id)}/manual`, { label: $('#manualLabel').value });
      await afterCandidateSave();
    });
  } else if (type === 'field') {
    renderFieldConfig(candidate, decision, suggestion);
  } else if (type === 'block') {
    renderBlockConfig(candidate, decision);
  }
}

async function afterCandidateSave() {
  await loadJob();
  renderCandidates();
  $('#candidateConfigPanel').classList.add('hidden');
}

function renderFieldConfig(candidate, decision, suggestion) {
  const body = $('#configTypeBody');
  const columns = currentSheetColumns();
  const existingFields = Object.entries(state.job.draft.fields || {});
  // Prefill z sugestii (sekcja 10) - TYLKO dla NOWEGO pola (nie ma sensu przy
  // "uzyj istniejacego pola", to juz jest jawny wybor usera) i tylko gdy
  // kandydat faktycznie jeszcze nie ma zadnego fieldId.
  const suggestedColumn = suggestion && suggestion.kind === 'field' && !decision.fieldId ? suggestion.bestColumn : null;
  const topReason = suggestion ? topReasonMessage(suggestion) : null;
  body.innerHTML = `
    ${existingFields.length ? `<label>Użyj istniejącego pola
      <select id="existingFieldSelect" class="input">
        <option value="">— nowe pole —</option>
        ${existingFields.map(([id, f]) => `<option value="${escapeHtml(id)}" ${decision.fieldId === id ? 'selected' : ''}>${escapeHtml(f.label)}</option>`).join('')}
      </select>
      <span class="field-help">Wybierz, jeśli inny fragment ma pokazywać dokładnie tę samą wartość co tutaj.</span>
    </label>` : ''}
    <div id="newFieldFields" class="${existingFields.length && decision.fieldId ? 'hidden' : ''}">
      ${suggestedColumn ? `<div class="alert alert-info u-mt-0"><svg class="icon"><use href="/shared/icons.svg#i-check-circle"/></svg><div class="alert-body">
          <div class="alert-desc">Zasugerowane przez auto-konfigurację: „${escapeHtml(suggestedColumn)}” (${suggestion.score}%).${topReason ? ` ${escapeHtml(topReason)}` : ''}</div>
        </div></div>` : ''}
      <label>Nazwa pola
        <input type="text" id="fieldLabel" class="input" value="${escapeHtml(suggestedColumn || '')}" placeholder="np. Adres obiektu" />
      </label>
      <label class="u-mt-3">Typ wartości
        <select id="fieldType" class="input">
          <option value="column">Z Excela (kolumna wprost)</option>
          <option value="lookup">Wariant / tekst zależny (lookup)</option>
        </select>
      </label>
      <label class="u-mt-3">Kolumna źródłowa
        ${columnPickerHtml({ inputId: 'fieldColumn', listId: 'fieldColumnList', columns, selected: null, suggestedColumn })}
        <span class="field-help">Wpisz fragment nazwy, żeby przefiltrować listę — arkusz może mieć wiele podobnych kolumn.</span>
      </label>
      <div id="fieldColumnPreview" class="value-preview"></div>
      <div id="lookupBox" class="hidden u-mt-3">
        <p class="hint">Wpisz tekst wynikowy dla każdej wartości z przykładowego Excela.</p>
        <table class="lookup-table" id="lookupTable"></table>
      </div>
      <label class="check u-mt-3"><input type="checkbox" id="fieldRequired" checked> Pole wymagane</label>
    </div>
    <div class="hero-actions u-mt-3"><button type="button" class="btn btn-primary" id="saveFieldBtn">Zapisz</button></div>`;

  const existingSelect = $('#existingFieldSelect');
  if (existingSelect) {
    existingSelect.addEventListener('change', () => { $('#newFieldFields').classList.toggle('hidden', Boolean(existingSelect.value)); });
  }
  const fieldTypeSelect = $('#fieldType');
  const fieldColumnInput = $('#fieldColumn');

  async function refreshColumnPreview() {
    const column = fieldColumnInput.value.trim();
    const preview = $('#fieldColumnPreview');
    if (!column || !columns.includes(column)) { preview.innerHTML = ''; return; }
    const sheetName = $('#sheetSelect').value;
    renderValueChips(preview, await fetchColumnValues(sheetName, column));
  }
  async function refreshLookupTable() {
    if (fieldTypeSelect.value !== 'lookup') { $('#lookupBox').classList.add('hidden'); return; }
    const column = fieldColumnInput.value.trim();
    if (!column || !columns.includes(column)) { $('#lookupBox').classList.add('hidden'); return; }
    $('#lookupBox').classList.remove('hidden');
    const sheetName = $('#sheetSelect').value;
    const values = await fetchColumnValues(sheetName, column);
    $('#lookupTable').innerHTML = values.map(v => `<tr><td>${escapeHtml(v)}</td><td><input type="text" class="input lookup-value" data-key="${escapeHtml(v)}" placeholder="tekst wynikowy" /></td></tr>`).join('');
  }
  fieldTypeSelect.addEventListener('change', refreshLookupTable);
  fieldColumnInput.addEventListener('input', () => { refreshColumnPreview(); refreshLookupTable(); });
  refreshColumnPreview();
  refreshLookupTable();

  $('#saveFieldBtn').addEventListener('click', async () => {
    try {
      if (existingSelect && existingSelect.value) {
        await apiJson('POST', `/api/jobs/${state.jobId}/candidates/${encodeURIComponent(candidate.id)}/assign-field`, { fieldId: existingSelect.value });
      } else {
        const label = $('#fieldLabel').value.trim();
        if (!label) { alert('Podaj nazwę pola.'); return; }
        const column = fieldColumnInput.value.trim();
        if (!column || !columns.includes(column)) { alert('Wybierz kolumnę z listy podpowiedzi (zacznij pisać, aby ją znaleźć).'); return; }
        const type = fieldTypeSelect.value;
        let valueSpec;
        if (type === 'lookup') {
          const map = {};
          document.querySelectorAll('.lookup-value').forEach(inp => { if (inp.value.trim()) map[inp.dataset.key] = inp.value.trim(); });
          valueSpec = { type: 'lookup', column, map };
        } else {
          valueSpec = { type: 'column', column };
        }
        await apiJson('POST', `/api/jobs/${state.jobId}/fields`, { candidateId: candidate.id, label, required: $('#fieldRequired').checked, valueSpec });
      }
      await afterCandidateSave();
    } catch (err) { alert(err.message); }
  });
}

function renderBlockConfig(candidate, decision) {
  const body = $('#configTypeBody');
  const columns = currentSheetColumns();
  const groups = Object.entries(state.job.draft.variantGroups || {});
  body.innerHTML = `
    <label>Nazwa bloku
      <input type="text" id="blockLabel" class="input" placeholder="np. PPOŻ poniżej 6,5 kWp" />
    </label>
    <div class="split u-mt-3">
      <label>Kolumna
        ${columnPickerHtml({ inputId: 'condColumn', listId: 'condColumnList', columns, selected: null, suggestedColumn: null })}
      </label>
      <label>Operator
        <select id="condOperator" class="input">
          <option value="equals">równa się</option>
          <option value="notEquals">różna od</option>
          <option value="contains">zawiera</option>
          <option value="notContains">nie zawiera</option>
          <option value="empty">jest pusta</option>
          <option value="notEmpty">nie jest pusta</option>
          <option value="lt">mniejsza niż</option>
          <option value="lte">mniejsza lub równa</option>
          <option value="gt">większa niż</option>
          <option value="gte">większa lub równa</option>
        </select>
      </label>
    </div>
    <div id="condColumnPreview" class="value-preview"></div>
    <label class="u-mt-3">Wartość
      <input type="text" id="condValue" class="input" list="condValueList" autocomplete="off" placeholder="np. 6.5 albo mieszkalny" />
      <datalist id="condValueList"></datalist>
      <span class="field-help">Podpowiedzi w liście to rzeczywiste wartości z wybranej kolumny.</span>
    </label>
    <label class="u-mt-3">Grupa wariantów (opcjonalnie)
      <select id="variantGroupSelect" class="input">
        <option value="">— brak —</option>
        ${groups.map(([id, g]) => `<option value="${escapeHtml(id)}">${escapeHtml(g.label)} (${g.policy})</option>`).join('')}
        <option value="__new__">+ Nowa grupa (dokładnie jeden wariant)</option>
      </select>
    </label>
    <label id="newGroupLabelWrap" class="hidden u-mt-2">Nazwa nowej grupy
      <input type="text" id="newGroupLabel" class="input" placeholder="np. System montażowy" />
    </label>
    <div class="hero-actions u-mt-3"><button type="button" class="btn btn-primary" id="saveBlockBtn">Zapisz</button></div>`;

  $('#variantGroupSelect').addEventListener('change', (e) => $('#newGroupLabelWrap').classList.toggle('hidden', e.target.value !== '__new__'));
  $('#condOperator').addEventListener('change', () => {
    const needsValue = !['empty', 'notEmpty'].includes($('#condOperator').value);
    $('#condValue').closest('label').classList.toggle('hidden', !needsValue);
  });

  const condColumnInput = $('#condColumn');
  async function refreshCondColumnHints() {
    const column = condColumnInput.value.trim();
    const preview = $('#condColumnPreview');
    const list = $('#condValueList');
    if (!column || !columns.includes(column)) { preview.innerHTML = ''; list.innerHTML = ''; return; }
    const sheetName = $('#sheetSelect').value;
    const values = await fetchColumnValues(sheetName, column);
    renderValueChips(preview, values);
    list.innerHTML = values.map(v => `<option value="${escapeHtml(v)}">`).join('');
  }
  condColumnInput.addEventListener('input', refreshCondColumnHints);
  refreshCondColumnHints();

  $('#saveBlockBtn').addEventListener('click', async () => {
    try {
      const label = $('#blockLabel').value.trim();
      if (!label) { alert('Podaj nazwę bloku.'); return; }
      const column = condColumnInput.value.trim();
      if (!column || !columns.includes(column)) { alert('Wybierz kolumnę z listy podpowiedzi (zacznij pisać, aby ją znaleźć).'); return; }
      let variantGroupId = $('#variantGroupSelect').value;
      if (variantGroupId === '__new__') {
        const groupLabel = $('#newGroupLabel').value.trim();
        if (!groupLabel) { alert('Podaj nazwę nowej grupy wariantów.'); return; }
        const res = await apiJson('POST', `/api/jobs/${state.jobId}/variant-groups`, { label: groupLabel, policy: 'exactlyOne' });
        variantGroupId = res.groupId;
      }
      const operator = $('#condOperator').value;
      const condition = { column, operator };
      if (!['empty', 'notEmpty'].includes(operator)) condition.value = $('#condValue').value;
      await apiJson('POST', `/api/jobs/${state.jobId}/blocks`, { candidateId: candidate.id, label, condition, variantGroupId: variantGroupId || undefined });
      await afterCandidateSave();
    } catch (err) { alert(err.message); }
  });
}

function currentSheetColumns() {
  const addrSel = $('#addressColumnSelect');
  return Array.from(addrSel.options).map(o => o.value);
}

$('#toStep3Btn').addEventListener('click', () => {
  $('#step3Panel').classList.remove('hidden');
  populatePreviewRecordSelect();
  $('#step3Panel').scrollIntoView({ behavior: 'smooth' });
});

// ---------------------------------------------------------------------------
// KROK 3 - walidacja i podgląd
// ---------------------------------------------------------------------------
$('#validateBtn').addEventListener('click', async () => {
  const sheetName = $('#sheetSelect').value;
  setStatus('#validationResult', '', null);
  $('#validationResult').innerHTML = 'Sprawdzam...';
  try {
    const res = await apiJson('POST', `/api/jobs/${state.jobId}/validate`, { sheetName });
    renderValidation(res.validation);
  } catch (err) {
    $('#validationResult').innerHTML = `<div class="notice">${escapeHtml(err.message)}</div>`;
  }
});

function renderValidation(v) {
  const parts = [];
  if (v.ok) {
    parts.push('<div class="notice blue">Wzór wygląda poprawnie.</div>');
  } else {
    if (v.errors.length) {
      parts.push(`<div class="notice"><strong>Błędy blokujące (${v.errors.length}):</strong><ul>${v.errors.map(e => `<li>${escapeHtml(e.message)}</li>`).join('')}</ul></div>`);
    }
    if (v.recordErrorsTotal) {
      parts.push(`<div class="notice"><strong>${v.recordErrorsTotal} rekordów z błędami danych</strong> (pierwsze przykłady):
        ${v.recordErrorsSample.map(e => `<div class="record-error-row">Wiersz ${e.row}${e.address ? ' (' + escapeHtml(e.address) + ')' : ''}: ${escapeHtml(e.reasons.join('; '))}</div>`).join('')}
      </div>`);
    }
  }
  if (v.warnings.length) {
    parts.push(`<div class="notice blue"><strong>Ostrzeżenia:</strong><ul>${v.warnings.map(w => `<li>${escapeHtml(w.message)}</li>`).join('')}</ul></div>`);
  }
  $('#validationResult').innerHTML = parts.join('');
}

async function populatePreviewRecordSelect() {
  const sheetName = $('#sheetSelect').value;
  const res = await apiJson('GET', `/api/jobs/${state.jobId}/sheets/${encodeURIComponent(sheetName)}/rows?limit=200`);
  $('#previewRecordSelect').innerHTML = res.rows.map(r => `<option value="${r._record}">Wiersz ${r._record}${r[state.job.draft.addressColumn] ? ' - ' + escapeHtml(r[state.job.draft.addressColumn]) : ''}</option>`).join('');
}

$('#previewBtn').addEventListener('click', async () => {
  $('#previewResult').innerHTML = 'Generuję próbkę (może potrwać, jeśli Word jest zajęty)...';
  try {
    const sheetName = $('#sheetSelect').value;
    const recordNumber = Number($('#previewRecordSelect').value);
    const res = await apiJson('POST', `/api/jobs/${state.jobId}/preview`, { sheetName, recordNumber });
    const warnings = res.preview.warnings.length ? `<ul>${res.preview.warnings.map(w => `<li>${escapeHtml(w.message)}</li>`).join('')}</ul>` : '';
    $('#previewResult').innerHTML = `<div class="notice blue">Próbka gotowa.${warnings}
      <div class="hero-actions u-mt-2">
        ${res.preview.hasDocx ? `<a class="btn btn-secondary" href="/api/jobs/${state.jobId}/download/preview/docx">Pobierz DOCX</a>` : ''}
        ${res.preview.hasPdf ? `<a class="btn btn-secondary" href="/api/jobs/${state.jobId}/download/preview/pdf">Pobierz PDF</a>` : ''}
      </div></div>`;
  } catch (err) {
    $('#previewResult').innerHTML = `<div class="notice">${escapeHtml(err.message)}</div>`;
  }
});

$('#toStep4Btn').addEventListener('click', () => {
  $('#step4Panel').classList.remove('hidden');
  $('#templateNameInput').value = state.job.draft.templateName || '';
  $('#step4Panel').scrollIntoView({ behavior: 'smooth' });
});

// ---------------------------------------------------------------------------
// KROK 4 - build
// ---------------------------------------------------------------------------
$('#buildBtn').addEventListener('click', async () => {
  $('#buildResult').innerHTML = 'Buduję wzór (może potrwać, jeśli Word jest zajęty)...';
  $('#buildBtn').disabled = true;
  try {
    const sheetName = $('#sheetSelect').value;
    const templateName = $('#templateNameInput').value.trim();
    const res = await apiJson('POST', `/api/jobs/${state.jobId}/build`, { sheetName, templateName });
    const warnings = (res.warnings || []).length ? `<ul>${res.warnings.map(w => `<li>${escapeHtml(w.message)}</li>`).join('')}</ul>` : '';
    $('#buildResult').innerHTML = `<div class="notice blue">Gotowe: ${escapeHtml(res.downloadName)}.${warnings}
      <div class="hero-actions u-mt-2"><a class="btn btn-primary" href="/api/jobs/${state.jobId}/download/template">Pobierz wzór</a></div>
      <p class="hint u-mt-2">Wgraj pobrany plik do „Dokumenty seryjne PDF” razem z bieżącym Excelem tej inwestycji.</p></div>`;
  } catch (err) {
    const details = err.payload && err.payload.recordErrorsSample
      ? `<ul>${err.payload.recordErrorsSample.map(e => `<li>Wiersz ${e.row}: ${escapeHtml(e.reasons.join('; '))}</li>`).join('')}</ul>`
      : (err.payload && err.payload.errors ? `<ul>${err.payload.errors.map(e => `<li>${escapeHtml(e.message)}</li>`).join('')}</ul>` : '');
    $('#buildResult').innerHTML = `<div class="notice">${escapeHtml(err.message)}${details}</div>`;
  } finally {
    $('#buildBtn').disabled = false;
  }
});
