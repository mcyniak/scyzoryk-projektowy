const P = (n, a, b, c) => window.ScyzorykUI ? window.ScyzorykUI.plural(n, a, b, c) : `${n} ${c}`;
let activeJob = null;
let pollTimer = null;
let cancelRequested = false;
let previewRecords = [];
let selectedRows = new Set();
let currentPdfDir = null;
let currentPdfJobId = null;
let autoOpenedForJob = null;
let currentBrowsePath = null;

// Zlapane realnie przez wlasciciela: Windows na tej maszynie skutecznie
// blokuje wymuszenie okna Eksploratora na pierwszy plan z procesu w tle
// (przetestowane NA ZYWO dwa rozne obejscia - zadne nie zadzialalo -
// patrz scripts/open-folder.ps1) - wlasciciel klikal przycisk ~20 razy, bo
// nie widzial zadnego potwierdzenia. Zamiast dalej walczyc z Windows,
// GLOWNYM potwierdzeniem jest jawny komunikat na stronie (nie samo okno) -
// dziala niezaleznie od tego, czy system odda fokus.
async function openPdfFolder(jobId, { showConfirmation = true } = {}) {
  if (!jobId) return;
  try {
    await fetch(`/api/batch/open-folder/${jobId}`, { method: 'POST', headers: { 'X-Scyzoryk-Request': '1' } });
  } catch (error) {
    console.error(error);
  }
  if (showConfirmation) confirmFolderOpened();
}

function confirmFolderOpened() {
  const notice = document.querySelector('#openPdfFolderNotice');
  notice.textContent = '✓ Otworzono folder - jeśli nie widzisz okna, sprawdź pasek zadań (Windows czasem otwiera je w tle).';
  notice.classList.remove('hidden');
  clearTimeout(confirmFolderOpened._timer);
  confirmFolderOpened._timer = setTimeout(() => notice.classList.add('hidden'), 6000);
}

document.querySelector('#openPdfFolder').addEventListener('click', async () => {
  const btn = document.querySelector('#openPdfFolder');
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Otwieram...';
  await openPdfFolder(currentPdfJobId);
  btn.textContent = original;
  btn.disabled = false;
});

loadSettings();

// Wojewodztwa NIE pokrywaja sie z granicami stref klimatycznych (np.
// Podkarpackie ma zarowno nizinna strefe III jak i gorska V - patrz
// usuniete tej samej sesji src/gminaZones.js, ktore probowalo to zrobic
// precyzyjnie po gminie i i tak wymagalo recznej weryfikacji) - ponizsza
// tabela jest wiec CELOWO tylko orientacyjna podpowiedz (najbardziej typowa
// strefa dla wiekszosci obszaru danego wojewodztwa), NIGDY nie jest cichym,
// ostatecznym rozstrzygnieciem. Pole strefy zostaje zawsze widoczne i w
// pelni edytowalne - podpowiedz nadpisuje je TYLKO dopoki uzytkownik sam
// go nie dotknie (patrz zoneTouchedManually nizej).
const DEFAULT_ZONE_BY_WOJEWODZTWO = {
  'Zachodniopomorskie': '2',
  'Pomorskie': '2',
  'Lubuskie': '2',
  'Dolnośląskie': '3',
  'Wielkopolskie': '3',
  'Kujawsko-pomorskie': '3',
  'Łódzkie': '3',
  'Mazowieckie': '3',
  'Opolskie': '3',
  'Śląskie': '3',
  'Świętokrzyskie': '3',
  'Małopolskie': '4',
  'Lubelskie': '4',
  'Podkarpackie': '4',
  'Warmińsko-mazurskie': '4',
  'Podlaskie': '4'
};
let zoneTouchedManually = false;
document.querySelector('#zone').addEventListener('change', () => { zoneTouchedManually = true; });
document.querySelector('#wojewodztwo').addEventListener('change', (event) => {
  if (zoneTouchedManually) return;
  const suggested = DEFAULT_ZONE_BY_WOJEWODZTWO[event.currentTarget.value];
  if (suggested) document.querySelector('#zone').value = suggested;
});

