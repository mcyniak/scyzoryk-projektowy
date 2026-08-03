// Przycisk i modal aktualizacji panelu (GitHub Releases) - patrz
// lib/updateService.js dla logiki backendu. Osobny plik zamiast rozbudowy
// inline-1.js, zeby nie miesac logiki statusu narzedzi z logika aktualizacji.
// Zero inline JS/HTML z zewnatrz: opis wydania jest wstawiany WYLACZNIE przez
// textContent, nigdy innerHTML.
(function () {
  const STATUS_POLL_MS = 60000;
  const PROGRESS_POLL_MS = 1000;
  const HEALTH_POLL_MS = 2000;
  const HEADERS = { 'X-Scyzoryk-Request': '1' };

  const btn = document.getElementById('updateAvailableBtn');
  const btnLabel = document.getElementById('updateAvailableBtnLabel');
  const modal = document.getElementById('updateModal');
  if (!btn || !modal) return;

  const closeBtn = document.getElementById('updateModalClose');
  const laterBtn = document.getElementById('updateLaterBtn');
  const installBtn = document.getElementById('updateInstallBtn');
  const currentVersionEl = document.getElementById('updateCurrentVersion');
  const latestVersionEl = document.getElementById('updateLatestVersion');
  const publishedAtEl = document.getElementById('updatePublishedAt');
  const notesEl = document.getElementById('updateReleaseNotes');
  const progressBox = document.getElementById('updateProgressBox');
  const progressMessage = document.getElementById('updateProgressMessage');
  const progressPercent = document.getElementById('updateProgressPercent');
  const progressBarFill = document.getElementById('updateProgressBarFill');
  const errorBox = document.getElementById('updateErrorBox');
  const errorMessage = document.getElementById('updateErrorMessage');

  let lastStatus = null;
  let installStarted = false;
  let openerElement = null;

  function hide(el) { if (el) el.classList.add('hidden'); }
  function show(el) { if (el) el.classList.remove('hidden'); }
  function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

  function fmtDate(iso) {
    if (!iso) return '-';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleDateString('pl-PL', { year: 'numeric', month: 'long', day: 'numeric' });
  }

  async function fetchStatus() {
    const res = await fetch('/api/update/status', { cache: 'no-store' });
    if (!res.ok) throw new Error('Nie udało się odczytać stanu aktualizacji.');
    return res.json();
  }

  function renderButtonFromStatus(status) {
    if (installStarted) return; // przycisk pozostaje zgodny z modalem podczas instalacji
    if (status.available && status.state !== 'installing' && status.state !== 'restarting') {
      btnLabel.textContent = `Dostępna aktualizacja ${status.latestVersion}`;
      show(btn);
    } else {
      hide(btn);
    }
  }

  function renderModalData(status) {
    currentVersionEl.textContent = status.currentVersion || '-';
    latestVersionEl.textContent = status.latestVersion || '-';
    publishedAtEl.textContent = fmtDate(status.publishedAt);
    // textContent, nigdy innerHTML - opis wydania z GitHub Release jest
    // traktowany jako zwykly, niesprawdzony tekst.
    notesEl.textContent = status.releaseNotes && status.releaseNotes.trim() ? status.releaseNotes : '(brak opisu zmian)';
  }

  function setProgress(message, percent) {
    show(progressBox);
    progressMessage.textContent = message;
    progressPercent.textContent = percent == null ? '' : `${percent}%`;
    progressBarFill.style.width = `${percent == null ? 0 : percent}%`;
  }

  function showError(message) {
    show(errorBox);
    errorMessage.textContent = message;
  }

  function onKeydown(e) {
    if (e.key === 'Escape') closeModal();
  }

  function openModal() {
    openerElement = document.activeElement;
    modal.classList.add('open');
    modal.setAttribute('aria-hidden', 'false');
    document.addEventListener('keydown', onKeydown);
    installBtn.focus();
  }

  function closeModal() {
    // Po rozpoczeciu instalacji modal nie da sie zamknac (Escape ani "Później")
    // - uzytkownik nie moze zgubic z oczu jedynego miejsca, gdzie zobaczy wynik.
    if (installStarted) return;
    modal.classList.remove('open');
    modal.setAttribute('aria-hidden', 'true');
    document.removeEventListener('keydown', onKeydown);
    if (openerElement && typeof openerElement.focus === 'function') openerElement.focus();
  }

  async function refreshFromStatus() {
    try {
      const status = await fetchStatus();
      lastStatus = status;
      renderButtonFromStatus(status);
      if (modal.classList.contains('open') && !installStarted) renderModalData(status);
      return status;
    } catch (_) {
      return null;
    }
  }

  btn.addEventListener('click', () => {
    if (lastStatus) renderModalData(lastStatus);
    hide(progressBox);
    hide(errorBox);
    openModal();
  });
  closeBtn.addEventListener('click', closeModal);
  laterBtn.addEventListener('click', closeModal);
  modal.addEventListener('click', e => { if (e.target === modal) closeModal(); });

  // Po kliknieciu "Zaktualizuj i uruchom ponownie" serwer odpowiada szybko
  // (202) i sam kontynuuje w tle - postep sledzimy przez osobne, czeste
  // odpytywanie /api/update/status, az polaczenie zacznie zawodzic (serwer
  // zostal zatrzymany przez run-update.ps1), a potem czekamy na powrot
  // /api/health, zeby bezpiecznie odswiezyc strone.
  async function trackProgressUntilServerStops() {
    for (let i = 0; i < 600; i++) {
      await sleep(PROGRESS_POLL_MS);
      let status;
      try {
        status = await fetchStatus();
      } catch (_) {
        setProgress('Zamykanie Scyzoryka…', 100);
        return waitForRestart();
      }
      if (status.state === 'downloading') {
        setProgress(`Pobieranie aktualizacji… ${status.percent == null ? 0 : status.percent}%`, status.percent);
      } else if (status.state === 'ready') {
        setProgress('Sprawdzanie pobranego pliku…', 100);
      } else if (status.state === 'installing' || status.state === 'restarting') {
        setProgress('Instalowanie aktualizacji…', 100);
      } else if (status.state === 'error') {
        showError(status.error || 'Aktualizacja nie powiodła się.');
        resetInstallControls();
        return;
      }
    }
    return waitForRestart();
  }

  async function waitForRestart() {
    setProgress('Ponowne uruchamianie…', 100);
    for (let i = 0; i < 150; i++) {
      await sleep(HEALTH_POLL_MS);
      try {
        const res = await fetch('/api/health', { cache: 'no-store' });
        if (res.ok) { location.reload(); return; }
      } catch (_) {
        // Serwer jeszcze wstaje - tolerowane, probujemy dalej.
      }
    }
    showError('Nie udało się potwierdzić ponownego uruchomienia Scyzoryka. Odśwież stronę ręcznie.');
  }

  function resetInstallControls() {
    installStarted = false;
    installBtn.disabled = false;
    installBtn.removeAttribute('aria-disabled');
    laterBtn.disabled = false;
    closeBtn.disabled = false;
  }

  installBtn.addEventListener('click', async () => {
    if (installStarted) return; // blokada wielokrotnego kliknięcia
    installStarted = true;
    installBtn.disabled = true;
    installBtn.setAttribute('aria-disabled', 'true');
    laterBtn.disabled = true;
    closeBtn.disabled = true;
    hide(errorBox);
    setProgress('Przygotowywanie aktualizacji…', 0);
    try {
      const res = await fetch('/api/update/install', { method: 'POST', headers: HEADERS });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.message || 'Nie udało się rozpocząć aktualizacji.');
      await trackProgressUntilServerStops();
    } catch (err) {
      showError(err.message || 'Nie udało się zainstalować aktualizacji.');
      resetInstallControls();
    }
  });

  refreshFromStatus();
  setInterval(refreshFromStatus, STATUS_POLL_MS);

  // Jesli poprzednie uruchomienie Scyzoryka bylo NIEUDANA aktualizacja,
  // pokazujemy to od razu po wczytaniu strony, bez czekania na klik.
  fetchStatus().then(status => {
    if (status && status.lastResult && status.lastResult.ok === false) {
      renderModalData(status);
      showError('Scyzoryk został ponownie uruchomiony. Szczegóły zapisano w lokalnym dzienniku aktualizacji.');
      openModal();
    }
  }).catch(() => {});
})();
