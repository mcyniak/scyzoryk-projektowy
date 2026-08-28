let lastPlan = null;

// Przegladarka folderow w stronie zamiast recznego wpisywania sciezki -
// dwie proby prawdziwego natywnego okna Windows (explorer.exe w tle,
// System.Windows.Forms.FolderBrowserDialog) zostaly przetestowane NA ZYWO
// i obie zawiodly (okno sie nie pojawialo) - patrz lib/folderBrowse.js.
let browseTargetInput = null;
let currentBrowsePath = null;

document.querySelector('#browseFolderBtn').addEventListener('click', () => {
  browseTargetInput = document.querySelector('#investmentFolder');
  const startPath = browseTargetInput.value.trim();
  openFolderBrowser(startPath || null);
});
document.querySelector('#folderBrowseClose').addEventListener('click', closeFolderBrowser);
document.querySelector('#folderBrowseModal').addEventListener('click', (event) => {
  if (event.target.id === 'folderBrowseModal') closeFolderBrowser();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && document.querySelector('#folderBrowseModal').classList.contains('open')) closeFolderBrowser();
});

function closeFolderBrowser() {
  document.querySelector('#folderBrowseModal').classList.remove('open');
}

async function openFolderBrowser(startPath) {
  document.querySelector('#folderBrowseModal').classList.add('open');
  await loadFolderBrowse(startPath);
}

async function loadFolderBrowse(targetPath) {
  const listEl = document.querySelector('#folderBrowseList');
  const currentEl = document.querySelector('#folderBrowseCurrentPath');
  listEl.innerHTML = '<div class="folder-row">Wczytuję...</div>';
  try {
    const url = targetPath ? `/api/browse-folder?path=${encodeURIComponent(targetPath)}` : '/api/browse-folder';
    const res = await fetch(url);
    const json = await res.json().catch(() => null);
    if (!json || !json.ok) {
      listEl.innerHTML = `<div class="folder-row">${escapeHtml(json?.error || 'Nie udało się wczytać folderów.')}</div>`;
      return;
    }
    currentBrowsePath = json.path;
    currentEl.textContent = json.path || 'Wybierz dysk';

    const rows = [];
    if (json.path !== null) {
      const isDriveRoot = json.parent === null;
      const upTarget = isDriveRoot ? '' : json.parent;
      rows.push(`<div class="folder-row clickable up-nav" data-path="${escapeHtml(upTarget)}">${isDriveRoot ? '⬆ Lista dysków' : '⬆ ..'}</div>`);
    }
    for (const entry of json.entries) {
      rows.push(`<div class="folder-row clickable" data-path="${escapeHtml(entry.path)}">📁 ${escapeHtml(entry.name)}</div>`);
    }
    listEl.innerHTML = rows.join('') || '<div class="folder-row">Brak podfolderów.</div>';
  } catch (error) {
    listEl.innerHTML = `<div class="folder-row">${escapeHtml(String(error.message || error))}</div>`;
  }
}

document.querySelector('#folderBrowseList').addEventListener('click', (event) => {
  const row = event.target.closest('[data-path]');
  if (!row) return;
  loadFolderBrowse(row.dataset.path);
});

document.querySelector('#folderBrowseSelect').addEventListener('click', () => {
  if (!currentBrowsePath || !browseTargetInput) return;
  browseTargetInput.value = currentBrowsePath;
  closeFolderBrowser();
  // Odpala ten sam listener co reczne wpisanie sciezki (ponizej) - jesli
  // plik Excela jest juz wybrany, podglad odswiezy sie automatycznie.
  browseTargetInput.dispatchEvent(new Event('change'));
});

document.querySelector('#excelFile').addEventListener('change', () => maybeLoadPreview());
document.querySelector('#investmentFolder').addEventListener('change', () => maybeLoadPreview());
document.querySelector('#investmentFolder').addEventListener('blur', () => maybeLoadPreview());

// ---- Drugi tryb: "same foldery z adresow" (2026-08-28) ----------------------

let simpleSheets = null;