// Sprawdzanie adresow odpala sie automatycznie po wybraniu pliku (bez
// osobnego przycisku "Sprawdz adresy") - decyzja wlasciciela dla tej appki,
// swiadomie inna niz formularze-ecodan/karty-katalogowe: tam auto-check na
// 'change' pliku byl celowo pominiety, ale te apki wymagaja wypelnienia
// pol (np. lokalizacji) PRZED sprawdzeniem, zeby wynik mial sens - w
// varmero wszystkie pola strefy/wojewodztwa/gminy sa opcjonalne dla samego
// podgladu (tylko ostrzegaja, nigdy nie blokuja), wiec auto-check od razu
// po wyborze pliku nie traci danych.
// Audyt UX 2026-08-21: brak konfiguracji skrzynki wczesniej wychodzil na jaw
// dopiero po kliknieciu "Uruchom zgloszenia" (ostatni krok, po wgraniu
// Excela i wypelnieniu wszystkich pol) - sprawdzamy to od razu po
// zaladowaniu strony, zeby uzytkownik nie stracil czasu na przygotowanie
// calej paczki tylko po to, zeby na koncu dostac ten sam blad.
// Od 1.4.0 brak konfiguracji NIE jest juz slepym zaulkiem ("zglos do
// administratora") - ten sam ekran pozwala ja od razu uzupelnic, dokladnie jak
// klucz API w OCR audytow. Panel otwiera sie sam tylko wtedy, gdy skrzynki
// naprawde nie ma; skonfigurowana skrzynka schodzi do dyskretnej notki w
// naglowku, zeby nie zabierac miejsca na glownym przeplywie.
function renderMailboxStatus(status) {
  const note = document.querySelector('#mailboxActiveNote');
  const envNotice = document.querySelector('#mailboxEnvNotice');
  const form = document.querySelector('#mailboxForm');
  const cancelBtn = document.querySelector('#mailboxCancelBtn');

  if (status?.configured) {
    note.hidden = false;
    note.textContent = `Karty przyjdą na: ${status.user}`;
    cancelBtn.hidden = false;
    hideImapNotice();
  } else {
    note.hidden = true;
    note.textContent = '';
    cancelBtn.hidden = true;
  }

  // Zmienna srodowiskowa przebija plik (patrz src/mailboxConfig.js), wiec
  // zostawienie klikalnego formularza bylby klamstwem - zapis by sie udal, a
  // narzedzie i tak uzywaloby dalej wartosci ze srodowiska.
  const lockedByEnv = status?.source === 'env';
  envNotice.hidden = !lockedByEnv;
  Array.from(form.elements).forEach(el => { el.disabled = lockedByEnv; });

  if (status?.configured) {
    document.querySelector('#mailboxUser').value = status.user || '';
    document.querySelector('#mailboxHost').value = status.host || 'imap.gmail.com';
    document.querySelector('#mailboxPort').value = status.port || 993;
  }
}

function setMailboxPanelOpen(open) {
  document.querySelector('#mailboxPanel').hidden = !open;
  if (open) document.querySelector('#mailboxPanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function refreshMailboxStatus({ openIfMissing = false } = {}) {
  try {
    const res = await fetch('/api/mailbox-status');
    const json = await res.json().catch(() => null);
    if (!json?.ok) return null;
    renderMailboxStatus(json);
    if (json.configured === false) {
      showImapNotice('Skrzynka pocztowa do odbioru kart Varmero nie jest jeszcze skonfigurowana na tym komputerze - uzupełnij ją poniżej, zanim uruchomisz zgłoszenia.');
      if (openIfMissing) setMailboxPanelOpen(true);
    }
    return json;
  } catch (_) {
    // brak polaczenia - blad i tak wyjdzie na jaw przy starcie paczki
    return null;
  }
}

refreshMailboxStatus({ openIfMissing: true });

document.querySelector('#mailboxSettingsBtn').addEventListener('click', () => {
  const panel = document.querySelector('#mailboxPanel');
  setMailboxPanelOpen(panel.hidden);
});

document.querySelector('#mailboxCancelBtn').addEventListener('click', () => {
  document.querySelector('#mailboxStatus').textContent = '';
  document.querySelector('#mailboxStatus').className = '';
  document.querySelector('#mailboxForceSaveBtn').hidden = true;
  setMailboxPanelOpen(false);
});

async function submitMailboxConfig(force) {
  const statusEl = document.querySelector('#mailboxStatus');
  const saveBtn = document.querySelector('#mailboxSaveBtn');
  const forceBtn = document.querySelector('#mailboxForceSaveBtn');
  const body = {
    user: document.querySelector('#mailboxUser').value.trim(),
    password: document.querySelector('#mailboxPassword').value,
    host: document.querySelector('#mailboxHost').value.trim(),
    port: Number(document.querySelector('#mailboxPort').value) || 993,
    force: force === true
  };

  saveBtn.disabled = true;
  forceBtn.disabled = true;
  statusEl.className = '';
  statusEl.textContent = force ? 'Zapisuję bez sprawdzenia...' : 'Sprawdzam logowanie do skrzynki...';
  try {
    const res = await fetch('/api/mailbox-config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Scyzoryk-Request': '1' },
      body: JSON.stringify(body)
    });
    const json = await res.json().catch(() => null);
    if (!json?.ok) {
      // canForce oznacza "dane wygladaja poprawnie, ale nie udalo sie
      // zalogowac" - np. chwilowy brak internetu. Blad walidacji (zly adres)
      // go NIE ustawia, bo tam zapis na sile niczego by nie naprawil.
      forceBtn.hidden = json?.canForce !== true;
      throw new Error(json?.error || 'Nie udało się zapisać ustawień skrzynki.');
    }
    statusEl.className = 'ok';
    statusEl.textContent = json.verified
      ? 'Gotowe - zalogowano do skrzynki i zapisano ustawienia.'
      : 'Zapisano BEZ sprawdzenia logowania. Jeśli hasło jest błędne, zgłoszenia wyjdą, ale karty nie zostaną odebrane.';
    forceBtn.hidden = true;
    document.querySelector('#mailboxPassword').value = '';
    renderMailboxStatus(json);
    hideImapNotice();
  } catch (err) {
    statusEl.className = 'err';
    statusEl.textContent = err.message || 'Nie udało się zapisać ustawień skrzynki.';
  } finally {
    saveBtn.disabled = false;
    forceBtn.disabled = false;
  }
}

