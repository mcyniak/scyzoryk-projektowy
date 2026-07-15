const pdfInput = document.getElementById('pdfs');
const pdfInfo = document.getElementById('pdfInfo');
const pdfPreviewList = document.getElementById('pdfPreviewList');
const form = document.getElementById('stampForm');
const submitBtn = document.getElementById('submitBtn');
const statusEl = document.getElementById('status');
const preview = document.getElementById('preview');
const canvas = document.getElementById('pdfCanvas');
const stampLayer = document.getElementById('stampLayer');
const resetPos = document.getElementById('resetPos');
const addStampBtn = document.getElementById('addStampBtn');
const stampList = document.getElementById('stampList');
const activeEditor = document.getElementById('activeEditor');
const prevPageBtn = document.getElementById('prevPage');
const nextPageBtn = document.getElementById('nextPage');
const previewPageInput = document.getElementById('previewPageInput');
const pageCountLabel = document.getElementById('pageCountLabel');
const zoomOutBtn = document.getElementById('zoomOut');
const zoomInBtn = document.getElementById('zoomIn');
const zoomResetBtn = document.getElementById('zoomReset');
const zoomLabel = document.getElementById('zoomLabel');
const presetSelect = document.getElementById('presetSelect');
const presetNameInput = document.getElementById('presetNameInput');
const loadPresetBtn = document.getElementById('loadPresetBtn');
const savePresetBtn = document.getElementById('savePresetBtn');
const deletePresetBtn = document.getElementById('deletePresetBtn');
const exportPresetsBtn = document.getElementById('exportPresetsBtn');
const importPresetsInput = document.getElementById('importPresetsInput');

const PRESETS_STORAGE_KEY = 'scyzoryk:pieczatki:presets:v1';

let pdfCanvasRect = null;
let drag = null;
let pdfjsLibRef = null;
let loadedPdf = null;
let currentPage = 1;
let totalPages = 0;
let activeStampId = 1;
let stampCounter = 1;
let previewZoom = 1;
let selectedPdfPreviewIndex = 0;

let stamps = [createStamp(1)];

async function getPdfJs() {
  if (pdfjsLibRef) return pdfjsLibRef;
  pdfjsLibRef = await import('/pdfjs/pdf.min.mjs');
  pdfjsLibRef.GlobalWorkerOptions.workerSrc = '/pdfjs/pdf.worker.min.mjs';
  return pdfjsLibRef;
}

function createStamp(id) {
  return {
    id,
    name: `Pieczątka ${id}`,
    text: '',
    textColor: '#d40000',
    textBorder: true,
    fontSize: 0,
    pageMode: 'all',
    customPages: '',
    excludedPages: [],
    pageOverrides: {},
    xPct: 70,
    yPct: 75,
    widthPct: 20,
    heightPct: 10,
    rotation: 0,
    opacity: 0.85,
  };
}


