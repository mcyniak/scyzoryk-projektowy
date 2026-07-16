const STATUS_LABELS = {
  'skopiowano': ['Skopiowano', 'ok'],
  'do-skopiowania': ['Do skopiowania', 'ok'],
  'pominieto-juz-sa': ['Już są', 'skip'],
  'pominieto-rezygnacja': ['Rezygnacja', 'skip'],
  'pominieto-brak-uid': ['Brak UID', 'skip'],
  'czesciowo': ['Częściowo', 'warn'],
  'blad': ['Błąd', 'err']
};

const runBtn = document.getElementById('runBtn');
const statusEl = document.getElementById('kkStatus');
const resultsPanel = document.getElementById('kkResultsPanel');
const tableBody = document.getElementById('kkTableBody');
const summaryEl = document.getElementById('kkSummary');
const rootPathLabel = document.getElementById('rootPathLabel');
const rootPathInput = document.getElementById('rootPath');
const excelFileInput = document.getElementById('excelFile');
const excelBrowseBtn = document.getElementById('excelBrowseBtn');
const excelDriveHint = document.getElementById('excelDriveHint');
const folderBrowseBtn = document.getElementById('folderBrowseBtn');

// Sciezka do pliku Excel/Arkusza Google wybranego przez przegladarke Dysku
// (zamiast wgrania recznie) - gdy ustawiona, /api/run-from-drive jest
// uzywane zamiast /api/run.
let selectedDriveFile = null;

function clearDriveFileSelection() {
  selectedDriveFile = null;
  excelDriveHint.hidden = true;
  excelDriveHint.textContent = '';
}

excelFileInput.addEventListener('change', () => {
  if (excelFileInput.files.length) clearDriveFileSelection();
});

// Etykieta pola sciezki i przyciski "Przegladaj"/"Wybierz z Dysku" zalezy od
// tego, czy serwer ma skonfigurowany SCYZORYK_PROJECTS_ROOT (pilot) - wtedy
// uzytkownik podaje sciezke WZGLEDEM Dysku Google, nie pelna sciezke
// systemowa, i moze przegladac Dysk zamiast pobierac/wgrywac pliki recznie.
(async function initRootPathLabel() {
  try {
    const resp = await fetch('/api/health', { cache: 'no-store' });
    const data = await resp.json();
    if (data.googleDrive) {
      rootPathLabel.textContent = 'Folder względem Dysku Projektów (zawiera podfoldery „karty” i „Projekty”)';
      rootPathInput.placeholder = '6. Paradyż Żarnów/Kolektory';
      folderBrowseBtn.hidden = false;
      excelBrowseBtn.hidden = false;
      if (!data.googleDrive.available) {
        statusEl.className = 'err';
        statusEl.textContent = 'Dysk Google jest obecnie niedostępny. Sprawdź połączenie internetowe lub usługę rclone.' + (data.googleDrive.reason ? ` (${data.googleDrive.reason})` : '');
      }
    }
  } catch (_) {
    // Brak polaczenia z wlasnym serwerem - zostaw domyslna etykiete.
  }
})();

folderBrowseBtn.addEventListener('click', () => {
  window.openDrivePicker({
    mode: 'folder',
    startPath: rootPathInput.value.trim() || '.',
    onSelect: (path) => { rootPathInput.value = path; }
  });
});

excelBrowseBtn.addEventListener('click', () => {
  window.openDrivePicker({
    mode: 'file',
    startPath: rootPathInput.value.trim() || '.',
    onSelect: (path) => {
      selectedDriveFile = path;
      excelFileInput.value = '';
      excelDriveHint.hidden = false;
      excelDriveHint.textContent = 'Wybrano z Dysku: ' + path;
    }
  });
});

runBtn.addEventListener('click', async () => {
  const rootPath = rootPathInput.value.trim();
  const dryRun = document.getElementById('dryRun').checked;

  statusEl.className = '';
  statusEl.textContent = '';

  if (!excelFileInput.files.length && !selectedDriveFile) { statusEl.className = 'err'; statusEl.textContent = 'Wybierz plik Excel (z komputera albo z Dysku).'; return; }
  if (!rootPath) { statusEl.className = 'err'; statusEl.textContent = 'Podaj ścieżkę do głównego folderu.'; return; }

  runBtn.disabled = true;
  statusEl.textContent = dryRun ? 'Analizuję (podgląd, bez kopiowania)...' : 'Kopiuję karty katalogowe...';

  try {
    let resp;
    if (selectedDriveFile) {
      resp = await fetch('/api/run-from-drive', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Scyzoryk-Request': '1' },
        body: JSON.stringify({ driveFilePath: selectedDriveFile, rootPath, dryRun: String(dryRun) })
      });
    } else {
      const formData = new FormData();
      formData.append('excel', excelFileInput.files[0]);
      formData.append('rootPath', rootPath);
      formData.append('dryRun', String(dryRun));
      resp = await fetch('/api/run', { method: 'POST', body: formData, headers: { 'X-Scyzoryk-Request': '1' } });
    }
    const data = await resp.json();
    if (!data.ok) throw new Error(data.message || 'Nieznany błąd.');

    statusEl.className = '';
    statusEl.textContent = `Gotowe. Przetworzono ${data.wyniki.length} wierszy.` + (dryRun ? ' (tryb podglądu — nic nie skopiowano)' : '');

    summaryEl.innerHTML = Object.entries(data.podsumowanie).map(([status, count]) => {
      const [label, cls] = STATUS_LABELS[status] || [status, 'skip'];
      return `<div class="kk-chip ${cls}"><strong>${count}</strong> — ${label}</div>`;
    }).join('');

    tableBody.innerHTML = data.wyniki.map(w => {
      const [label, cls] = STATUS_LABELS[w.status] || [w.status, 'skip'];
      return `<tr>
        <td>${w.gmina || ''}</td>
        <td>${w.id ?? ''}</td>
        <td>${w.adres || ''}</td>
        <td>${w.uid || ''}</td>
        <td>${w.folder || ''}</td>
        <td><span class="kk-badge ${cls}">${label}</span></td>
        <td>${w.komunikat || ''}</td>
      </tr>`;
    }).join('');

    resultsPanel.style.display = 'block';
  } catch (err) {
    statusEl.className = 'err';
    statusEl.textContent = 'Błąd: ' + err.message;
  } finally {
    runBtn.disabled = false;
  }
});