document.querySelector('#mailboxForm').addEventListener('submit', (event) => {
  event.preventDefault();
  submitMailboxConfig(false);
});

document.querySelector('#mailboxForceSaveBtn').addEventListener('click', () => submitMailboxConfig(true));

document.querySelector('#excelFile').addEventListener('change', () => loadAddressPreview());
document.querySelector('#reloadPreview').addEventListener('click', () => loadAddressPreview());
document.querySelector('#addressSearch').addEventListener('input', () => renderAddressRows());
// Audyt UX 2026-08-24: dwa osobne przyciski "Zaznacz wszystkie"/"Odznacz
// wszystkie" zamienione na jeden checkbox w naglowku tabeli - ten sam wzorzec
// co formularze-ecodan/inline-1.js (wlasciciel zglosil, ze uzytkownik ma za
// duzo przyciskow naraz). Dziala TYLKO na aktualnie widocznych (po filtrze
// "#addressSearch") wierszach - audyt 2026-08-21, wczesniej dzialalo na calym
// previewRecords, wiec po przefiltrowaniu klikniecie "zaznacz wszystkie" po
// cichu zaznaczalo tez adresy spoza filtra.
document.querySelector('#recordCheckAll').addEventListener('change', (event) => {
  const checked = event.target.checked;
  filteredPreviewRecords().forEach(row => { if (checked) selectedRows.add(row.rowNumber); else selectedRows.delete(row.rowNumber); });
  renderAddressRows();
});
document.querySelector('#browseOutputFolder')?.addEventListener('click', () => {
  openFolderBrowser(document.querySelector('#outputPath').value.trim() || null);
});
document.querySelector('#folderBrowseClose')?.addEventListener('click', closeFolderBrowser);
document.querySelector('#folderBrowseModal')?.addEventListener('click', (event) => {
  if (event.target.id === 'folderBrowseModal') closeFolderBrowser();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && document.querySelector('#folderBrowseModal')?.classList.contains('open')) closeFolderBrowser();
});
document.querySelector('#folderBrowseList')?.addEventListener('click', (event) => {
  const row = event.target.closest('[data-path]');
  if (!row) return;
  loadFolderBrowse(row.dataset.path);
});
document.querySelector('#folderBrowseSelect')?.addEventListener('click', () => {
  if (!currentBrowsePath) return;
  document.querySelector('#outputPath').value = currentBrowsePath;
  closeFolderBrowser();
});
document.querySelector('#addressRows').addEventListener('click', (event) => {
  const row = event.target.closest('[data-row-number]');
  if (!row) return;
  const rowNumber = Number(row.dataset.rowNumber);
  if (!Number.isInteger(rowNumber)) return;
  if (event.target.matches('input[type="checkbox"]')) {
    if (event.target.checked) selectedRows.add(rowNumber); else selectedRows.delete(rowNumber);
  } else {
    if (selectedRows.has(rowNumber)) selectedRows.delete(rowNumber); else selectedRows.add(rowNumber);
  }
  renderAddressRows();
});