function readPresets() {
  try {
    const raw = localStorage.getItem(PRESETS_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writePresets(presets) {
  localStorage.setItem(PRESETS_STORAGE_KEY, JSON.stringify(presets));
}

function renderPresetSelect(selectedId = '') {
  if (!presetSelect) return;
  const presets = readPresets().sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'pl'));
  presetSelect.innerHTML = presets.length
    ? '<option value="">Wybierz preset</option>'
    : '<option value="">Brak zapisanych presetów</option>';
  for (const preset of presets) {
    const option = document.createElement('option');
    option.value = preset.id;
    option.textContent = preset.name || 'Preset bez nazwy';
    presetSelect.appendChild(option);
  }
  presetSelect.value = selectedId || '';
  updatePresetButtons();
}

function updatePresetButtons() {
  if (!presetSelect) return;
  const hasPreset = Boolean(presetSelect.value);
  if (loadPresetBtn) loadPresetBtn.disabled = !hasPreset;
  if (deletePresetBtn) deletePresetBtn.disabled = !hasPreset;
}

function copyPresetPositionFields(stamp) {
  return {
    xPct: Number(stamp.xPct) || 70,
    yPct: Number(stamp.yPct) || 75,
    widthPct: Number(stamp.widthPct) || 20,
    heightPct: Number(stamp.heightPct) || 10,
    rotation: Number(stamp.rotation) || 0,
  };
}

async function serializeStampForPreset(stamp) {
  return {
    name: stamp.name,
    text: stamp.text,
    textColor: stamp.textColor,
    textBorder: stamp.textBorder,
    fontSize: stamp.fontSize,
    pageMode: stamp.pageMode,
    customPages: stamp.customPages,
    excludedPages: Array.isArray(stamp.excludedPages) ? [...stamp.excludedPages] : [],
    pageOverrides: JSON.parse(JSON.stringify(getPageOverrides(stamp))),
    opacity: stamp.opacity,
    ...copyPresetPositionFields(stamp),
  };
}

function deserializePresetStamp(item, id) {
  const stamp = createStamp(id);
  stamp.name = item.name || `Pieczątka ${id}`;
  // Starsze presety mogly zapisac pieczatke typu "plik" (obraz/PDF) - ta
  // funkcja nie jest juz obslugiwana, wiec taki preset wczytuje sie jako
  // pusta pieczatka tekstowa (uzytkownik dostaje komunikat w loadSelectedPreset).
  stamp.text = item.stampType === 'file' ? '' : (item.text || '');
  stamp.textColor = item.textColor || '#d40000';
  stamp.textBorder = item.textBorder !== false;
  stamp.fontSize = Number(item.fontSize) || 0;
  stamp.pageMode = ['all', 'first', 'last', 'custom'].includes(item.pageMode) ? item.pageMode : 'all';
  stamp.customPages = item.customPages || '';
  stamp.excludedPages = Array.isArray(item.excludedPages) ? [...item.excludedPages] : [];
  stamp.pageOverrides = item.pageOverrides && typeof item.pageOverrides === 'object' ? JSON.parse(JSON.stringify(item.pageOverrides)) : {};
  stamp.xPct = Number(item.xPct) || 70;
  stamp.yPct = Number(item.yPct) || 75;
  stamp.widthPct = Number(item.widthPct) || 20;
  stamp.heightPct = Number(item.heightPct) || 10;
  stamp.rotation = Number(item.rotation) || 0;
  stamp.opacity = Number(item.opacity) || 0.85;
  return stamp;
}

async function saveCurrentPreset() {
  const name = (presetNameInput?.value || '').trim();
  if (!name) {
    setStatus('Wpisz nazwę presetu.', true);
    presetNameInput?.focus();
    return;
  }

  const serializedStamps = [];
  for (const stamp of stamps) {
    serializedStamps.push(await serializeStampForPreset(stamp));
  }

  const presets = readPresets();
  const selectedId = presetSelect?.value || '';
  const existingIndex = selectedId ? presets.findIndex(preset => preset.id === selectedId) : -1;
  if (existingIndex >= 0) {
    const existingName = presets[existingIndex].name || 'Preset bez nazwy';
    const confirmed = confirm(`Preset "${existingName}" już istnieje. Nadpisać go obecnymi ustawieniami pieczątek?`);
    if (!confirmed) return setStatus('Anulowano zapis - preset nie został nadpisany.');
  }
  const id = existingIndex >= 0 ? selectedId : `preset-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const preset = {
    id,
    name,
    updatedAt: new Date().toISOString(),
    stamps: serializedStamps,
  };

  if (existingIndex >= 0) presets[existingIndex] = preset;
  else presets.push(preset);

  try {
    writePresets(presets);
    renderPresetSelect(id);
    setStatus('Zapisano preset pieczątek.');
  } catch (err) {
    console.error(err);
    setStatus('Nie udało się zapisać presetu.', true);
  }
}

function loadSelectedPreset() {
  const id = presetSelect?.value || '';
  if (!id) return setStatus('Wybierz preset do wczytania.', true);
  const preset = readPresets().find(item => item.id === id);
  if (!preset) return setStatus('Nie znaleziono wybranego presetu.', true);
  const items = Array.isArray(preset.stamps) ? preset.stamps : [];
  if (!items.length) return setStatus('Ten preset nie ma zapisanych pieczątek.', true);
  const hadFileStamps = items.some(item => item.stampType === 'file');
  stamps = items.map((item, index) => deserializePresetStamp(item, index + 1));
  stampCounter = stamps.length;
  activeStampId = stamps[0].id;
  if (presetNameInput) presetNameInput.value = preset.name || '';
  renderAll();
  setStatus(hadFileStamps
    ? 'Wczytano preset. Pieczątki z pliku (obraz/PDF) nie są już obsługiwane - wpisz dla nich tekst.'
    : 'Wczytano preset.');
}

function deleteSelectedPreset() {
  const id = presetSelect?.value || '';
  if (!id) return;
  const presets = readPresets();
  const target = presets.find(item => item.id === id);
  const targetName = target?.name || 'ten preset';
  if (!confirm(`Usunąć preset "${targetName}"? Tej operacji nie da się cofnąć.`)) return;
  writePresets(presets.filter(item => item.id !== id));
  if (presetNameInput) presetNameInput.value = '';
  renderPresetSelect('');
  setStatus('Usunięto preset.');
}

function getActiveStamp() {
  return stamps.find(stamp => stamp.id === activeStampId) || stamps[0];
}

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

function setStatus(msg, error = false) {
  statusEl.textContent = msg || '';
  statusEl.classList.toggle('error', Boolean(error));
}

function canvasPageRect() {
  const c = canvas.getBoundingClientRect();
  const p = preview.getBoundingClientRect();
  return {
    left: c.left - p.left + preview.scrollLeft,
    top: c.top - p.top + preview.scrollTop,
    width: c.width,
    height: c.height,
  };
}

function parseCustomPages(input, pageCount) {
  const result = new Set();
  const raw = String(input || '').replace(/\s+/g, '');
  if (!raw) return result;

  for (const part of raw.split(',')) {
    if (!part) continue;
    if (part.includes('-')) {
      const [a, b] = part.split('-').map(n => Number(n));
      if (!Number.isInteger(a) || !Number.isInteger(b)) continue;
      const from = Math.max(1, Math.min(a, b));
      const to = Math.min(pageCount, Math.max(a, b));
      for (let i = from; i <= to; i++) result.add(i);
    } else {
      const n = Number(part);
      if (Number.isInteger(n) && n >= 1 && n <= pageCount) result.add(n);
    }
  }
  return result;
}

function pageListInput(value) {
  return Array.isArray(value) ? value.join(',') : String(value || '');
}

function stampExcludedPageSet(stamp, pageCount) {
  return parseCustomPages(pageListInput(stamp.excludedPages), pageCount || 9999);
}

function stampBaseMatchesPage(stamp, pageNumber, pageCount) {
  if (!pageCount) return true;
  if (stamp.pageMode === 'first') return pageNumber === 1;
  if (stamp.pageMode === 'last') return pageNumber === pageCount;
  if (stamp.pageMode === 'custom') return parseCustomPages(stamp.customPages, pageCount).has(pageNumber);
  return true;
}

function stampIsExcludedHere(stamp, pageNumber, pageCount) {
  return stampExcludedPageSet(stamp, pageCount).has(pageNumber);
}

function stampMatchesPage(stamp, pageNumber, pageCount) {
  return stampBaseMatchesPage(stamp, pageNumber, pageCount) && !stampIsExcludedHere(stamp, pageNumber, pageCount);
}

function pageSetToText(set) {
  const pages = [...set].sort((a, b) => a - b);
  if (!pages.length) return '';
  if (pages.length <= 6) return pages.join(', ');
  return `${pages.slice(0, 6).join(', ')}...`;
}

function addExcludedPage(stamp, pageNumber) {
  if (!pageNumber) return;
  const pages = stampExcludedPageSet(stamp, totalPages);
  pages.add(pageNumber);
  stamp.excludedPages = [...pages].sort((a, b) => a - b);
}

function removeExcludedPage(stamp, pageNumber) {
  const pages = stampExcludedPageSet(stamp, totalPages);
  pages.delete(pageNumber);
  stamp.excludedPages = [...pages].sort((a, b) => a - b);
}

function excludeStampFromCurrentPage(stampId) {
  if (!totalPages || !currentPage) return;
  const stamp = stamps.find(item => item.id === stampId);
  if (!stamp || !stampBaseMatchesPage(stamp, currentPage, totalPages)) return;
  addExcludedPage(stamp, currentPage);
  setStatus(`Usunięto pieczątkę z aktualnej strony podglądu.`, false);
  renderAll();
}

function restoreStampOnCurrentPage(stampId) {
  if (!totalPages || !currentPage) return;
  const stamp = stamps.find(item => item.id === stampId);
  if (!stamp) return;
  removeExcludedPage(stamp, currentPage);
  setStatus(`Przywrócono pieczątkę na aktualnej stronie podglądu.`, false);
  renderAll();
}


function pageOverrideKey(pageNumber) {
  return String(Math.max(1, Math.round(Number(pageNumber) || 1)));
}

function getPageOverrides(stamp) {
  if (!stamp.pageOverrides || typeof stamp.pageOverrides !== 'object') {
    stamp.pageOverrides = {};
  }
  return stamp.pageOverrides;
}

function getPageOverride(stamp, pageNumber = currentPage) {
  return getPageOverrides(stamp)[pageOverrideKey(pageNumber)] || null;
}

function hasPageOverride(stamp, pageNumber = currentPage) {
  return Boolean(getPageOverride(stamp, pageNumber));
}

function currentPositionSource(stamp) {
  return getPageOverride(stamp, currentPage) || stamp;
}

function positionKeys() {
  return ['xPct', 'yPct', 'widthPct', 'heightPct', 'rotation'];
}

function copyPositionFrom(source) {
  return {
    xPct: Number(source.xPct) || 0,
    yPct: Number(source.yPct) || 0,
    widthPct: Number(source.widthPct) || 20,
    heightPct: Number(source.heightPct) || 10,
    rotation: Number(source.rotation) || 0,
  };
}

function createPageOverride(stamp, pageNumber = currentPage) {
  if (!totalPages || !pageNumber) return null;
  const overrides = getPageOverrides(stamp);
  const key = pageOverrideKey(pageNumber);
  if (!overrides[key]) {
    overrides[key] = copyPositionFrom(stamp);
  }
  return overrides[key];
}

function removePageOverride(stamp, pageNumber = currentPage) {
  const overrides = getPageOverrides(stamp);
  delete overrides[pageOverrideKey(pageNumber)];
}

function makeCurrentPagePositionDifferent(stampId) {
  if (!totalPages || !currentPage) return;
  const stamp = stamps.find(item => item.id === stampId);
  if (!stamp) return;
  if (!stampMatchesPage(stamp, currentPage, totalPages)) {
    setStatus('Najpierw ustaw tę pieczątkę tak, żeby była widoczna na aktualnej stronie.', true);
    return;
  }
  createPageOverride(stamp, currentPage);
  setStatus('Włączono osobne miejsce pieczątki tylko na tej stronie. Teraz możesz ją przesunąć w podglądzie.', false);
  renderAll();
}

function clearCurrentPagePosition(stampId) {
  if (!totalPages || !currentPage) return;
  const stamp = stamps.find(item => item.id === stampId);
  if (!stamp) return;
  removePageOverride(stamp, currentPage);
  setStatus('Usunięto osobne miejsce. Ta strona używa już wspólnego ustawienia pieczątki.', false);
  renderAll();
}

function overridePagesLabel(stamp) {
  const pages = Object.keys(getPageOverrides(stamp))
    .map(n => Number(n))
    .filter(Number.isInteger)
    .sort((a, b) => a - b);
  return pageSetToText(new Set(pages));
}

function stampTitle(stamp) {
  return stamp.text.trim().split('\n')[0] || 'Tekst pieczątki';
}

function pagesLabel(stamp) {
  let label = 'wszystkie strony';
  if (stamp.pageMode === 'first') label = 'pierwsza strona';
  if (stamp.pageMode === 'last') label = 'ostatnia strona';
  if (stamp.pageMode === 'custom') label = stamp.customPages.trim() ? `strony: ${stamp.customPages}` : 'wybrane strony';
  const excluded = pageSetToText(stampExcludedPageSet(stamp, totalPages));
  const overrideLabel = overridePagesLabel(stamp);
  const parts = [label];
  if (excluded) parts.push(`bez: ${excluded}`);
  if (overrideLabel) parts.push(`inne miejsce: ${overrideLabel}`);
  return parts.join(', ');
}

function renderStampList() {
  stampList.innerHTML = '';
  for (const stamp of stamps) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = `stampItem${stamp.id === activeStampId ? ' active' : ''}`;
    item.innerHTML = `
      <strong>${escapeHtml(stamp.name)}</strong>
      <small>${escapeHtml(stampTitle(stamp))}</small>
      <em>${escapeHtml(pagesLabel(stamp))}</em>
    `;
    item.addEventListener('click', () => {
      activeStampId = stamp.id;
      renderAll();
    });
    stampList.appendChild(item);
  }
}

function renderActiveEditor() {
  const stamp = getActiveStamp();
  const baseAppliesHere = stampBaseMatchesPage(stamp, currentPage, totalPages);
  const excludedHere = stampIsExcludedHere(stamp, currentPage, totalPages);
  const appliesHere = baseAppliesHere && !excludedHere;
  const pagePosition = currentPositionSource(stamp);
  const pageOverrideHere = hasPageOverride(stamp, currentPage);
  activeEditor.innerHTML = `
    <div class="editorCard">
      <div class="editorTop">
        <label class="field growField">
          <span>Nazwa</span>
          <input id="stampNameInput" type="text" value="${escapeAttr(stamp.name)}" />
        </label>
        <button type="button" id="duplicateStampBtn" class="ghost smallBtn">Duplikuj</button>
        <button type="button" id="deleteStampBtn" class="ghost dangerBtn smallBtn" ${stamps.length === 1 ? 'disabled' : ''}>Usuń</button>
      </div>

      <div id="textEditor" class="tabContent">
        <label class="field">
          <span>Tekst pieczątki</span>
          <textarea id="stampTextInput" rows="2" placeholder="np. ZATWIERDZONO&#10;DATA: 2026-07-01">${escapeHtml(stamp.text)}</textarea>
        </label>
        <div class="two">
          <label class="field">
            <span>Kolor</span>
            <input id="textColorInput" type="color" value="${escapeAttr(stamp.textColor)}" />
          </label>
          <label class="field">
            <span>Rozmiar tekstu</span>
            <input id="fontSizeInput" type="number" min="0" max="96" value="${Number(stamp.fontSize) || 0}" />
          </label>
        </div>
        <label class="check checkCard">
          <input id="textBorderInput" type="checkbox" ${stamp.textBorder ? 'checked' : ''} />
          <span><strong>Drukuj ramkę wokół tekstu</strong></span>
        </label>
      </div>

      <h3>Strony tej pieczątki</h3>
      <label class="field">
        <span>Gdzie dodawać?</span>
        <select id="pageModeInput">
          <option value="all" ${stamp.pageMode === 'all' ? 'selected' : ''}>Na wszystkich stronach</option>
          <option value="first" ${stamp.pageMode === 'first' ? 'selected' : ''}>Tylko pierwsza strona</option>
          <option value="last" ${stamp.pageMode === 'last' ? 'selected' : ''}>Tylko ostatnia strona</option>
          <option value="custom" ${stamp.pageMode === 'custom' ? 'selected' : ''}>Wybrane strony</option>
        </select>
      </label>
      <label class="field" id="customPagesEditor" style="display:${stamp.pageMode === 'custom' ? 'grid' : 'none'}">
        <span>Wybrane strony</span>
        <input id="customPagesInput" type="text" value="${escapeAttr(stamp.customPages)}" placeholder="np. 1,3,5-7" />
      </label>
      <p class="pageNotice ${appliesHere ? 'ok' : 'warn'}">
        ${appliesHere ? 'Pieczątka jest widoczna na tej stronie.' : 'Pieczątka nie pojawi się na tej stronie.'}
      </p>
      <div class="pageActionRow">
        <button type="button" id="excludeCurrentPageBtn" class="ghost dangerBtn smallBtn">Usuń tylko z tej strony</button>
        <button type="button" id="restoreCurrentPageBtn" class="ghost smallBtn">Przywróć na tej stronie</button>
      </div>

      <h3>Ustawienie</h3>
      <div class="two">
        <label class="field">
          <span>Obrót</span>
          <input id="rotationInput" type="number" min="-360" max="360" value="${Number(pagePosition.rotation) || 0}" />
        </label>
        <label class="field">
          <span>Przezroczystość</span>
          <input id="opacityInput" type="number" min="0.05" max="1" step="0.05" value="${Number(stamp.opacity) || 0.85}" />
        </label>
      </div>
      <p class="simpleHint">Pozycję i wielkość ustawiasz bezpośrednio na podglądzie, przeciągając pieczątkę.</p>
    </div>
  `;

  bindEditorEvents(stamp);
}

function bindEditorEvents(stamp) {
  activeEditor.querySelector('#stampNameInput').addEventListener('input', event => {
    stamp.name = event.target.value || `Pieczątka ${stamp.id}`;
    updateBoxes();
    renderStampList();
  });

  activeEditor.querySelector('#duplicateStampBtn').addEventListener('click', () => {
    const nextId = ++stampCounter;
    const copy = {
      ...stamp,
      id: nextId,
      name: `${stamp.name} kopia`,
      excludedPages: [...stamp.excludedPages],
      pageOverrides: JSON.parse(JSON.stringify(getPageOverrides(stamp))),
    };
    stamps.push(copy);
    activeStampId = nextId;
    renderAll();
  });

  activeEditor.querySelector('#deleteStampBtn').addEventListener('click', () => {
    if (stamps.length === 1) return;
    const index = stamps.findIndex(item => item.id === stamp.id);
    if (index >= 0) stamps.splice(index, 1);
    activeStampId = stamps[Math.max(0, index - 1)]?.id || stamps[0].id;
    renderAll();
  });

  const textInput = activeEditor.querySelector('#stampTextInput');
  if (textInput) {
    textInput.addEventListener('input', event => {
      stamp.text = event.target.value;
      updateBoxes();
      renderStampList();
    });
  }

  const textColor = activeEditor.querySelector('#textColorInput');
  if (textColor) {
    textColor.addEventListener('input', event => {
      stamp.textColor = event.target.value;
      updateBoxes();
    });
  }

  const textBorder = activeEditor.querySelector('#textBorderInput');
  if (textBorder) {
    textBorder.addEventListener('change', event => {
      stamp.textBorder = event.target.checked;
      updateBoxes();
    });
  }

  const pageMode = activeEditor.querySelector('#pageModeInput');
  pageMode.addEventListener('change', event => {
    stamp.pageMode = event.target.value;
    renderAll();
  });

  const customPages = activeEditor.querySelector('#customPagesInput');
  if (customPages) {
    customPages.addEventListener('input', event => {
      stamp.customPages = event.target.value;
      updateBoxes();
      renderStampList();
      renderPageNoticeOnly();
    });
  }

  const excludeCurrentPage = activeEditor.querySelector('#excludeCurrentPageBtn');
  if (excludeCurrentPage) {
    excludeCurrentPage.addEventListener('click', () => excludeStampFromCurrentPage(stamp.id));
  }

  const restoreCurrentPage = activeEditor.querySelector('#restoreCurrentPageBtn');
  if (restoreCurrentPage) {
    restoreCurrentPage.addEventListener('click', () => restoreStampOnCurrentPage(stamp.id));
  }

  const overrideCurrentPage = activeEditor.querySelector('#overrideCurrentPageBtn');
  if (overrideCurrentPage) {
    overrideCurrentPage.addEventListener('click', () => makeCurrentPagePositionDifferent(stamp.id));
  }

  const clearOverrideCurrentPage = activeEditor.querySelector('#clearOverrideCurrentPageBtn');
  if (clearOverrideCurrentPage) {
    clearOverrideCurrentPage.addEventListener('click', () => clearCurrentPagePosition(stamp.id));
  }

  renderPageNoticeOnly();

  bindPositionNumber('rotationInput', stamp, 'rotation', -360, 360);
  bindNumber('opacityInput', stamp, 'opacity', 0.05, 1, updateBoxes);
  bindNumber('fontSizeInput', stamp, 'fontSize', 0, 96, updateBoxes);
  bindPositionNumber('xPctInput', stamp, 'xPct', 0, 100);
  bindPositionNumber('yPctInput', stamp, 'yPct', 0, 100);
  bindPositionNumber('widthPctInput', stamp, 'widthPct', 1, 100);
  bindPositionNumber('heightPctInput', stamp, 'heightPct', 1, 100);
}

function bindNumber(id, stamp, key, min, max, onChange) {
  const el = activeEditor.querySelector(`#${id}`);
  if (!el) return;
  el.addEventListener('input', event => {
    const value = Number(event.target.value);
    if (!Number.isFinite(value)) return;
    stamp[key] = clamp(value, min, max);
    onChange();
  });
}

function bindPositionNumber(id, stamp, key, min, max) {
  const el = activeEditor.querySelector(`#${id}`);
  if (!el) return;
  el.addEventListener('input', event => {
    const value = Number(event.target.value);
    if (!Number.isFinite(value)) return;
    const target = currentPositionSource(stamp);
    target[key] = clamp(value, min, max);
    updateBoxes();
  });
}

function renderPageNoticeOnly() {
  const notice = activeEditor.querySelector('.pageNotice');
  const excludeBtn = activeEditor.querySelector('#excludeCurrentPageBtn');
  const restoreBtn = activeEditor.querySelector('#restoreCurrentPageBtn');
  const overrideBtn = activeEditor.querySelector('#overrideCurrentPageBtn');
  const clearOverrideBtn = activeEditor.querySelector('#clearOverrideCurrentPageBtn');
  const positionNotice = activeEditor.querySelector('.pagePositionNotice');
  const stamp = getActiveStamp();
  if (!notice || !stamp) return;

  const hasPreviewPage = Boolean(totalPages && currentPage);
  const baseAppliesHere = hasPreviewPage && stampBaseMatchesPage(stamp, currentPage, totalPages);
  const excludedHere = hasPreviewPage && stampIsExcludedHere(stamp, currentPage, totalPages);
  const appliesHere = baseAppliesHere && !excludedHere;

  notice.className = `pageNotice ${appliesHere ? 'ok' : 'warn'}`;
  if (!hasPreviewPage) {
    notice.textContent = 'Dodaj PDF, żeby zobaczyć podgląd.';
  } else if (appliesHere) {
    notice.textContent = 'Pieczątka jest widoczna na tej stronie.';
  } else if (excludedHere) {
    notice.textContent = 'Pieczątka jest pominięta na tej stronie.';
  } else {
    notice.textContent = 'Pieczątka nie pojawi się na tej stronie.';
  }

  if (excludeBtn) {
    excludeBtn.hidden = !baseAppliesHere || excludedHere;
    excludeBtn.disabled = !hasPreviewPage || !baseAppliesHere || excludedHere;
  }
  if (restoreBtn) {
    restoreBtn.hidden = !excludedHere;
    restoreBtn.disabled = !hasPreviewPage || !excludedHere;
  }

  const overrideHere = hasPreviewPage && hasPageOverride(stamp, currentPage);
  if (positionNotice) {
    positionNotice.className = `pagePositionNotice ${overrideHere ? 'ok' : 'neutral'}`;
    if (!hasPreviewPage) {
      positionNotice.textContent = 'Dodaj PDF, żeby ustawić inne miejsce na konkretnej stronie.';
    } else if (overrideHere) {
      positionNotice.textContent = 'Na tej stronie pieczątka ma osobne miejsce. Przesuwanie zmieni tylko tę stronę.';
    } else {
      positionNotice.textContent = 'Na tej stronie pieczątka używa wspólnego miejsca. Przesuwanie zmieni wszystkie strony tej pieczątki.';
    }
  }
  if (overrideBtn) {
    overrideBtn.hidden = overrideHere;
    overrideBtn.disabled = !hasPreviewPage || !appliesHere;
  }
  if (clearOverrideBtn) {
    clearOverrideBtn.hidden = !overrideHere;
    clearOverrideBtn.disabled = !hasPreviewPage || !overrideHere;
  }
}

function updateBoxes(action = '', targetId = null) {
  if (!preview.classList.contains('loaded')) return;
  pdfCanvasRect = canvasPageRect();

  const existing = new Set([...stampLayer.querySelectorAll('.stampBox')].map(el => Number(el.dataset.stampId)));
  for (const stamp of stamps) {
    if (!existing.has(stamp.id)) {
      stampLayer.appendChild(createStampBox(stamp));
    }
  }
  for (const el of [...stampLayer.querySelectorAll('.stampBox')]) {
    const id = Number(el.dataset.stampId);
    if (!stamps.some(stamp => stamp.id === id)) el.remove();
  }

  for (const stamp of stamps) {
    const box = stampLayer.querySelector(`[data-stamp-id="${stamp.id}"]`);
    if (!box) continue;

    const appliesHere = stampMatchesPage(stamp, currentPage, totalPages);
    box.style.display = appliesHere ? 'flex' : 'none';
    box.classList.toggle('active', stamp.id === activeStampId);
    box.classList.toggle('inactive', stamp.id !== activeStampId);
    box.classList.toggle('printFrameOn', stamp.textBorder);
    box.classList.toggle('printFrameOff', !stamp.textBorder);

    const pagePosition = currentPositionSource(stamp);
    const hasOwnPositionHere = hasPageOverride(stamp, currentPage);
    const x = Number(pagePosition.xPct || 0) / 100 * pdfCanvasRect.width;
    const y = Number(pagePosition.yPct || 0) / 100 * pdfCanvasRect.height;
    const w = Number(pagePosition.widthPct || 20) / 100 * pdfCanvasRect.width;
    const h = Number(pagePosition.heightPct || 10) / 100 * pdfCanvasRect.height;
    box.style.left = `${pdfCanvasRect.left + x}px`;
    box.style.top = `${pdfCanvasRect.top + y}px`;
    box.style.width = `${Math.max(20, w)}px`;
    box.style.height = `${Math.max(14, h)}px`;
    box.style.transform = `rotate(${Number(pagePosition.rotation || 0)}deg)`;
    box.style.opacity = stamp.opacity || 0.85;

    const content = box.querySelector('.stampBoxContent') || box;

    const textVal = stamp.text.trim() || 'TEKST PIECZĄTKI';
    content.innerText = textVal;
    box.style.color = stamp.textColor || '#d40000';
    const lines = textVal.split('\n').filter(Boolean);
    const fontSizeInput = Number(stamp.fontSize) || 0;
    const sizeScale = pdfCanvasRect.width / 1000;
    let previewFontSize = fontSizeInput * sizeScale;
    if (!previewFontSize) {
      previewFontSize = Math.max(5, Math.min(
        h / Math.max(lines.length, 1) * 0.55,
        w / 10,
        28 * sizeScale,
      ));
    }
    box.style.fontSize = `${previewFontSize}px`;

    if (action === 'move' && targetId === stamp.id) {
      box.dataset.frameLabel = `${stamp.name} - przesuwasz`;
    } else if (action === 'resize' && targetId === stamp.id) {
      box.dataset.frameLabel = `${stamp.name} - zmieniasz rozmiar`;
    } else {
      box.dataset.frameLabel = `${stamp.name} · ${hasOwnPositionHere ? 'inne miejsce na tej stronie' : pagesLabel(stamp)}`;
    }
  }

  renderPageNoticeOnly();
}

function createStampBox(stamp) {
  const box = document.createElement('div');
  box.className = 'stampBox';
  box.dataset.stampId = String(stamp.id);

  const content = document.createElement('div');
  content.className = 'stampBoxContent';
  box.appendChild(content);

  const deleteBtn = document.createElement('button');
  deleteBtn.type = 'button';
  deleteBtn.className = 'stampTrash';
  deleteBtn.title = 'Usuń tę pieczątkę tylko z aktualnej strony';
  deleteBtn.setAttribute('aria-label', 'Usuń tę pieczątkę tylko z aktualnej strony');
  deleteBtn.addEventListener('pointerdown', event => {
    event.preventDefault();
    event.stopPropagation();
  });
  deleteBtn.addEventListener('click', event => {
    event.preventDefault();
    event.stopPropagation();
    activeStampId = stamp.id;
    excludeStampFromCurrentPage(stamp.id);
  });
  box.appendChild(deleteBtn);

  box.addEventListener('pointerdown', event => startBoxDrag(event, stamp.id));
  box.addEventListener('pointermove', moveBoxDrag);
  box.addEventListener('pointerup', stopBoxDrag);
  box.addEventListener('pointercancel', stopBoxDrag);
  return box;
}

function startBoxDrag(event, stampId) {
  if (event.target.closest?.('.stampTrash')) return;
  if (!preview.classList.contains('loaded')) return;
  const stamp = stamps.find(item => item.id === stampId);
  if (!stamp) return;

  activeStampId = stampId;
  renderStampList();
  renderActiveEditor();

  const box = stampLayer.querySelector(`[data-stamp-id="${stamp.id}"]`);
  const rect = box.getBoundingClientRect();
  pdfCanvasRect = canvasPageRect();
  // Uchwyt do zmiany rozmiaru (::after) wystaje 9px poza ramke - obszar
  // klikalny musi siegac dalej niz sama ramka, zeby pokrywal sie z tym,
  // co widac na podgladzie.
  const isResize = event.clientX >= rect.right - 20 && event.clientY >= rect.bottom - 20;
  const pagePosition = currentPositionSource(stamp);
  drag = {
    pointerId: event.pointerId,
    stampId,
    mode: isResize ? 'resize' : 'move',
    startX: event.clientX,
    startY: event.clientY,
    startXPct: Number(pagePosition.xPct),
    startYPct: Number(pagePosition.yPct),
    startWPct: Number(pagePosition.widthPct),
    startHPct: Number(pagePosition.heightPct),
  };
  box.classList.toggle('isMoving', drag.mode === 'move');
  box.classList.toggle('isResizing', drag.mode === 'resize');
  updateBoxes(drag.mode, stampId);
  box.setPointerCapture(event.pointerId);
}

function moveBoxDrag(event) {
  if (!drag) return;
  const stamp = stamps.find(item => item.id === drag.stampId);
  if (!stamp) return;
  const dxPct = (event.clientX - drag.startX) / pdfCanvasRect.width * 100;
  const dyPct = (event.clientY - drag.startY) / pdfCanvasRect.height * 100;
  const target = currentPositionSource(stamp);
  if (drag.mode === 'move') {
    target.xPct = clamp(drag.startXPct + dxPct, 0, 100);
    target.yPct = clamp(drag.startYPct + dyPct, 0, 100);
  } else {
    target.widthPct = clamp(drag.startWPct + dxPct, 1, 100);
    target.heightPct = clamp(drag.startHPct + dyPct, 1, 100);
  }
  updateBoxes(drag.mode, drag.stampId);
}

function stopBoxDrag(event) {
  if (drag?.pointerId !== event.pointerId) return;
  const box = stampLayer.querySelector(`[data-stamp-id="${drag.stampId}"]`);
  if (box) box.classList.remove('isMoving', 'isResizing');
  drag = null;
  renderActiveEditor();
  updateBoxes();
}

function getPdfFiles() {
  return [...(pdfInput.files || [])];
}

function clearPdfPreview() {
  loadedPdf = null;
  totalPages = 0;
  currentPage = 1;
  canvas.width = 0;
  canvas.height = 0;
  stampLayer.innerHTML = '';
  preview.classList.add('empty');
  preview.classList.remove('loaded');
  previewPageInput.value = '1';
  previewPageInput.max = '1';
  pageCountLabel.textContent = '/ -';
  prevPageBtn.disabled = true;
  nextPageBtn.disabled = true;
  updateBoxes();
}

function renderPdfPreviewList() {
  if (!pdfPreviewList) return;
  const files = getPdfFiles();
  pdfPreviewList.innerHTML = '';
  if (files.length <= 1) {
    pdfPreviewList.hidden = true;
    return;
  }

  pdfPreviewList.hidden = false;
  const label = document.createElement('div');
  label.className = 'pdfPreviewListTitle';
  label.textContent = 'Podgląd pliku:';
  pdfPreviewList.appendChild(label);

  files.forEach((file, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `pdfPreviewItem${index === selectedPdfPreviewIndex ? ' active' : ''}`;
    button.title = file.name;
    button.innerHTML = `<strong>${index + 1}</strong><span>${escapeHtml(file.name)}</span>`;
    button.addEventListener('click', () => selectPdfPreview(index));
    pdfPreviewList.appendChild(button);
  });
}

async function selectPdfPreview(index) {
  const files = getPdfFiles();
  if (!files.length) {
    selectedPdfPreviewIndex = 0;
    renderPdfPreviewList();
    clearPdfPreview();
    return;
  }

  selectedPdfPreviewIndex = clamp(Math.round(Number(index) || 0), 0, files.length - 1);
  renderPdfPreviewList();
  await loadPdfPreview(files[selectedPdfPreviewIndex]);
}

async function loadPdfPreview(file) {
  if (!file) return;
  try {
    setStatus(`Ładuję podgląd: ${file.name}`);
    const pdfjsLib = await getPdfJs();
    const data = await file.arrayBuffer();
    loadedPdf = await pdfjsLib.getDocument({ data }).promise;
    totalPages = loadedPdf.numPages;
    currentPage = 1;
    await renderPreviewPage(1);
    setStatus('');
  } catch (err) {
    console.error(err);
    setStatus('Nie udało się pokazać podglądu. Samo stemplowanie nadal może działać po stronie serwera.', true);
  }
}

async function renderPreviewPage(pageNumber) {
  if (!loadedPdf) return;
  currentPage = clamp(Math.round(Number(pageNumber) || 1), 1, totalPages);
  previewPageInput.value = String(currentPage);
  previewPageInput.max = String(totalPages || 1);
  pageCountLabel.textContent = `/ ${totalPages || '-'}`;
  prevPageBtn.disabled = currentPage <= 1;
  nextPageBtn.disabled = currentPage >= totalPages;

  const page = await loadedPdf.getPage(currentPage);
  const baseViewport = page.getViewport({ scale: 1 });
  const maxWidth = Math.min(960, Math.max(280, preview.clientWidth - 52));
  const fitScale = Math.max(0.2, maxWidth / baseViewport.width);
  const scale = fitScale * previewZoom;
  const viewport = page.getViewport({ scale });
  updateZoomLabel();
  const ctx = canvas.getContext('2d');
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  await page.render({ canvasContext: ctx, viewport }).promise;
  preview.classList.remove('empty');
  preview.classList.add('loaded');
  requestAnimationFrame(() => {
    updateBoxes();
    renderActiveEditor();
  });
}

function addStamp() {
  const nextId = ++stampCounter;
  stamps.push(createStamp(nextId));
  activeStampId = nextId;
  renderAll();
}

function resetActivePosition() {
  const stamp = getActiveStamp();
  const target = currentPositionSource(stamp);
  target.xPct = 70;
  target.yPct = 75;
  target.widthPct = 20;
  target.heightPct = 10;
  target.rotation = 0;
  if (target === stamp) stamp.opacity = 0.85;
  renderActiveEditor();
  updateBoxes();
}

function updateZoomLabel() {
  if (zoomLabel) zoomLabel.textContent = `${Math.round(previewZoom * 100)}%`;
  if (zoomOutBtn) zoomOutBtn.disabled = previewZoom <= 0.45;
  if (zoomInBtn) zoomInBtn.disabled = previewZoom >= 2.5;
}

function changePreviewZoom(delta) {
  previewZoom = clamp(Number((previewZoom + delta).toFixed(2)), 0.4, 2.5);
  if (loadedPdf) renderPreviewPage(currentPage);
  else updateZoomLabel();
}

function resetPreviewZoom() {
  previewZoom = 1;
  if (loadedPdf) renderPreviewPage(currentPage);
  else updateZoomLabel();
}

function renderAll() {
  renderStampList();
  renderActiveEditor();
  updateBoxes();
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/`/g, '&#096;');
}

pdfInput.addEventListener('change', () => {
  const files = getPdfFiles();
  pdfInfo.textContent = files.length
    ? `${files.length} plik(ów): ${files.map(f => f.name).slice(0, 3).join(', ')}${files.length > 3 ? '...' : ''}`
    : 'Możesz zaznaczyć kilka plików naraz.';

  selectedPdfPreviewIndex = 0;
  renderPdfPreviewList();
  if (files[0]) selectPdfPreview(0);
  else clearPdfPreview();
});

const dropZone = pdfInput.closest('.drop');
if (dropZone) {
  ['dragenter', 'dragover'].forEach(eventName => {
    dropZone.addEventListener(eventName, e => {
      e.preventDefault();
      dropZone.classList.add('dragover');
    }, false);
  });

  ['dragleave', 'drop'].forEach(eventName => {
    dropZone.addEventListener(eventName, e => {
      e.preventDefault();
      dropZone.classList.remove('dragover');
    }, false);
  });

  dropZone.addEventListener('drop', e => {
    const files = e.dataTransfer.files;
    if (!files.length) return;
    const pdfFiles = [...files].filter(f => f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf'));
    if (!pdfFiles.length) return;
    const dataTransfer = new DataTransfer();
    pdfFiles.forEach(f => dataTransfer.items.add(f));
    pdfInput.files = dataTransfer.files;
    pdfInput.dispatchEvent(new Event('change'));
  });
}

addStampBtn.addEventListener('click', addStamp);
presetSelect?.addEventListener('change', () => {
  const preset = readPresets().find(item => item.id === presetSelect.value);
  if (presetNameInput) presetNameInput.value = preset?.name || '';
  updatePresetButtons();
});
savePresetBtn?.addEventListener('click', () => {
  savePresetBtn.disabled = true;
  saveCurrentPreset().finally(() => {
    savePresetBtn.disabled = false;
    updatePresetButtons();
  });
});
loadPresetBtn?.addEventListener('click', loadSelectedPreset);
deletePresetBtn?.addEventListener('click', deleteSelectedPreset);

exportPresetsBtn?.addEventListener('click', () => {
  const presets = readPresets();
  const blob = new Blob([JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), presets }, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'presety-pieczatek-scyzoryk.json';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  setStatus('Wyeksportowano presety do pliku JSON.');
});

importPresetsInput?.addEventListener('change', async () => {
  const file = importPresetsInput.files?.[0];
  importPresetsInput.value = '';
  if (!file) return;
  try {
    const text = await file.text();
    const parsed = JSON.parse(text);
    const imported = Array.isArray(parsed) ? parsed : parsed.presets;
    if (!Array.isArray(imported)) throw new Error('Brak listy presetów.');
    const current = readPresets();
    const byId = new Map(current.map(item => [item.id, item]));
    for (const preset of imported) {
      if (!preset || typeof preset !== 'object') continue;
      const id = preset.id || `preset-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      byId.set(id, { ...preset, id });
    }
    writePresets(Array.from(byId.values()));
    renderPresetSelect('');
    setStatus('Zaimportowano presety.');
  } catch (err) { setStatus('Nie udało się zaimportować presetów: ' + (err.message || err), true); }
});

