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
  openCandidateId: null
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
  { key: 'constant', label: 'Stałe' },
  { key: 'field', label: 'Excel' },
  { key: 'block', label: 'Warunek' },
  { key: 'manual', label: 'Do projektanta' }
];

function renderCandidates() {
  const job = state.job;
  if (!job || !job.candidates) return;
  const decisions = job.draft.candidates || {};

  const counts = { all: job.candidates.length, unresolved: 0, constant: 0, field: 0, block: 0, manual: 0 };
  for (const c of job.candidates) {
    const status = (decisions[c.id] && decisions[c.id].status) || 'unresolved';
    counts[status] = (counts[status] || 0) + 1;
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
    return status === state.candidateFilter;
  });

  $('#candidateList').innerHTML = filtered.map(c => {
    const decision = decisions[c.id] || { status: 'unresolved' };
    const badgeText = { constant: 'Stałe', field: 'Excel', block: 'Warunek', manual: 'Projektant', unresolved: 'Brak decyzji' }[decision.status] || 'Brak decyzji';
    return `<div class="candidate-row" data-candidate-id="${escapeHtml(c.id)}">
      <span class="candidate-swatch" style="background:${escapeHtml(c.displayColor)}"></span>
      <span class="candidate-body">
        <div class="candidate-text">${escapeHtml(c.text)}</div>
        <div class="candidate-context">${escapeHtml(describeCandidateLocation(c))}</div>
      </span>
      <span class="candidate-badge ${decision.status}">${badgeText}</span>
    </div>`;
  }).join('') || '<p class="hint">Brak kandydatów dla tego filtra.</p>';

  document.querySelectorAll('.candidate-row').forEach(row => row.addEventListener('click', () => openCandidateConfig(row.dataset.candidateId)));
}

// ---------------------------------------------------------------------------
// Panel konfiguracji kandydata
// ---------------------------------------------------------------------------
function openCandidateConfig(candidateId) {
  state.openCandidateId = candidateId;
  const candidate = state.job.candidates.find(c => c.id === candidateId);
  if (!candidate) return;
  $('#candidateConfigPanel').classList.remove('hidden');
  $('#candidateConfigContext').textContent = `„${candidate.text}” (${describeCandidateLocation(candidate)})`;
  const decision = state.job.draft.candidates[candidateId] || { status: 'unresolved' };
  document.querySelectorAll('.config-type-btn').forEach(btn => btn.classList.toggle('active', btn.dataset.type === decision.status));
  renderConfigTypeBody(decision.status === 'unresolved' ? 'constant' : decision.status, candidate, decision);
  $('#candidateConfigPanel').scrollIntoView({ behavior: 'smooth' });
}

document.querySelectorAll('.config-type-btn').forEach(btn => btn.addEventListener('click', () => {
  document.querySelectorAll('.config-type-btn').forEach(b => b.classList.toggle('active', b === btn));
  const candidate = state.job.candidates.find(c => c.id === state.openCandidateId);
  renderConfigTypeBody(btn.dataset.type, candidate, state.job.draft.candidates[state.openCandidateId] || {});
}));

$('#closeConfigBtn').addEventListener('click', () => { $('#candidateConfigPanel').classList.add('hidden'); state.openCandidateId = null; });

function renderConfigTypeBody(type, candidate, decision) {
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
    renderFieldConfig(candidate, decision);
  } else if (type === 'block') {
    renderBlockConfig(candidate, decision);
  }
}

async function afterCandidateSave() {
  await loadJob();
  renderCandidates();
  $('#candidateConfigPanel').classList.add('hidden');
}

function renderFieldConfig(candidate, decision) {
  const body = $('#configTypeBody');
  const columns = currentSheetColumns();
  const existingFields = Object.entries(state.job.draft.fields || {});
  body.innerHTML = `
    ${existingFields.length ? `<label>Użyj istniejącego pola
      <select id="existingFieldSelect" class="input">
        <option value="">— nowe pole —</option>
        ${existingFields.map(([id, f]) => `<option value="${escapeHtml(id)}" ${decision.fieldId === id ? 'selected' : ''}>${escapeHtml(f.label)}</option>`).join('')}
      </select>
    </label>` : ''}
    <div id="newFieldFields" class="${existingFields.length && decision.fieldId ? 'hidden' : ''}">
      <label>Nazwa pola
        <input type="text" id="fieldLabel" class="input" placeholder="np. Adres obiektu" />
      </label>
      <label class="u-mt-3">Typ wartości
        <select id="fieldType" class="input">
          <option value="column">Z Excela (kolumna wprost)</option>
          <option value="lookup">Wariant / tekst zależny (lookup)</option>
        </select>
      </label>
      <label class="u-mt-3">Kolumna źródłowa
        <select id="fieldColumn" class="input">${columns.map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('')}</select>
      </label>
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
  const fieldColumnSelect = $('#fieldColumn');
  async function refreshLookupTable() {
    if (fieldTypeSelect.value !== 'lookup') { $('#lookupBox').classList.add('hidden'); return; }
    $('#lookupBox').classList.remove('hidden');
    const sheetName = $('#sheetSelect').value;
    const res = await apiJson('GET', `/api/jobs/${state.jobId}/sheets/${encodeURIComponent(sheetName)}/columns/${encodeURIComponent(fieldColumnSelect.value)}/values`);
    $('#lookupTable').innerHTML = res.values.map(v => `<tr><td>${escapeHtml(v)}</td><td><input type="text" class="input lookup-value" data-key="${escapeHtml(v)}" placeholder="tekst wynikowy" /></td></tr>`).join('');
  }
  fieldTypeSelect.addEventListener('change', refreshLookupTable);
  fieldColumnSelect.addEventListener('change', refreshLookupTable);

  $('#saveFieldBtn').addEventListener('click', async () => {
    try {
      if (existingSelect && existingSelect.value) {
        await apiJson('POST', `/api/jobs/${state.jobId}/candidates/${encodeURIComponent(candidate.id)}/assign-field`, { fieldId: existingSelect.value });
      } else {
        const label = $('#fieldLabel').value.trim();
        if (!label) { alert('Podaj nazwę pola.'); return; }
        const type = fieldTypeSelect.value;
        let valueSpec;
        if (type === 'lookup') {
          const map = {};
          document.querySelectorAll('.lookup-value').forEach(inp => { if (inp.value.trim()) map[inp.dataset.key] = inp.value.trim(); });
          valueSpec = { type: 'lookup', column: fieldColumnSelect.value, map };
        } else {
          valueSpec = { type: 'column', column: fieldColumnSelect.value };
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
        <select id="condColumn" class="input">${columns.map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('')}</select>
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
    <label class="u-mt-3">Wartość
      <input type="text" id="condValue" class="input" placeholder="np. 6.5 albo mieszkalny" />
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

  $('#saveBlockBtn').addEventListener('click', async () => {
    try {
      const label = $('#blockLabel').value.trim();
      if (!label) { alert('Podaj nazwę bloku.'); return; }
      let variantGroupId = $('#variantGroupSelect').value;
      if (variantGroupId === '__new__') {
        const groupLabel = $('#newGroupLabel').value.trim();
        if (!groupLabel) { alert('Podaj nazwę nowej grupy wariantów.'); return; }
        const res = await apiJson('POST', `/api/jobs/${state.jobId}/variant-groups`, { label: groupLabel, policy: 'exactlyOne' });
        variantGroupId = res.groupId;
      }
      const operator = $('#condOperator').value;
      const condition = { column: $('#condColumn').value, operator };
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
