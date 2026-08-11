let lastPlan = null;

document.querySelector('#excelFile').addEventListener('change', () => maybeLoadPreview());
document.querySelector('#investmentFolder').addEventListener('change', () => maybeLoadPreview());
document.querySelector('#investmentFolder').addEventListener('blur', () => maybeLoadPreview());

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
}

function resetPlanUi() {
  lastPlan = null;
  document.querySelector('#sheetSummary').classList.add('hidden');
  document.querySelector('#sheetSummary').innerHTML = '';
  document.querySelector('#planBox').classList.add('hidden');
  document.querySelector('#folderTree').innerHTML = '';
  document.querySelector('#createBtn').disabled = true;
}

async function maybeLoadPreview() {
  hideTopNotice();
  resetPlanUi();
  const investmentFolder = document.querySelector('#investmentFolder').value.trim();
  const file = currentFile();
  if (!investmentFolder || !file) return;

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
  if (!lastPlan) return;

  const investmentFolder = document.querySelector('#investmentFolder').value.trim();
  const file = currentFile();
  if (!investmentFolder || !file) return;

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

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[ch]));
}
