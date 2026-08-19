const STATUS_LABELS = {
  'skopiowano': ['Skopiowano', 'ok'],
  'do-skopiowania': ['Do skopiowania', 'ok'],
  'pominieto-juz-sa': ['Już są', 'skip'],
  'pominieto-rezygnacja': ['Rezygnacja', 'skip'],
  'pominieto-brak-uid': ['Brak UID', 'skip'],
  // Audyt rozdz. 16, P1: kopiowanie jest teraz komplet-albo-nic (patrz
  // server.js#przetworzArkusz FAZA B) - stan "czesciowo" nie moze juz
  // wystapic, usuniety stad.
  'blad': ['Błąd', 'err']
};

const checkBtn = document.getElementById('checkBtn');
const runBtn = document.getElementById('runBtn');
const statusEl = document.getElementById('kkStatus');
const resultsPanel = document.getElementById('kkResultsPanel');
const tableBody = document.getElementById('kkTableBody');
const summaryEl = document.getElementById('kkSummary');

// Solary i pompy powietrzne Varmero maja INNA sciezke glownego folderu
// wzgledem tego samego "rootPath" (solary: folder z "karty"/"wzor" wprost w
// srodku, np. "...\Kolektory"; pompy: folder INWESTYCJI zawierajacy
// podfolder "PC powietrzne") - realny blad zlapany przez uzytkownika: bez
// jawnego wyboru rodzaju program probowal jednoczesnie doklejac "PC
// powietrzne" DO sciezki juz wskazujacej na "Kolektory", co nigdy nie moglo
// dzialac. Jawny wybor usuwa te niejednoznacznosc calkowicie - backend
// przetwarza WYLACZNIE arkusze pasujace do wybranego rodzaju.
const MODE_COPY = {
  solary: {
    desc: 'Solary: program sam znajdzie w środku folder „karty” albo „wzór” (źródłowe PDF-y) oraz „Projekty\\{gmina}\\{id} - adres” (bez gminy, jeśli arkusz nazywa się po prostu „Solary”). Arkusz w Excelu: „Solary” (z albo bez nazwy gminy).',
    excelLabel: 'Plik Excel (.xlsx) z arkuszem „Solary”',
    rootPathLabel: 'Ścieżka do głównego folderu (zawiera „karty”/„wzór” i „Projekty”)',
    placeholder: 'G:\\Dyski współdzielone\\Dział Projektowy Sanitarny\\6. Paradyż Żarnów\\Kolektory'
  },
  pompy: {
    desc: 'Pompy powietrzne Varmero: program sam znajdzie „PC powietrzne\\wzór\\{model}\\Karty katalogowe.pdf” oraz „PC powietrzne\\Projekty\\{id} - adres”. Arkusz w Excelu: „Pompy ciepła”, kolumna „Model pompy”.',
    excelLabel: 'Plik Excel (.xlsx) z arkuszem „Pompy ciepła”',
    rootPathLabel: 'Ścieżka do głównego folderu INWESTYCJI (zawiera podfolder „PC powietrzne”)',
    placeholder: 'G:\\Dyski współdzielone\\Dział Projektowy Sanitarny\\20. Zagórów'
  }
};

function aktualnyRodzajKart() {
  return document.querySelector('input[name="kkMode"]:checked').value;
}

function odswiezOpisyRodzaju() {
  const copy = MODE_COPY[aktualnyRodzajKart()];
  document.getElementById('kkModeDesc').textContent = copy.desc;
  document.getElementById('kkExcelLabel').textContent = copy.excelLabel;
  document.getElementById('kkRootPathLabel').textContent = copy.rootPathLabel;
  document.getElementById('rootPath').placeholder = copy.placeholder;
}

document.querySelectorAll('input[name="kkMode"]').forEach(el => el.addEventListener('change', odswiezOpisyRodzaju));
odswiezOpisyRodzaju();

