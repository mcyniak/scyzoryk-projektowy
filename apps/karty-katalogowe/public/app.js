const STATUS_LABELS = {
  'skopiowano': ['Skopiowano', 'ok'],
  'do-skopiowania': ['Do skopiowania', 'ok'],
  'pominieto-juz-sa': ['Już są', 'skip'],
  'pominieto-rezygnacja': ['Rezygnacja', 'skip'],
  'pominieto-brak-uid': ['Brak UID', 'skip'],
  // "brak"/"wieloznaczne" normalnie wystepuja tylko w kolumnach dodatkow
  // (DODATEK_STATUS_LABELS ponizej), ale w trybach "tylko dodatek" (Dodaj
  // audyty/schematy/dokumenty seryjne) staja sie WPROST statusem calego
  // wiersza (patrz server.js#przetworzArkusz, galaz pominKarty).
  'brak': ['Brak', 'warn'],
  'wieloznaczne': ['Niejednoznaczne', 'warn'],
  // Audyt rozdz. 16, P1: kopiowanie jest teraz komplet-albo-nic (patrz
  // server.js#przetworzArkusz FAZA B) - stan "czesciowo" nie moze juz
  // wystapic, usuniety stad.
  'blad': ['Błąd', 'err']
};

// Statusy dodatkow (audyt/schemat/dokument seryjny) - osobna mapa od
// STATUS_LABELS (kart katalogowych), bo maja dwa stany bez odpowiednika tam:
// "brak" (zrodlo podane, ale nic nie pasuje do tego adresu/mocy - normalne,
// nie kazdy adres ma juz gotowy audyt) i "wieloznaczne" (kilka plikow pasuje
// naraz - nigdy nie zgadujemy, ktory jest wlasciwy).
const DODATEK_STATUS_LABELS = {
  'skopiowano': ['Skopiowano', 'ok'],
  'do-skopiowania': ['Do skopiowania', 'ok'],
  'pominieto-juz-sa': ['Już jest', 'skip'],
  'brak': ['Brak', 'warn'],
  'wieloznaczne': ['Niejednoznaczne', 'warn'],
  'blad': ['Błąd', 'err']
};
function renderDodatek(dodatek) {
  if (!dodatek) return ''; // zrodlo nie zostalo podane dla tego uruchomienia
  const [label, cls] = DODATEK_STATUS_LABELS[dodatek.status] || [dodatek.status, 'skip'];
  const szczegol = dodatek.plik || (dodatek.kandydaci ? dodatek.kandydaci.join(', ') : '');
  const title = szczegol ? ` title="${escapeHtml(szczegol)}"` : '';
  return `<span class="kk-badge ${cls}"${title}>${label}</span>`;
}

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
    desc: 'Solary: program sam znajdzie w środku folder „karty” albo „wzór” (źródłowe PDF-y) oraz „Projekty\\{gmina}\\{id} - adres” (bez gminy, jeśli w arkuszu nie ma osobnej kolumny gminy).',
    rootPathLabel: 'Ścieżka do głównego folderu (zawiera „karty”/„wzór” i „Projekty”)',
    placeholder: 'G:\\Dyski współdzielone\\Dział Projektowy Sanitarny\\6. Paradyż Żarnów\\Kolektory'
  },
  pompy: {
    desc: 'Pompy powietrzne Varmero: program sam znajdzie „PC powietrzne\\wzór\\{model}\\Karty katalogowe.pdf” oraz „PC powietrzne\\Projekty\\{id} - adres”. Kolumna „Model pompy”.',
    rootPathLabel: 'Ścieżka do głównego folderu INWESTYCJI (zawiera podfolder „PC powietrzne”)',
    placeholder: 'G:\\Dyski współdzielone\\Dział Projektowy Sanitarny\\20. Zagórów'
  },
  // Te trzy tryby NIE dobieraja/kopiuja kart katalogowych w ogole - kazdy
  // dodaje TYLKO swoj jeden rodzaj pliku do folderu klienta, wg tego samego
  // arkusza co tryb Solary powyzej (adres/moc zestawu). Osobne opcje zamiast
  // jednego wspolnego formularza z 3 zipami naraz - wlasciciel chcial
  // dodawac kazdy dodatek osobno, tak jak wybiera sie Solary/Pompy.
  audyty: {
    desc: 'Dodaj audyty PV: dopasowuje pliki z audytami do adresu z wybranego arkusza i dokleja je do istniejących folderów klientów. Karty katalogowe NIE są w tym trybie dobierane.',
    rootPathLabel: 'Ścieżka do głównego folderu (zawiera „Projekty”)',
    placeholder: 'G:\\Dyski współdzielone\\Dział Projektowy Sanitarny\\6. Paradyż Żarnów\\Kolektory'
  },
  schematy: {
    desc: 'Dodaj schematy elektryczne: dopasowuje pliki schematów do mocy zestawu (i fazy, gdy trzeba) z wybranego arkusza i dokleja je do istniejących folderów klientów. Karty katalogowe NIE są w tym trybie dobierane.',
    rootPathLabel: 'Ścieżka do głównego folderu (zawiera „Projekty”)',
    placeholder: 'G:\\Dyski współdzielone\\Dział Projektowy Sanitarny\\6. Paradyż Żarnów\\Kolektory'
  },
  'dokumenty-seryjne': {
    desc: 'Dodaj dokumenty seryjne: dopasowuje pliki po adresie z wybranego arkusza i dokleja je do istniejących folderów klientów. Karty katalogowe NIE są w tym trybie dobierane.',
    rootPathLabel: 'Ścieżka do głównego folderu (zawiera „Projekty”)',
    placeholder: 'G:\\Dyski współdzielone\\Dział Projektowy Sanitarny\\6. Paradyż Żarnów\\Kolektory'
  }
};