function currentMode() {
  const checked = document.querySelector('input[name="tfMode"]:checked');
  return checked ? checked.value : 'structure';
}

document.querySelectorAll('input[name="tfMode"]').forEach(radio => {
  radio.addEventListener('change', () => {
    simpleSheets = null;
    const simple = currentMode() === 'simple';
    document.querySelector('#pathHelp').textContent = simple
      ? 'Folder docelowy musi JUŻ istnieć i być PUSTY - w środku powstaną same foldery z adresami.'
      : 'Folder, w którym leży już skrót .gsheet do tabeli adresowej tej inwestycji.';
    document.querySelector('#investmentFolder').placeholder = simple
      ? 'np. G:\\Dyski współdzielone\\INWESTYCJE_3\\WIERZCHLAS 2026 - PV\\Wierzchlas_adresy_druk_powykonawcza'
      : 'np. G:\\Dyski współdzielone\\Dział Projektowy Sanitarny\\...\\17. Kamieńsk';
    document.querySelector('#simpleSheetBox').classList.toggle('hidden', !simple);
    resetPlanUi();
    maybeLoadPreview();
  });
});

document.querySelector('#simpleSheet').addEventListener('change', () => {
  const select = document.querySelector('#simpleSheet');
  document.querySelector('#createBtn').disabled = !select.value;
});

async function loadSimplePreview() {
  const file = currentFile();
  if (!file) return;
  if (isGoogleSheetShortcut(file)) { showTopNotice('Wybrano plik .gsheet - wyeksportuj go do .xlsx i wybierz pobrany plik.'); return; }
  if (!isRealExcelFile(file)) { showTopNotice('Wybrany plik nie jest Excelem. Wybierz plik z końcówką .xlsx.'); return; }
  const data = new FormData();
  data.append('excel', file);
  try {
    const res = await fetch('/api/simple-preview', { method: 'POST', headers: { 'X-Scyzoryk-Request': '1' }, body: data });
    const json = await res.json().catch(() => null);
    if (!json || !json.ok) { showTopNotice(json?.error || 'Nie udało się wczytać arkuszy.'); return; }
    simpleSheets = json;
    const select = document.querySelector('#simpleSheet');
    select.innerHTML = json.sheets.map(s =>
      `<option value="${escapeHtml(s.sheetName)}"${s.sheetName === json.defaultSheet ? ' selected' : ''}>${escapeHtml(s.sheetName)}${s.headerFound ? ` (${s.addressCount} adresów)` : ' - brak kolumny Adres'}</option>`
    ).join('');
    document.querySelector('#simpleSheetBox').classList.remove('hidden');
    const summary = document.querySelector('#sheetSummary');
    summary.classList.remove('hidden');
    summary.innerHTML = `<div class="sheet-pill">Tryb "same foldery z adresów": wybierz arkusz, wskaż PUSTY folder docelowy i kliknij "Utwórz foldery".</div>`;
    document.querySelector('#createBtn').disabled = !select.value;
  } catch (error) {
    showTopNotice(String(error.message || error));
  }
}

function currentFile() {
  const input = document.querySelector('#excelFile');
  return input.files && input.files[0];
}

function isGoogleSheetShortcut(file) {
  return String(file?.name || '').toLowerCase().endsWith('.gsheet');
}

function isRealExcelFile(file) {
  return /\.xlsx$/i.test(String(file?.name || ''));
}

function hideTopNotice() {
  document.querySelector('#topNotice').classList.add('hidden');
}