document.querySelector('#batchForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  saveSettings();
  hideImapNotice();

  const file = document.querySelector('#excelFile').files && document.querySelector('#excelFile').files[0];
  const fileCheck = validateExcelChoice(file);
  if (!fileCheck.ok) {
    showAddressLoadProblem(fileCheck.message);
    showStartNotice(fileCheck.message);
    return;
  }
  // Puste pole strefy lapie natywna walidacja `required` na selekcie
  // (przegladarka pokazuje dymek PRZED odpaleniem submit handlera) - dawny
  // zapasowy alert() tu nie mial kiedy sie odpalic i zostal usuniety
  // (audyt UX 2026-08-24).

  const data = new FormData(form);
  data.set('concurrency', getFormField(form, 'concurrency').value || '1');
  data.set('outputPath', getFormField(form, 'outputPath').value || '');
  data.set('skipExisting', getFormField(form, 'skipExisting').checked ? 'true' : 'false');
  const chosenRows = previewRecords.length ? Array.from(selectedRows).sort((a, b) => a - b) : [];
  if (previewRecords.length && !chosenRows.length) {
    showStartNotice('Nie zaznaczono żadnego adresu. Zaznacz minimum jeden adres do zgłoszenia.');
    return;
  }
  data.set('selectedRows', JSON.stringify(chosenRows));
  document.querySelector('#selectedRowsInput').value = JSON.stringify(chosenRows);

  const countText = previewRecords.length ? P(chosenRows.length, 'wybranego adresu', 'wybranych adresów', 'wybranych adresów') : 'adresów z Excela';
  const where = [
    `gmina: ${getFormField(form, 'gminaName').value || '(brak)'}`,
    `kod: ${getFormField(form, 'postalCode').value || '(brak)'}`,
    `strefa: ${getFormField(form, 'zone').value || '(brak)'}`
  ].join(', ');
  hideStartNotice();
  if (!confirm(`Uruchomić zgłoszenia dla ${countText}?\n\nDane dla całej paczki - ${where}.\n\nKażdy wiersz to prawdziwe zgłoszenie do kalkulatora Varmero z oczekiwaniem na maila - może potrwać kilka minut na wiersz.`)) return;

  document.querySelector('#startBatch').disabled = true;
  cancelRequested = false;
  document.querySelector('#cancelBatch').disabled = false;
  document.querySelector('#cancelBatch').textContent = 'Przerwij zgłaszanie';
  document.querySelector('#statusBox').classList.remove('hidden');
  document.querySelector('#finishInfo').textContent = 'Zadanie jest w toku - każdy wiersz to prawdziwe zgłoszenie z oczekiwaniem na maila, może potrwać kilka minut na wiersz.';
  document.querySelector('#previewRows').innerHTML = '';
  document.querySelector('#openPdfFolder').classList.add('hidden');
  currentPdfDir = null;
  autoOpenedForJob = null;
  document.querySelector('#statusBox').scrollIntoView({ behavior: 'smooth', block: 'start' });

  let res = null;
  let json = null;
  try {
    res = await fetch('/api/batch/start', { method: 'POST', headers: { 'X-Scyzoryk-Request': '1' }, body: data });
    json = await res.json().catch(() => null);
  } catch (error) {
    json = { ok: false, error: window.ScyzorykUI ? window.ScyzorykUI.friendlyError(error) : String(error) };
  }
  if (!json || !json.ok) {
    const message = json?.error || 'Nie udało się uruchomić zadania.';
    if (/skrzynka pocztowa/i.test(message)) showImapNotice(message);
    else showStartNotice(message);
    if (json && json.activeJobId) attachToJob(json.activeJobId);
    document.querySelector('#startBatch').disabled = false;
    document.querySelector('#cancelBatch').disabled = true;
    document.querySelector('#statusBox').classList.add('hidden');
    return;
  }

  attachToJob(json.jobId);
});

// Komunikat pod przyciskiem Start (zamiast blokujacego alert()).
function showStartNotice(message) {
  let el = document.querySelector('#startNotice');
  if (!el) {
    el = document.createElement('div');
    el.id = 'startNotice';
    el.className = 'notice';
    el.setAttribute('role', 'alert');
    el.style.marginTop = '10px';
    document.querySelector('#startBatch').insertAdjacentElement('afterend', el);
  }
  el.textContent = message;
  el.classList.remove('hidden');
}
function hideStartNotice() {
  document.querySelector('#startNotice')?.classList.add('hidden');
}

// Podpina strone pod trwajace zadanie (po starcie albo po odswiezeniu
// strony w trakcie zglaszania - wczesniej po F5 zadanie bylo niewidoczne i
// mozna bylo uruchomic drugie, dublujac nieodwracalne zgloszenia).
function attachToJob(jobId) {
  activeJob = jobId;
  pollFailures = 0;
  document.querySelector('#startBatch').disabled = true;
  document.querySelector('#cancelBatch').disabled = false;
  document.querySelector('#statusBox').classList.remove('hidden');
  if (pollTimer) clearInterval(pollTimer);
  pollStatus();
  pollTimer = setInterval(pollStatus, 1500);
}
let pollFailures = 0;

(async function resumeRunningJob() {
  try {
    const res = await fetch('/api/batch/jobs');
    const json = await res.json();
    const running = (json.jobs || []).filter(j => ['queued', 'reading-excel', 'running', 'cancelling'].includes(j.status))
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0];
    if (running) {
      document.querySelector('#finishInfo').textContent = `Trwa zgłaszanie z pliku ${running.sourceFile || ''} - pokazuję jego postęp.`;
      attachToJob(running.id);
    }
  } catch { /* brak polaczenia - zwykly start strony */ }
})();