// Sekcja z polem zip/sciezka pokazywana dla kazdego z 3 trybow "tylko dodatek" -
// null dla solary/pompy (te tryby nie maja wlasnej sekcji dodatku).
const DODATEK_SECTION_ID = {
  audyty: 'kkAudytySection',
  schematy: 'kkSchematySection',
  'dokumenty-seryjne': 'kkDokumentySeryjneSection'
};

function aktualnyRodzajKart() {
  return document.querySelector('input[name="kkMode"]:checked').value;
}

function odswiezOpisyRodzaju() {
  const tryb = aktualnyRodzajKart();
  const copy = MODE_COPY[tryb];
  document.getElementById('kkModeDesc').textContent = copy.desc;
  document.getElementById('kkRootPathLabel').textContent = copy.rootPathLabel;
  document.getElementById('rootPath').placeholder = copy.placeholder;
  // Dokladnie jedna z trzech sekcji dodatku widoczna naraz (albo zadna, dla
  // solary/pompy) - patrz DODATEK_SECTION_ID powyzej.
  for (const id of Object.values(DODATEK_SECTION_ID)) {
    document.getElementById(id).hidden = DODATEK_SECTION_ID[tryb] !== id;
  }
}

document.querySelectorAll('input[name="kkMode"]').forEach(el => el.addEventListener('change', odswiezOpisyRodzaju));
odswiezOpisyRodzaju();

// Wybor arkusza jest JAWNY (dodane 2026-08-19) - wczesniej program sam
// zgadywal, ktory arkusz dotyczy solarow/pomp po nazwie ("Solary <gmina>"),
// co nie dzialalo dla prawdziwej tabeli z arkuszem nazwanym np. "PV_".
// Lista arkuszy wczytuje sie od razu po wybraniu pliku Excel (osobne, lekkie
// wywolanie /api/sheets - plik jest tylko odczytany i skasowany, zaden dobor
// kart tu jeszcze nie zachodzi), PRZED wyborem rodzaju.
const sheetBox = document.getElementById('kkSheetBox');
const sheetSelect = document.getElementById('sheetSelect');
const sheetHint = document.getElementById('kkSheetHint');