// Dwa kroki zamiast checkboxa "tylko podglad": "Sprawdz tabele" zawsze
// najpierw analizuje bez kopiowania (dryRun=true); dopiero po tym pojawia
// sie "Uruchom dobor kart", ktory robi prawdziwe kopiowanie (dryRun=false)
// na tym samym pliku/sciezce.
async function runJob(dryRun) {
  const fileInput = document.getElementById('excelFile');
  const rootPath = document.getElementById('rootPath').value.trim();

  statusEl.className = '';
  statusEl.textContent = '';

  if (!fileInput.files.length) { statusEl.className = 'err'; statusEl.textContent = 'Wybierz plik Excel.'; return; }
  if (!rootPath) { statusEl.className = 'err'; statusEl.textContent = 'Podaj ścieżkę do głównego folderu.'; return; }

  const formData = new FormData();
  formData.append('excel', fileInput.files[0]);
  formData.append('rootPath', rootPath);
  formData.append('typ', aktualnyRodzajKart());
  formData.append('dryRun', String(dryRun));

  checkBtn.disabled = true;
  runBtn.disabled = true;
  statusEl.textContent = dryRun ? 'Sprawdzam tabelę (bez kopiowania)...' : 'Kopiuję karty katalogowe...';

  try {
    const resp = await fetch('/api/run', { method: 'POST', body: formData, headers: { 'X-Scyzoryk-Request': '1' } });
    const data = await resp.json();
    if (!data.ok) throw new Error(data.message || 'Nieznany błąd.');

    statusEl.className = '';
    statusEl.textContent = `Gotowe. Sprawdzono ${data.wyniki.length} wierszy.` + (dryRun ? ' (tryb podglądu — nic nie skopiowano)' : ' (skopiowano)');

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

    // Po udanym sprawdzeniu (podglad) pokaz przycisk do prawdziwego
    // kopiowania - dopiero teraz uzytkownik widzial co dokladnie sie stanie.
    if (dryRun) runBtn.hidden = false;
  } catch (err) {
    statusEl.className = 'err';
    statusEl.textContent = 'Błąd: ' + err.message;
  } finally {
    checkBtn.disabled = false;
    runBtn.disabled = false;
  }
}

checkBtn.addEventListener('click', () => runJob(true));
runBtn.addEventListener('click', () => runJob(false));

// Przegladarka folderow w stronie zamiast recznego wpisywania sciezki -
// natywne okno Windows nie dziala niezawodnie na tej maszynie, patrz
// lib/folderBrowse.js.
let browseTargetInput = null;
let currentBrowsePath = null;

const folderBrowseModal = document.getElementById('folderBrowseModal');
const folderBrowseList = document.getElementById('folderBrowseList');
const folderBrowseCurrentPath = document.getElementById('folderBrowseCurrentPath');

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function closeFolderBrowser() {
  folderBrowseModal.classList.remove('open');
}

async function openFolderBrowser(startPath) {
  folderBrowseModal.classList.add('open');
  await loadFolderBrowse(startPath);
}

async function loadFolderBrowse(targetPath) {
  folderBrowseList.innerHTML = '<div class="folder-row">Wczytuję...</div>';
  try {
    const url = targetPath ? `/api/browse-folder?path=${encodeURIComponent(targetPath)}` : '/api/browse-folder';
    const res = await fetch(url);
    const json = await res.json().catch(() => null);
    if (!json || !json.ok) {
      folderBrowseList.innerHTML = `<div class="folder-row">${escapeHtml((json && json.error) || 'Nie udało się wczytać folderów.')}</div>`;
      return;
    }
    currentBrowsePath = json.path;
    folderBrowseCurrentPath.textContent = json.path || 'Wybierz dysk';

    const rows = [];
    if (json.path !== null) {
      const isDriveRoot = json.parent === null;
      const upTarget = isDriveRoot ? '' : json.parent;
      rows.push(`<div class="folder-row clickable up-nav" data-path="${escapeHtml(upTarget)}">${isDriveRoot ? '⬆ Lista dysków' : '⬆ ..'}</div>`);
    }
    for (const entry of json.entries) {
      rows.push(`<div class="folder-row clickable" data-path="${escapeHtml(entry.path)}">📁 ${escapeHtml(entry.name)}</div>`);
    }
    folderBrowseList.innerHTML = rows.join('') || '<div class="folder-row">Brak podfolderów.</div>';
  } catch (error) {
    folderBrowseList.innerHTML = `<div class="folder-row">${escapeHtml(String(error.message || error))}</div>`;
  }
}

document.getElementById('browseFolderBtn').addEventListener('click', () => {
  browseTargetInput = document.getElementById('rootPath');
  const startPath = browseTargetInput.value.trim();
  openFolderBrowser(startPath || null);
});
document.getElementById('folderBrowseClose').addEventListener('click', closeFolderBrowser);
folderBrowseModal.addEventListener('click', (event) => {
  if (event.target.id === 'folderBrowseModal') closeFolderBrowser();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && folderBrowseModal.classList.contains('open')) closeFolderBrowser();
});
folderBrowseList.addEventListener('click', (event) => {
  const row = event.target.closest('[data-path]');
  if (!row) return;
  loadFolderBrowse(row.dataset.path);
});
document.getElementById('folderBrowseSelect').addEventListener('click', () => {
  if (!currentBrowsePath || !browseTargetInput) return;
  browseTargetInput.value = currentBrowsePath;
  closeFolderBrowser();
});