function closeFolderBrowser() {
  document.querySelector('#folderBrowseModal')?.classList.remove('open');
}

async function openFolderBrowser(startPath) {
  document.querySelector('#folderBrowseModal')?.classList.add('open');
  await loadFolderBrowse(startPath);
}

async function loadFolderBrowse(targetPath) {
  const list = document.querySelector('#folderBrowseList');
  const current = document.querySelector('#folderBrowseCurrentPath');
  if (!list || !current) return;
  list.innerHTML = '<div class="folder-row">Wczytuję...</div>';
  try {
    const url = targetPath ? `/api/browse-folder?path=${encodeURIComponent(targetPath)}` : '/api/browse-folder';
    const res = await fetch(url);
    const json = await res.json().catch(() => null);
    if (!json || !json.ok) {
      list.innerHTML = `<div class="folder-row">${escapeHtml((json && json.error) || 'Nie udało się wczytać folderów.')}</div>`;
      return;
    }
    currentBrowsePath = json.path;
    current.textContent = json.path || 'Wybierz dysk';

    const rows = [];
    if (json.path !== null) {
      const isDriveRoot = json.parent === null;
      const upTarget = isDriveRoot ? '' : json.parent;
      rows.push(`<div class="folder-row clickable up-nav" data-path="${escapeHtml(upTarget)}">${isDriveRoot ? 'Lista dysków' : '..'}</div>`);
    }
    for (const entry of json.entries) {
      rows.push(`<div class="folder-row clickable" data-path="${escapeHtml(entry.path)}">${escapeHtml(entry.name)}</div>`);
    }
    list.innerHTML = rows.join('') || '<div class="folder-row">Brak podfolderów.</div>';
  } catch (error) {
    list.innerHTML = `<div class="folder-row">${escapeHtml(String(error.message || error))}</div>`;
  }
}

function showImapNotice(message) {
  const el = document.querySelector('#imapNotice');
  el.textContent = message;
  el.classList.remove('hidden');
}

function hideImapNotice() {
  document.querySelector('#imapNotice').classList.add('hidden');
}

function isRealExcelFile(file) {
  const name = String(file?.name || '').toLowerCase();
  return /\.xlsx$/.test(name);
}

function isGoogleSheetShortcut(file) {
  const name = String(file?.name || '').toLowerCase();
  return name.endsWith('.gsheet');
}

function showAddressLoadProblem(message) {
  const selector = document.querySelector('#recordSelector');
  selector.classList.remove('hidden');
  previewRecords = [];
  selectedRows = new Set();
  document.querySelector('#selectorInfo').textContent = message;
  document.querySelector('#addressRows').innerHTML = '<tr><td colspan="5">' + escapeHtml(message) + '</td></tr>';
  updateSelectedSummary();
}

function validateExcelChoice(file) {
  if (!file) return { ok: false, message: 'Nie wybrano pliku Excel.' };
  if (isGoogleSheetShortcut(file)) {
    return {
      ok: false,
      message: 'Wybrano plik .gsheet, czyli skrót do Google Sheets, a nie prawdziwy Excel. Otwórz ten arkusz w Google Sheets i wybierz: Plik → Pobierz → Microsoft Excel (.xlsx), a potem wskaż pobrany plik .xlsx.'
    };
  }
  if (!isRealExcelFile(file)) {
    return { ok: false, message: 'Wybrany plik nie jest Excelem. Wybierz plik z końcówką .xlsx.' };
  }
  return { ok: true };
}

function currentBatchParams() {
  return {
    gminaName: document.querySelector('#gminaName').value || '',
    postalCode: document.querySelector('#postalCode').value || '',
    zone: document.querySelector('#zone').value || '',
    wojewodztwo: document.querySelector('#wojewodztwo').value || ''
  };
}