function showTopNotice(message, tone = '') {
  const el = document.querySelector('#topNotice');
  el.textContent = message;
  el.className = `panel notice ${tone}`.trim();
  // Formularz jest nizej strony - bez tego komunikat (glownie blad walidacji)
  // zostawal poza ekranem i uzytkownik nie widzial, co poprawic.
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function resetPlanUi() {
  lastPlan = null;
  document.querySelector('#sheetSummary').classList.add('hidden');
  document.querySelector('#sheetSummary').innerHTML = '';
  document.querySelector('#planBox').classList.add('hidden');
  document.querySelector('#folderTree').innerHTML = '';
  const createBtn = document.querySelector('#createBtn');
  createBtn.disabled = true;
  // Audyt UX 2026-08-21: bez tego przycisk zostawal na "Gotowe ✓" nawet po
  // wczytaniu nowego, poprawnego planu - wygladalo to jak "juz zrobione",
  // mimo ze klikniecie znow realnie tworzyloby foldery.
  createBtn.textContent = 'Utwórz foldery';
}

async function maybeLoadPreview() {
  hideTopNotice();
  resetPlanUi();
  const investmentFolder = document.querySelector('#investmentFolder').value.trim();
  const file = currentFile();
  if (!file) return;
  if (currentMode() === 'simple') return loadSimplePreview();
  if (!investmentFolder) return;

  if (isGoogleSheetShortcut(file)) {
    showTopNotice('Wybrano plik .gsheet, czyli skrót do Google Sheets, a nie prawdziwy Excel. Otwórz ten arkusz w Google Sheets i wybierz: Plik → Pobierz → Microsoft Excel (.xlsx), a potem wskaż pobrany plik .xlsx.');
    return;
  }
  if (!isRealExcelFile(file)) {
    showTopNotice('Wybrany plik nie jest Excelem. Wybierz plik z końcówką .xlsx.');
    return;
  }

  const data = new FormData();
  data.append('excel', file);
  data.append('investmentFolder', investmentFolder);

  try {
    const res = await fetch('/api/preview', { method: 'POST', headers: { 'X-Scyzoryk-Request': '1' }, body: data });
    const json = await res.json().catch(() => null);
    if (!json || !json.ok) {
      showTopNotice(json?.error || 'Nie udało się sprawdzić folderu inwestycji.');
      return;
    }
    lastPlan = json;
    renderPlan(json);
    document.querySelector('#createBtn').disabled = json.toCreate === 0;
  } catch (error) {
    const message = String(error.message || error) === 'Failed to fetch'
      ? 'Nie udało się połączyć z aplikacją. Sprawdź, czy Scyzoryk nadal jest uruchomiony.'
      : String(error.message || error);
    showTopNotice(message);
  }
}

function sheetTypeLabel(type) {
  return { pompy: 'Pompy', kolektory: 'Kolektory', kotly: 'Kotły' }[type] || type;
}

function renderPlan(json) {
  const summaryEl = document.querySelector('#sheetSummary');
  if (json.sheets.length === 0) {
    summaryEl.classList.remove('hidden');
    summaryEl.innerHTML = '<div class="sheet-pill">Nie znaleziono w pliku żadnego arkusza pompy/kolektory/kotły - powstanie tylko folder <code>WM</code>.</div>';
  } else {
    summaryEl.classList.remove('hidden');
    summaryEl.innerHTML = json.sheets.map(sheet => {
      const parts = [`<strong>${escapeHtml(sheet.recordCount)}</strong> adresów`];
      if (sheet.type === 'pompy') parts.push(`${escapeHtml(sheet.gruntCount)} gruntowych, ${escapeHtml(sheet.powietrznaCount)} powietrznych`);
      if (sheet.gminaColumnPresent) parts.push('wiele gmin');
      return `<div class="sheet-pill">${escapeHtml(sheetTypeLabel(sheet.type))} (arkusz "${escapeHtml(sheet.sheetName)}"): ${parts.join(' · ')}</div>`;
    }).join('');
  }

  const treeEl = document.querySelector('#folderTree');
  treeEl.innerHTML = json.folders.map(folder => {
    const status = folder.exists ? '<span class="badge skip">już istnieje</span>' : '<span class="badge ok">nowy</span>';
    return `<div class="folder-row ${folder.exists ? 'exists' : ''}">${escapeHtml(folder.relativePath)} ${status}</div>`;
  }).join('');

  document.querySelector('#planInfo').textContent = `Do utworzenia: ${json.toCreate} · już istnieje: ${json.alreadyExisting} · razem: ${json.folders.length}`;
  document.querySelector('#planBox').classList.remove('hidden');
}

document.querySelector('#planForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const file = currentFile();
  if (!file) return;
  if (currentMode() === 'simple') return submitSimple(file);

  if (!lastPlan) return;
  const investmentFolder = document.querySelector('#investmentFolder').value.trim();
  if (!investmentFolder) return;

  if (!confirm(`Utworzyć ${lastPlan.toCreate} folderów w:\n${investmentFolder}\n\nJuż istniejące foldery zostaną pominięte, nic nie zostanie nadpisane.`)) return;

  const btn = document.querySelector('#createBtn');
  btn.disabled = true;
  btn.textContent = 'Tworzę...';

  const data = new FormData();
  data.append('excel', file);
  data.append('investmentFolder', investmentFolder);

  try {
    const res = await fetch('/api/create', { method: 'POST', headers: { 'X-Scyzoryk-Request': '1' }, body: data });
    const json = await res.json().catch(() => null);
    if (!json || !json.ok) {
      showTopNotice(json?.error || 'Nie udało się utworzyć folderów.');
      btn.disabled = false;
      btn.textContent = 'Utwórz foldery';
      return;
    }
    document.querySelector('#resultBox').classList.remove('hidden');
    document.querySelector('#resultInfo').innerHTML =
      `Utworzono <strong>${json.created.length}</strong> nowych folderów w <code>${escapeHtml(json.investmentFolder)}</code>` +
      (json.alreadyExisted.length ? ` (${json.alreadyExisted.length} już istniało, pominięto).` : '.');
    document.querySelector('#resultBox').scrollIntoView({ behavior: 'smooth', block: 'start' });
    btn.textContent = 'Gotowe ✓';
  } catch (error) {
    showTopNotice(String(error.message || error));
    btn.disabled = false;
    btn.textContent = 'Utwórz foldery';
  }
});