document.getElementById('excelFile').addEventListener('change', async (event) => {
  const file = event.target.files[0];
  sheetBox.hidden = true;
  sheetSelect.innerHTML = '';
  if (!file) { sheetHint.textContent = 'Wybierz plik, żeby wczytać listę arkuszy.'; return; }

  sheetHint.textContent = 'Wczytuję listę arkuszy...';
  const formData = new FormData();
  formData.append('excel', file);
  try {
    const resp = await fetch('/api/sheets', { method: 'POST', body: formData, headers: { 'X-Scyzoryk-Request': '1' } });
    const data = await resp.json();
    if (!data.ok) throw new Error(data.message || 'Nie udało się wczytać arkuszy.');
    if (!data.sheets.length) throw new Error('Plik Excel nie ma żadnego arkusza.');
    sheetSelect.innerHTML = data.sheets.map(name => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join('');
    sheetBox.hidden = false;
    sheetHint.textContent = `Wczytano ${data.sheets.length} arkusz(y).`;
  } catch (err) {
    sheetHint.textContent = 'Błąd: ' + err.message;
  }
});

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
  if (sheetBox.hidden || !sheetSelect.value) { statusEl.className = 'err'; statusEl.textContent = 'Wybierz arkusz z listy (poczekaj, aż się wczyta po wybraniu pliku Excel).'; return; }
  if (!rootPath) { statusEl.className = 'err'; statusEl.textContent = 'Podaj ścieżkę do głównego folderu.'; return; }

  const tryb = aktualnyRodzajKart();
  const formData = new FormData();
  formData.append('excel', fileInput.files[0]);
  formData.append('sheetName', sheetSelect.value);
  formData.append('rootPath', rootPath);
  formData.append('typ', tryb);
  formData.append('dryRun', String(dryRun));

  // Kazdy tryb "tylko dodatek" wysyla WYLACZNIE swoj wlasny zip/sciezke -
  // nigdy wszystkie trzy naraz (to byl dawny, mylacy uklad, patrz komentarz
  // przy DODATEK_ZRODLA w server.js). Zip ma pierwszenstwo przed sciezka
  // (patrz rozstrzygnijZrodloDodatku w server.js) - wysylamy oba, jesli oba
  // sa wypelnione, backend sam wybiera.
  const DODATEK_POLA = {
    audyty: ['audytyZip', 'audytyPathInput', 'audytyPath'],
    schematy: ['schematyZip', 'schematyPathInput', 'schematyPath'],
    'dokumenty-seryjne': ['dokumentySeryjneZip', 'dokumentySeryjnePathInput', 'dokumentySeryjnePath']
  };
  if (DODATEK_POLA[tryb]) {
    const [zipField, pathInputId, pathField] = DODATEK_POLA[tryb];
    const zipInput = document.getElementById(`${zipField}Input`);
    if (zipInput && zipInput.files.length) formData.append(zipField, zipInput.files[0]);
    const pathValue = document.getElementById(pathInputId).value.trim();
    if (pathValue) formData.append(pathField, pathValue);
  }

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
        <td>${renderDodatek(w.audyt)}</td>
        <td>${renderDodatek(w.schemat)}</td>
        <td>${renderDodatek(w.dokumentSeryjny)}</td>
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
// Te same "Przegladaj..." dla audytow/schematow/dokumentow seryjnych -
// data-browse-target zamiast osobnego listenera per pole (3x powtorzony
// kod), bo mechanizm (jeden globalny browseTargetInput + modal) jest
// identyczny jak dla rootPath powyzej.
document.querySelectorAll('.kk-browse-btn[data-browse-target]').forEach(btn => {
  btn.addEventListener('click', () => {
    browseTargetInput = document.getElementById(btn.dataset.browseTarget);
    const startPath = browseTargetInput.value.trim();
    openFolderBrowser(startPath || null);
  });
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