async function loadAddressPreview() {
  const fileInput = document.querySelector('#excelFile');
  const file = fileInput.files && fileInput.files[0];
  const selector = document.querySelector('#recordSelector');
  if (!file) {
    previewRecords = [];
    selectedRows = new Set();
    selector.classList.add('hidden');
    updateSelectedSummary();
    return;
  }

  const fileCheck = validateExcelChoice(file);
  if (!fileCheck.ok) {
    showAddressLoadProblem(fileCheck.message);
    return;
  }

  selector.classList.remove('hidden');
  document.querySelector('#selectorInfo').textContent = 'Wczytuję adresy z Excela...';
  document.querySelector('#addressRows').innerHTML = '<tr><td colspan="5">Wczytuję...</td></tr>';

  const data = new FormData();
  data.append('excel', file);
  const params = currentBatchParams();
  for (const [key, value] of Object.entries(params)) data.append(key, value);

  try {
    const res = await fetch('/api/batch/preview', { method: 'POST', headers: { 'X-Scyzoryk-Request': '1' }, body: data });
    const json = await res.json();
    if (!json.ok) throw new Error(json.error || 'Nie udało się odczytać Excela.');
    previewRecords = json.records || [];
    selectedRows = new Set(previewRecords.map(row => row.rowNumber));
    const skipped = json.skipped || {};
    const skippedTotal = Object.values(skipped).reduce((a, b) => a + Number(b || 0), 0);
    const skipLabels = {
      empty: 'puste wiersze', missingAddress: 'brak adresu', notAirSourcePump: 'nie pompa powietrzna (Powietrze-woda)',
      missingOzc: 'brak OZC', invalidOzc: 'niepoprawne OZC', missingLp: 'puste LP (kolumna jest, komórka nie)', duplicateLp: 'zduplikowany numer LP'
    };
    const skipBreakdown = Object.entries(skipped)
      .filter(([, count]) => Number(count) > 0)
      .map(([key, count]) => `${skipLabels[key] || key}: ${count}`)
      .join(', ');
    const zoneWarning = json.zoneKnown === false ? ' · UWAGA: nie podano poprawnej strefy klimatycznej (1-5)' : '';
    document.querySelector('#selectorInfo').textContent = `Arkusz: ${json.sheetName || '-'} · znaleziono ${P(previewRecords.length, 'adres', 'adresy', 'adresów')}${skippedTotal ? ` · pominięto ${P(skippedTotal, 'wiersz', 'wiersze', 'wierszy')} (${skipBreakdown})` : ''}${zoneWarning}.`;
    renderAddressRows();
  } catch (error) {
    previewRecords = [];
    selectedRows = new Set();
    const rawMessage = String(error.message || error);
    const message = rawMessage === 'Failed to fetch'
      ? 'Nie udało się połączyć z aplikacją. Sprawdź, czy Scyzoryk nadal jest uruchomiony.'
      : rawMessage;
    document.querySelector('#selectorInfo').textContent = message;
    document.querySelector('#addressRows').innerHTML = '<tr><td colspan="5">' + escapeHtml(message) + '</td></tr>';
    updateSelectedSummary();
  }
}

function filteredPreviewRecords() {
  const q = normalizeSearch(document.querySelector('#addressSearch').value || '');
  if (!q) return previewRecords;
  return previewRecords.filter(row => normalizeSearch(`${row.rowNumber} ${row.name || ''} ${row.address || ''}`).includes(q));
}

function renderAddressRows() {
  const rows = filteredPreviewRecords();
  document.querySelector('#addressRows').innerHTML = rows.map(row => {
    const checked = selectedRows.has(row.rowNumber);
    const deviceLabel = row.device?.model ? `${row.device.model}${row.device.needsConfirmation ? ' (do potwierdzenia)' : ''}` : '';
    const details = [row.ozcKw ? `OZC: ${escapeHtml(String(row.ozcKw))} kW` : '', deviceLabel ? escapeHtml(deviceLabel) : ''].filter(Boolean).join(' · ');
    return `<tr class="record-row ${checked ? '' : 'unselected'}" data-row-number="${row.rowNumber}">`
      + `<td><input type="checkbox" ${checked ? 'checked' : ''} aria-label="Wybierz adres" /></td>`
      + `<td>${escapeHtml(String(row.lp ?? row.rowNumber ?? ''))}</td>`
      + `<td>${escapeHtml(row.name || '')}</td>`
      + `<td><strong>${escapeHtml(row.address || '')}</strong></td>`
      + `<td>${details || '<span class="small">-</span>'}</td>`
      + `</tr>`;
  }).join('') || '<tr><td colspan="5">Brak adresów dla obecnego filtra.</td></tr>';
  updateSelectedSummary();
  // Synchronizacja checkboxa "Zaznacz wszystkie" z widocznym stanem (w tym
  // indeterminate przy zaznaczeniu czesciowym) - ten sam wzorzec co
  // formularze-ecodan/inline-1.js.
  const checkAll = document.querySelector('#recordCheckAll');
  if (checkAll) {
    const zaznaczoneWidoczne = rows.filter(row => selectedRows.has(row.rowNumber)).length;
    checkAll.indeterminate = zaznaczoneWidoczne > 0 && zaznaczoneWidoczne < rows.length;
    if (!checkAll.indeterminate) checkAll.checked = rows.length > 0 && zaznaczoneWidoczne === rows.length;
  }
}

