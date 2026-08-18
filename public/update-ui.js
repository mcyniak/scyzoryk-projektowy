// Przycisk i modal aktualizacji panelu (GitHub Releases) - patrz
// lib/updateService.js dla logiki backendu. Osobny plik zamiast rozbudowy
// inline-1.js, zeby nie miesac logiki statusu narzedzi z logika aktualizacji.
// Zero inline JS/HTML z zewnatrz: opis wydania jest wstawiany WYLACZNIE przez
// textContent, nigdy innerHTML.
//
// Cold-start apply (patrz plan "Aktualizacja przy zimnym starcie"): klikniecie
// "Zainstaluj" juz NIGDY nie zabija/restartuje serwera na zywo - pobiera i
// weryfikuje instalator, po czym backend wchodzi w trwaly stan
// "ready-for-restart". Rzeczywista podmiana plikow dzieje sie dopiero przy
// NASTEPNYM zimnym starcie Scyzoryka (uzytkownik recznie zamyka przez ikone w
// zasobniku i otwiera ponownie). Dzieki temu ten plik nigdy nie musi juz
// "czekac az polaczenie padnie" ani sprawdzac dzialajacej wersji po
// restarcie - caly ten dawny mechanizm (trackProgressUntilServerStops/
// waitForRestart) znika razem z zywym restartem.
(function () {
  const STATUS_POLL_MS = 60000;
  const PROGRESS_POLL_MS = 1000;
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
  // Prawda WYLACZNIE podczas trwajacej petli odpytywania po kliknieciu
  // "Zainstaluj" (pollUntilReadyOrError) - w odroznieniu od dawnej wersji tego
  // pliku, NIE blokuje juz zamykania modala: pobieranie jest w calosci
  // nieniszczace (Node nigdy nie jest restartowany/zabijany w tym kroku), wiec
  // uzytkownik moze bezpiecznie zamknac karte/modal w dowolnym momencie - petla
  // dziala dalej w tle i tak czy inaczej wyladuje w last-result/ready-for-restart.
  let installStarted = false;
  let openerElement = null;
  // Audyt rozdz. 4, P2: ustawiane gdy modal zostal otwarty AUTOMATYCZNIE, bo
  // zapisany wynik ostatniej proby aktualizacji nie byl jeszcze potwierdzony -
  // przy zamknieciu wysylamy potwierdzenie do backendu, zeby to samo okno nie
  // wyskakiwalo ponownie przy kazdym kolejnym powrocie do panelu.
  let pendingResultAcknowledge = false;

  function acknowledgeResultIfPending() {
    if (!pendingResultAcknowledge) return;
    pendingResultAcknowledge = false;
    fetch('/api/update/acknowledge-result', { method: 'POST', headers: HEADERS }).catch(() => {});
  }

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
    if (installStarted) return; // przycisk pozostaje zgodny z modalem podczas trwajacego pobierania
    if (status.state === 'ready-for-restart') {
      btnLabel.textContent = 'Aktualizacja gotowa – uruchom ponownie';
      show(btn);
    } else if (status.available && status.state !== 'downloading' && status.state !== 'ready') {
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
    // W odroznieniu od dawnej wersji tego modala, nic tu juz nie blokuje
    // zamkniecia - pobieranie w tle jest nieniszczace (patrz komentarz przy
    // installStarted powyzej), wiec uzytkownik moze zamknac okno w dowolnym
    // momencie bez utraty postepu.
    acknowledgeResultIfPending();
    modal.classList.remove('open');
    modal.setAttribute('aria-hidden', 'true');
    document.removeEventListener('keydown', onKeydown);
    if (openerElement && typeof openerElement.focus === 'function') openerElement.focus();
  }

  function resetInstallControls() {
    installStarted = false;
    installBtn.disabled = false;
    installBtn.removeAttribute('aria-disabled');
    laterBtn.disabled = false;
    closeBtn.disabled = false;
  }

  // Trwaly stan sukcesu: instalator jest juz na dysku i zweryfikowany (SHA-256),
  // ale zostanie zastosowany dopiero przy nastepnym zimnym starcie Scyzoryka
  // (LauncherApp.ApplyPendingUpdateIfAnyAsync) - "Zainstaluj" jest juz
  // bezcelowe (kolejne pobranie tego samego wydania), wiec zostaje trwale
  // wylaczone, ale modal da sie normalnie zamknac/otworzyc.
  function showReadyForRestartMessage() {
    installBtn.disabled = true;
    installBtn.setAttribute('aria-disabled', 'true');
    laterBtn.disabled = false;
    closeBtn.disabled = false;
    hide(errorBox);
    setProgress(
      'Aktualizacja pobrana i zweryfikowana. Zamknij Scyzoryka (ikona w zasobniku → „Zamknij Scyzoryka”) i uruchom go ponownie, aby ją zastosować.',
      PHASE_DONE
    );
  }

  async function refreshFromStatus() {
    try {
      const status = await fetchStatus();
      lastStatus = status;
      renderButtonFromStatus(status);
      if (modal.classList.contains('open') && !installStarted) {
        renderModalData(status);
        if (status.state === 'ready-for-restart') showReadyForRestartMessage();
      }
      return status;
    } catch (_) {
      return null;
    }
  }

  btn.addEventListener('click', () => {
    if (lastStatus) renderModalData(lastStatus);
    hide(errorBox);
    if (!installStarted) {
      if (lastStatus && lastStatus.state === 'ready-for-restart') {
        showReadyForRestartMessage();
      } else {
        hide(progressBox);
        resetInstallControls();
      }
    }
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

  // Cala droga widoczna z panelu (pobieranie -> weryfikacja SHA-256) jest
  // mapowana na JEDEN pasek 0-100% - 100% ma znaczyc "pobrano i zweryfikowano,
  // gotowe do zastosowania przy nastepnym starcie", NIE "nowa wersja juz
  // dziala" (to ostatnie nie jest juz nawet obserwowalne z tej karty - stosowanie
  // dzieje sie przy NASTEPNYM uruchomieniu Scyzoryka, poza cyklem zycia tej
  // strony).
  const PHASE_DOWNLOAD_MAX = 90;   // pobieranie: 0-90%, proporcjonalnie do realnego postepu
  const PHASE_VERIFYING = 95;      // suma kontrolna sprawdzana, kopiowanie launchera
  const PHASE_DONE = 100;          // pobrano + zweryfikowano - znacznik pending-update.json zapisany

  // Po kliknieciu "Pobierz aktualizacje" serwer odpowiada szybko (202) i sam
  // kontynuuje w tle - postep sledzimy przez osobne, czeste odpytywanie
  // /api/update/status, az backend osiagnie stan koncowy ("ready-for-restart"
  // albo "error"). W odroznieniu od dawnej wersji, polaczenie z serwerem NIGDY
  // nie ma tu padac - Node nie jest restartowany w tym kroku - wiec chwilowy
  // blad sieci (fetch) jest tolerowany i po prostu probujemy ponownie przy
  // kolejnym tyknieciu, zamiast interpretowac go jako "serwer sie zamyka".
  async function pollUntilReadyOrError(expectedVersion) {
    for (let i = 0; i < 300; i++) {
      await sleep(PROGRESS_POLL_MS);
      let status;
      try {
        status = await fetchStatus();
      } catch (_) {
        continue;
      }
      lastStatus = status;
      renderButtonFromStatus(status);
      if (status.state === 'downloading') {
        const downloadPercent = status.percent == null ? 0 : status.percent;
        setProgress(`Pobieranie aktualizacji… ${downloadPercent}%`, Math.round((downloadPercent / 100) * PHASE_DOWNLOAD_MAX));
      } else if (status.state === 'ready') {
        setProgress('Sprawdzanie pobranego pliku…', PHASE_VERIFYING);
      } else if (status.state === 'ready-for-restart') {
        installStarted = false;
        showReadyForRestartMessage();
        return;
      } else if (status.state === 'error') {
        showError(status.error || 'Aktualizacja nie powiodła się.');
        resetInstallControls();
        return;
      } else {
        // Nieoczekiwany stan (np. instalacja zostala anulowana/nadpisana z
        // innej karty) - traktujemy jak blad zamiast czekac w nieskonczonosc.
        showError('Aktualizacja nie powiodła się.');
        resetInstallControls();
        return;
      }
    }
    showError('Pobieranie aktualizacji trwa zbyt długo. Sprawdź połączenie i spróbuj ponownie.');
    resetInstallControls();
  }

  installBtn.addEventListener('click', async () => {
    if (installStarted) return; // odpytywanie juz trwa
    if (lastStatus && lastStatus.state === 'ready-for-restart') return; // juz pobrano - nic do zrobienia
    installStarted = true;
    installBtn.disabled = true;
    installBtn.setAttribute('aria-disabled', 'true');
    hide(errorBox);
    setProgress('Przygotowywanie aktualizacji…', 0);
    // Zapamietujemy TERAZ, do jakiej wersji dazymy - status.latestVersion moze
    // sie zmienic (albo zniknac) do czasu zakonczenia pobierania.
    const expectedVersion = lastStatus ? lastStatus.latestVersion : null;
    try {
      const res = await fetch('/api/update/install', { method: 'POST', headers: HEADERS });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.message || 'Nie udało się rozpocząć aktualizacji.');
      await pollUntilReadyOrError(expectedVersion);
    } catch (err) {
      showError(err.message || 'Nie udało się zainstalować aktualizacji.');
      resetInstallControls();
    }
  });

  refreshFromStatus();
  setInterval(refreshFromStatus, STATUS_POLL_MS);

  // Jesli poprzednie uruchomienie Scyzoryka bylo NIEUDANA aktualizacja,
  // pokazujemy to od razu po wczytaniu strony, bez czekania na klik. Tylko
  // gdy uzytkownik jeszcze tego NIE potwierdzil (audyt rozdz. 4, P2) - bez
  // tego warunku okno wyskakiwalo ponownie przy kazdym kolejnym powrocie do
  // panelu, nawet po zamknieciu.
  fetchStatus().then(status => {
    if (status && status.lastResult && status.lastResult.ok === false && !status.lastResultAcknowledged) {
      pendingResultAcknowledge = true;
      renderModalData(status);
      showError('Scyzoryk został ponownie uruchomiony. Szczegóły zapisano w lokalnym dzienniku aktualizacji.');
      openModal();
    }
  }).catch(() => {});
})();
