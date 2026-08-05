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
  const checkBtn = document.getElementById('checkUpdateBtn');
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

  // Reczne "sprawdz teraz" - bez tego trzeba czekac do 6h (albo restartu
  // aplikacji) na kolejne automatyczne sprawdzenie. Sam check jest szybki
  // (jedno zapytanie do GitHub API), wiec po kliknieciu po prostu krotko
  // odpytujemy status, az zauwazymy ze lastCheckedAt sie zmienil.
  if (checkBtn) {
    checkBtn.addEventListener('click', async () => {
      if (checkBtn.disabled) return;
      checkBtn.disabled = true;
      checkBtn.classList.add('is-checking');
      const previousCheckedAt = lastStatus ? lastStatus.lastCheckedAt : null;
      try {
        await fetch('/api/update/check', { method: 'POST', headers: HEADERS });
        for (let i = 0; i < 10; i++) {
          await sleep(400);
          const status = await refreshFromStatus();
          if (status && status.lastCheckedAt !== previousCheckedAt) break;
        }
      } catch (_) {
        // Brak internetu itp. - stan po prostu zostaje jak byl, bez alarmowania.
      } finally {
        checkBtn.disabled = false;
        checkBtn.classList.remove('is-checking');
      }
    });
  }

  closeBtn.addEventListener('click', closeModal);
  laterBtn.addEventListener('click', closeModal);
  modal.addEventListener('click', e => { if (e.target === modal) closeModal(); });

  // Cala droga (pobieranie -> weryfikacja -> instalacja -> restart -> health)
  // jest mapowana na JEDEN pasek 0-100% - 100% ma znaczyc "gotowe, dziala
  // nowa wersja", NIE "plik sie pobral". Bez tego uzytkownik widzial 100%
  // zaraz po pobraniu i musial jeszcze dlugo czekac, co wygladalo jak
  // zawieszenie mimo ze wszystko szlo poprawnie.
  const PHASE_DOWNLOAD_MAX = 70;   // pobieranie: 0-70%, proporcjonalnie do realnego postepu
  const PHASE_READY = 75;          // suma kontrolna sprawdzona
  const PHASE_CLOSING = 85;        // serwer jeszcze odpowiada, ale za chwile zacznie sie zamykac
  const PHASE_INSTALLING = 90;     // polaczenie przestalo odpowiadac - instalator dziala
  const PHASE_RESTART_START = 90;
  const PHASE_RESTART_CAP = 99;    // rosnie stopniowo, nigdy nie dobija do 100 samo z siebie
  const PHASE_DONE = 100;          // WYLACZNIE w momencie, gdy /api/health juz odpowiada

  // Po kliknieciu "Zaktualizuj i uruchom ponownie" serwer odpowiada szybko
  // (202) i sam kontynuuje w tle - postep sledzimy przez osobne, czeste
  // odpytywanie /api/update/status, az polaczenie zacznie zawodzic (serwer
  // zostal zatrzymany przez Scyzoryk.exe --apply-update), a potem czekamy na powrot
  // /api/health, zeby bezpiecznie odswiezyc strone.
  async function trackProgressUntilServerStops(expectedVersion) {
    for (let i = 0; i < 600; i++) {
      await sleep(PROGRESS_POLL_MS);
      let status;
      try {
        status = await fetchStatus();
      } catch (_) {
        setProgress('Zamykanie Scyzoryka…', PHASE_INSTALLING);
        return waitForRestart(expectedVersion);
      }
      if (status.state === 'downloading') {
        const downloadPercent = status.percent == null ? 0 : status.percent;
        setProgress(`Pobieranie aktualizacji… ${downloadPercent}%`, Math.round((downloadPercent / 100) * PHASE_DOWNLOAD_MAX));
      } else if (status.state === 'ready') {
        setProgress('Sprawdzanie pobranego pliku…', PHASE_READY);
      } else if (status.state === 'installing' || status.state === 'restarting') {
        setProgress('Zamykanie Scyzoryka…', PHASE_CLOSING);
      } else if (status.state === 'error') {
        showError(status.error || 'Aktualizacja nie powiodła się.');
        resetInstallControls();
        return;
      }
    }
    return waitForRestart(expectedVersion);
  }

  async function waitForRestart(expectedVersion) {
    let percent = PHASE_RESTART_START;
    setProgress('Instalowanie aktualizacji…', percent);
    for (let i = 0; i < 150; i++) {
      await sleep(HEALTH_POLL_MS);
      try {
        const res = await fetch('/api/health', { cache: 'no-store' });
        if (res.ok) {
          // Audyt v1.0.4, P0-8: samo "/api/health odpowiada 200" nie znaczy
          // "nowa wersja dziala" - jesli restart przywrocil STARA wersje
          // (np. instalator po cichu pominal zablokowany plik), health
          // odpowiada normalnie, tylko ze to wciaz ta sama, stara wersja.
          // Sprawdzamy pole "version" z odpowiedzi, jesli znamy oczekiwana.
          let runningVersion = null;
          try { runningVersion = (await res.json()).version || null; } catch (_) {}
          if (expectedVersion && runningVersion && runningVersion !== expectedVersion) {
            showError(`Po ponownym uruchomieniu nadal działa wersja ${runningVersion} (oczekiwano ${expectedVersion}). Sprawdź log aktualizacji i spróbuj ponownie.`);
            resetInstallControls();
            return;
          }
          // Dopiero TERAZ nowa wersja faktycznie dziala - to jest jedyny
          // moment, w ktorym pasek pokazuje 100%. Krotka pauza, zeby
          // uzytkownik zdazyl to zobaczyc przed odswiezeniem strony.
          setProgress('Gotowe. Wczytuję nową wersję…', PHASE_DONE);
          await sleep(400);
          location.reload();
          return;
        }
      } catch (_) {
        // Serwer jeszcze wstaje - tolerowane, probujemy dalej.
      }
      // Rosnie stopniowo w strone PHASE_RESTART_CAP, ale nigdy sama z siebie
      // nie dobija do 100% - to zarezerwowane wylacznie dla potwierdzonego
      // powrotu /api/health powyzej.
      percent = Math.min(PHASE_RESTART_CAP, percent + 1);
      setProgress('Ponowne uruchamianie…', percent);
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
    // Zapamietujemy TERAZ, do jakiej wersji dazymy - status.latestVersion moze
    // sie zmienic (albo zniknac) do czasu, az waitForRestart() go potrzebuje.
    const expectedVersion = lastStatus ? lastStatus.latestVersion : null;
    try {
      const res = await fetch('/api/update/install', { method: 'POST', headers: HEADERS });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.message || 'Nie udało się rozpocząć aktualizacji.');
      await trackProgressUntilServerStops(expectedVersion);
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