// Polska liczba mnoga ma 3 formy (1 / 2-4 poza 12-14 / reszta), nie 2 -
// "76 adresy" brzmi zle, potrzeba "76 adresów".
function pluralAdres(count) {
  if (count === 1) return 'adres';
  const lastDigit = count % 10;
  const lastTwo = count % 100;
  if (lastDigit >= 2 && lastDigit <= 4 && !(lastTwo >= 12 && lastTwo <= 14)) return 'adresy';
  return 'adresów';
}

function updateSelectedSummary() {
  const count = selectedRows.size;
  const total = previewRecords.length;
  document.querySelector('#selectedRowsInput').value = JSON.stringify(Array.from(selectedRows).sort((a, b) => a - b));
  document.querySelector('#selectedSummary').textContent = total ? `Zaznaczono: ${count} z ${total}` : 'Zaznaczono: 0';
  const btn = document.querySelector('#startBatch');
  btn.textContent = total ? `Zgłoś ${count} ${pluralAdres(count)}` : 'Uruchom zgłoszenia';
}

function normalizeSearch(value) {
  return String(value || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ł/g, 'l');
}

document.querySelector('#cancelBatch').addEventListener('click', async () => {
  if (!activeJob || cancelRequested) return;
  // Audyt UX 2026-08-21: poprzedni tekst mowil tylko o kartach juz
  // odebranych - nie ostrzegal, ze WIERSZ aktualnie w trakcie (job.current)
  // mogl juz zostac naprawde, nieodwracalnie zgloszony do kalkulatora
  // Varmero, zanim Anuluj zdazy przerwac tylko oczekiwanie na maila.
  const sure = confirm('Przerwać zgłaszanie? Wiersz aktualnie przetwarzany mógł już zostać nieodwracalnie zgłoszony do Varmero (przerwane zostanie tylko oczekiwanie na jego mail) - kolejne wiersze się nie rozpoczną. Karty już odebrane zostaną w folderze zadania.');
  if (!sure) return;

  cancelRequested = true;
  const btn = document.querySelector('#cancelBatch');
  btn.disabled = true;
  btn.textContent = 'Przerywam...';
  document.querySelector('#finishInfo').textContent = 'Przerywanie zgłaszania...';

  try {
    await fetch(`/api/batch/cancel/${activeJob}`, { method: 'POST', headers: { 'X-Scyzoryk-Request': '1' } });
  } catch (error) {
    console.error(error);
  }
  pollStatus();
});