resetPos.addEventListener('click', resetActivePosition);
zoomOutBtn?.addEventListener('click', () => changePreviewZoom(-0.15));
zoomInBtn?.addEventListener('click', () => changePreviewZoom(0.15));
zoomResetBtn?.addEventListener('click', resetPreviewZoom);
prevPageBtn.addEventListener('click', () => renderPreviewPage(currentPage - 1));
nextPageBtn.addEventListener('click', () => renderPreviewPage(currentPage + 1));
previewPageInput.addEventListener('change', () => renderPreviewPage(Number(previewPageInput.value)));
previewPageInput.addEventListener('keydown', event => {
  if (event.key === 'Enter') {
    event.preventDefault();
    renderPreviewPage(Number(previewPageInput.value));
  }
});

window.addEventListener('resize', updateBoxes);
preview.addEventListener('scroll', updateBoxes);

form.addEventListener('submit', async event => {
  event.preventDefault();
  const pdfs = [...pdfInput.files];
  if (!pdfs.length) return setStatus('Dodaj przynajmniej jeden PDF.', true);

  const validStamps = stamps.filter(stamp => Boolean(stamp.text.trim()));

  if (!validStamps.length) {
    return setStatus('Dodaj przynajmniej jedną pieczątkę z tekstem.', true);
  }

  const data = new FormData();
  pdfs.forEach(file => data.append('pdfs', file, file.name));

  const payload = validStamps.map(stamp => ({
    name: stamp.name,
    xPct: stamp.xPct,
    yPct: stamp.yPct,
    widthPct: stamp.widthPct,
    heightPct: stamp.heightPct,
    rotation: stamp.rotation,
    opacity: stamp.opacity,
    pageMode: stamp.pageMode,
    customPages: stamp.customPages,
    excludedPages: stamp.excludedPages,
    pageOverrides: getPageOverrides(stamp),
    stampText: stamp.text,
    textColor: stamp.textColor,
    textBorder: stamp.textBorder,
    fontSize: stamp.fontSize,
  }));
  data.append('stamps', JSON.stringify(payload));

  submitBtn.disabled = true;
  setStatus('Stempluję PDF-y...');
  try {
    const response = await fetch('/api/stamp', { method: 'POST', headers: { 'X-Scyzoryk-Request': '1' }, body: data });
    if (!response.ok) {
      let msg = 'Nie udało się ostemplować PDF.';
      try { msg = (await response.json()).error || msg; } catch {}
      throw new Error(msg);
    }
    const blob = await response.blob();
    const disposition = response.headers.get('content-disposition') || '';
    const match = disposition.match(/filename="?([^";]+)"?/i);
    const fallback = pdfs.length === 1 ? pdfs[0].name.replace(/\.pdf$/i, ' - ostemplowany.pdf') : 'ostemplowane-pdf.zip';
    const filename = decodeURIComponent(match?.[1] || fallback);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    setStatus('Gotowe. Plik powinien się pobrać.');
  } catch (err) {
    console.error(err);
    setStatus(err.message, true);
  } finally {
    submitBtn.disabled = false;
  }
});

renderPresetSelect();
renderAll();
pageCountLabel.textContent = '/ -';
updateZoomLabel();
prevPageBtn.disabled = true;
nextPageBtn.disabled = true;