async function submitSimple(file) {
  const targetFolder = document.querySelector('#investmentFolder').value.trim();
  const sheetName = document.querySelector('#simpleSheet').value;
  if (!targetFolder) return showTopNotice('Podaj ścieżkę do folderu docelowego (musi być pusty).');
  if (!sheetName) return showTopNotice('Wybierz arkusz z adresami.');

  if (!confirm(`Utworzyć foldery z adresów arkusza "${sheetName}" w:\n${targetFolder}\n\nFolder docelowy musi być pusty - jeśli coś już w nim jest, operacja zostanie odrzucona.`)) return;

  const btn = document.querySelector('#createBtn');
  btn.disabled = true;
  btn.textContent = 'Tworzę...';

  const data = new FormData();
  data.append('excel', file);
  data.append('targetFolder', targetFolder);
  data.append('sheetName', sheetName);

  try {
    const res = await fetch('/api/simple-create', { method: 'POST', headers: { 'X-Scyzoryk-Request': '1' }, body: data });
    const json = await res.json().catch(() => null);
    if (!json || !json.ok) {
      showTopNotice(json?.error || 'Nie udało się utworzyć folderów.');
      btn.disabled = false;
      btn.textContent = 'Utwórz foldery';
      return;
    }
    const extras = [];
    if (json.duplicates) extras.push(`${json.duplicates} duplikatów pominięto`);
    if (json.skippedEmpty) extras.push(`${json.skippedEmpty} pustych wierszy pominięto`);
    document.querySelector('#resultBox').classList.remove('hidden');
    document.querySelector('#resultInfo').innerHTML =
      `Utworzono <strong>${json.created.length}</strong> folderów z adresów (arkusz "${escapeHtml(json.sheetName)}") w <code>${escapeHtml(json.targetFolder)}</code>` +
      (extras.length ? ` <br><span class="small">${escapeHtml(extras.join(' · '))}.</span>` : '.');
    document.querySelector('#resultBox').scrollIntoView({ behavior: 'smooth', block: 'start' });
    btn.textContent = 'Gotowe ✓';
  } catch (error) {
    showTopNotice(String(error.message || error));
    btn.disabled = false;
    btn.textContent = 'Utwórz foldery';
  }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[ch]));
}