async function pollStatus() {
  if (!activeJob) return;
  let res;
  try {
    res = await fetch(`/api/batch/status/${activeJob}`);
    pollFailures = 0;
  } catch (error) {
    pollFailures += 1;
    if (pollFailures >= 5) {
      clearInterval(pollTimer);
      pollTimer = null;
      document.querySelector('#finishInfo').textContent = 'Brak połączenia z narzędziem - zgłaszanie mogło zostać przerwane. Odśwież stronę, gdy Scyzoryk znów działa (trwające zadanie zostanie pokazane automatycznie).';
      document.querySelector('#startBatch').disabled = false;
    }
    return;
  }
  if (res.status === 404) {
    clearInterval(pollTimer);
    pollTimer = null;
    activeJob = null;
    document.querySelector('#finishInfo').textContent = 'To zadanie już nie istnieje (prawdopodobnie restart panelu). Uruchom zgłaszanie ponownie.';
    document.querySelector('#startBatch').disabled = false;
    return;
  }
  const json = await res.json().catch(() => null);
  if (!res.ok || !json?.ok) {
    clearInterval(pollTimer);
    pollTimer = null;
    document.querySelector('#finishInfo').textContent = json?.error || 'Błąd odczytu statusu zadania.';
    return;
  }
  const job = json.job;

  const total = job.total || 0;
  const done = job.done || 0;
  document.querySelector('#progress').max = Math.max(total, 1);
  document.querySelector('#progress').value = done;
  document.querySelector('#jobStatus').textContent = statusLabel(job.status || '-');
  document.querySelector('#jobDone').textContent = `${done} / ${total}`;
  document.querySelector('#jobOk').textContent = `${job.ok || 0}${job.skippedExisting ? ' +' + job.skippedExisting : ''}`;
  document.querySelector('#jobFailed').textContent = job.failed || 0;

  if (job.cancelRequested || job.status === 'cancelling') {
    document.querySelector('#cancelBatch').disabled = true;
    document.querySelector('#cancelBatch').textContent = 'Przerywam...';
  }

  document.querySelector('#current').textContent = job.current ? `Aktualnie: ${job.current}` : 'Aktualnie: -';

  if (job.pdfDir) {
    currentPdfDir = job.pdfDir;
    currentPdfJobId = job.id;
    document.querySelector('#openPdfFolder').classList.remove('hidden');
  }

  const rows = job.resultsPreview || [];
  document.querySelector('#previewRows').innerHTML = rows.map(row => {
    const status = row.ok
      ? `<span class="badge ${row.skippedExisting ? 'skip' : 'ok'}">${row.skippedExisting ? 'Pominięto' : 'Karta gotowa'}</span>`
      : row.cancelled
        ? `<span class="badge skip">Przerwano</span><div class="small">Wiersz mógł już zostać zgłoszony do Varmero - sprawdź skrzynkę, zanim zgłosisz go ponownie.</div>`
        : `<span class="badge bad">Błąd</span><div class="small">${escapeHtml(row.error || '')}</div>`;
    return `<tr><td>${row.rowNumber || ''}</td><td>${escapeHtml(row.name || '')}</td><td>${escapeHtml(row.address || '')}</td><td>${status}</td></tr>`;
  }).join('');

  if (['finished', 'finished-with-errors', 'cancelled', 'fatal-error'].includes(job.status)) {
    clearInterval(pollTimer);
    pollTimer = null;
    activeJob = null;
    document.querySelector('#startBatch').disabled = false;
    document.querySelector('#cancelBatch').disabled = true;
    document.querySelector('#cancelBatch').textContent = 'Przerwij zgłaszanie';
    // Otwiera folder z kartami automatycznie po zakonczeniu - dokladnie raz
    // na zadanie (autoOpenedForJob), zeby ponowny poll (np. po kliknieciu
    // "Przerwij") nie otwieral kolejnego okna Eksploratora.
    if (job.pdfDir && autoOpenedForJob !== job.id) {
      autoOpenedForJob = job.id;
      openPdfFolder(job.id);
    }
    if (job.status === 'cancelled') {
      document.querySelector('#finishInfo').textContent = 'Przerwano zgłaszanie. Odebrane dotąd karty zostały w folderze zadania.';
    } else if (job.status === 'fatal-error') {
      document.querySelector('#finishInfo').textContent = job.fatalReason || 'Nie udało się rozpocząć albo zakończyć zgłaszania.';
    } else if (job.status === 'finished-with-errors') {
      const skipped = job.skippedExisting ? `, ${job.skippedExisting} pominięto jako już gotowe` : '';
      document.querySelector('#finishInfo').textContent = `Zakończono z błędami. Gotowe: ${P(job.ok || 0, 'karta', 'karty', 'kart')}${skipped}, nieudane: ${job.failed || 0}.`;
    } else {
      const skipped = job.skippedExisting ? `, pominięto ${job.skippedExisting} już gotowych` : '';
      document.querySelector('#finishInfo').textContent = `Zakończono. Wygenerowano ${P(job.ok || 0, 'kartę', 'karty', 'kart')}${skipped}.`;
    }
  }
}

function statusLabel(status) {
  const labels = {
    queued: 'W kolejce',
    'reading-excel': 'Czytam Excel',
    running: 'W toku',
    cancelling: 'Przerywanie',
    cancelled: 'Przerwane',
    finished: 'Gotowe',
    'finished-with-errors': 'Gotowe z błędami',
    'fatal-error': 'Błąd zgłaszania'
  };
  return labels[status] || status;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[ch]));
}

function getFormField(form, name) {
  const field = form.elements.namedItem(name);
  if (!field) throw new Error(`Brak pola formularza: ${name}`);
  return field;
}

function saveSettings() {
  const form = document.querySelector('#batchForm');
  // Przeglad 2026-09-29: gmina, kod pocztowy, strefa i nazwa inwestycji NIE
  // sa juz zapamietywane - dotyczyly poprzedniej inwestycji i po cichu
  // trafialy do nieodwracalnych zgloszen nastepnej. Zostaja tylko ustawienia
  // "narzedzia" (folder wynikow, wojewodztwo, rownoleglosc, pomijanie).
  const settings = {
    outputPath: getFormField(form, 'outputPath').value || '',
    wojewodztwo: getFormField(form, 'wojewodztwo').value || '',
    concurrency: getFormField(form, 'concurrency').value || '1',
    skipExisting: getFormField(form, 'skipExisting').checked
  };
  localStorage.setItem('varmeroGeneratorSettings', JSON.stringify(settings));
}

function loadSettings() {
  try {
    const settings = JSON.parse(localStorage.getItem('varmeroGeneratorSettings') || '{}');
    const form = document.querySelector('#batchForm');
    if (settings.outputPath) getFormField(form, 'outputPath').value = settings.outputPath;
    if (settings.wojewodztwo) getFormField(form, 'wojewodztwo').value = settings.wojewodztwo;
    if (settings.concurrency) getFormField(form, 'concurrency').value = settings.concurrency;
    if (typeof settings.skipExisting === 'boolean') getFormField(form, 'skipExisting').checked = settings.skipExisting;
  } catch {}
}
