// Orkiestrator aktualizacji Scyzoryka przez GitHub Releases: maszyna stanow,
// sprawdzanie/pobieranie/weryfikacja, przygotowanie i odpalenie oddzielnego
// procesu aktualizatora (scripts/run-update.ps1). Wszystkie zewnetrzne efekty
// (siec, pobieranie, spawn PowerShella, zegar) sa wstrzykiwane jako `deps`,
// zeby dalo sie to przetestowac bez prawdziwego GitHuba/instalatora - patrz
// domyslne wiazanie w server.js (real* funkcje) kontra test/group10-updater.test.js
// (fake* funkcje).
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { writeJsonFileNoBom, sanitizeForLog } = require('./hardening');
const { isNewerVersion, isValidVersion, compareVersions } = require('./updateVersion');
const updateGithub = require('./updateGithub');
const updateDownload = require('./updateDownload');
const { getDataRoot } = require('./appPaths');

const INSTALL_ACTIVE_STATES = new Set(['downloading', 'ready', 'installing', 'restarting']);

// Audyt v1.0.4, P0-8: run-update.ps1 zabijalo WSZYSTKIE procesy Node tej
// instalacji bez pytania zadnej podaplikacji, czy trwa aktywne zadanie -
// drukowanie jest tu jedynym takim stanem, ktory jest juz dzis sledzony w
// jednym, wspolnym pliku blokady (lib/printCoordinator.js), wiec sprawdzamy
// go PRZED rozpoczeciem instalacji zamiast wymyslac nowy mechanizm "czy
// ktoras z 8 aplikacji jest zajeta". Synchroniczne (nie async) - startInstall
// jest celowo synchroniczna brama walidacyjna przed odpowiedzia HTTP.
function isPrintingActive() {
  const lockPath = path.join(getDataRoot(), 'runtime', 'printing', 'active.lock');
  let raw;
  try {
    raw = fs.readFileSync(lockPath, 'utf8');
  } catch (_) {
    return false; // brak pliku blokady - na pewno nic nie drukuje
  }

  let lock;
  try {
    lock = JSON.parse(raw);
  } catch (_) {
    // Audyt rozdz. 26/21: plik istnieje, ale jest chwilowo nieczytelny (np.
    // lib/printCoordinator.js akurat go zapisuje) - zachowawczo traktujemy
    // to jak mozliwy aktywny druk, zamiast pozwolic aktualizacji przejsc.
    return true;
  }

  if (!lock || !lock.pid) return false;
  try { process.kill(lock.pid, 0); return true; } catch (_) { return false; }
}

function nowIso() {
  return new Date().toISOString();
}

function readJsonSafe(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch (_) { return null; }
}

// Usuwa stare paczki aktualizacji, zeby katalog Updates nie rosl bez konca:
// zachowuje najwyzej 2 najnowsze KOMPLETNE (poprawnie nazwane wersja)
// podkatalogi, oraz usuwa wszystkie ".partial" (przerwane pobierania) z tych,
// ktore zostaja.
function cleanupUpdatesDir(updateRoot) {
  let entries = [];
  try { entries = fs.readdirSync(updateRoot, { withFileTypes: true }); } catch (_) { return; }
  const versionDirs = entries.filter(e => e.isDirectory() && isValidVersion(e.name)).map(e => e.name);
  versionDirs.sort((a, b) => compareVersions(b, a));
  for (const stale of versionDirs.slice(2)) {
    try { fs.rmSync(path.join(updateRoot, stale), { recursive: true, force: true }); } catch (_) {}
  }
  for (const keep of versionDirs.slice(0, 2)) {
    const dir = path.join(updateRoot, keep);
    let files = [];
    try { files = fs.readdirSync(dir); } catch (_) { continue; }
    for (const file of files) {
      if (file.endsWith('.partial')) { try { fs.unlinkSync(path.join(dir, file)); } catch (_) {} }
    }
  }
}

// Zlapane realnie (2026-08-05, wlasciciel, firmowy laptop): Node spawnujacy
// ukryty powershell.exe -ExecutionPolicy Bypass -WindowStyle Hidden, ktory z
// kolei uruchamia niepodpisany instalator, jest KLASYCZNA sygnatura
// "living-off-the-land dropper" - firmowy EDR zabijal ten proces natychmiast
// (0 bajtow stdout/stderr, proces nigdy nie pojawial sie na liscie procesow,
// zero lokalnie widocznych sladow w Defenderze/AppLockerze/logu polityk
// PowerShella). Zamiast PowerShella, aktualizator spawnuje TERAZ kopie
// juz zainstalowanego, zaufanego Scyzoryk.exe z argumentem --apply-update
// (patrz launcher\Scyzoryk.Launcher\UpdateApplier.cs - caly port dawnej
// logiki run-update.ps1) - to samo "aplikacja aktualizuje sie przez
// wywolanie wlasnego pliku wykonywalnego" co Chrome/VSCode/Slack, bez
// posredniego interpretera.
function buildUpdaterInvocation({ launcherExePath, installerPath, updateRoot, expectedVersion }) {
  return {
    exe: launcherExePath,
    args: ['--apply-update', installerPath, expectedVersion],
    // Zapasowa siatka bezpieczenstwa niezalezna od tego, co dokladnie jest
    // spawnowane - jesli TEN proces tez kiedys padnie natychmiast bez sladu,
    // to jest jedyne miejsce, gdzie zobaczylibysmy dlaczego.
    stdioLogPath: path.join(updateRoot, 'logs', `updater-stdio-${Date.now()}.log`)
  };
}

// Produkcyjna implementacja odpalenia aktualizatora: odlaczony proces, bez
// okna, bez dziedziczenia stdio, .unref() zeby nie blokowal zamkniecia
// procesu Node. NIGDY nie jest wywolywana wprost z testow (patrz deps w
// createUpdateService) - testy podstawiaja funkcje, ktora tylko zapisuje
// argumenty, z ktorymi ZOSTAŁABY wywolana.
function realSpawnUpdaterProcess({ exe, args, stdioLogPath }) {
  let stdio = 'ignore';
  if (stdioLogPath) {
    try {
      fs.mkdirSync(path.dirname(stdioLogPath), { recursive: true });
      const logFd = fs.openSync(stdioLogPath, 'a');
      stdio = ['ignore', logFd, logFd];
    } catch (_) {
      // Brak mozliwosci otwarcia pliku diagnostycznego nie moze zablokowac
      // proby aktualizacji - wracamy do 'ignore' jak dotychczas.
      stdio = 'ignore';
    }
  }
  const child = spawn(exe, args, { detached: true, stdio, windowsHide: true });
  child.unref();
  return child;
}

// Zweryfikowane bezposrednio na tej samej maszynie (2026-08-04): spawn() z
// { detached: true } na Windows ZAWSZE zglasza kod wyjscia 0 w zdarzeniu
// 'exit' obiektu procesu, NIEZALEZNIE od realnego kodu wyjscia procesu -
// Node fizycznie nie ma dostepu do prawdziwego kodu wyjscia dla procesu
// odlaczonego na Windows (potwierdzone testem: skrypt kończący się kodem 7
// byl widziany przez ten sam 'exit' listener jako kod 0). Nasluch na 'exit'
// z sprawdzaniem kodu (wczesniejsza wersja tego pliku) NIGDY nie mogl wiec
// wykryc realnej awarii run-update.ps1 na Windows - to jest przyczyna,
// czemu aktualizacja utykala w "installing" bez zadnego widocznego bledu,
// mimo wczesniejszej poprawki. Jedynym wiarygodnym dowodem, ze run-update.ps1
// FAKTYCZNIE zaczal sie wykonywac, jest nowy plik logu, ktory tworzy jako
// swoja pierwsza czynnosc (Write-Log "=== Start...") - PRZED czymkolwiek
// innym, w tym przed 2-sekundowa pauza. Czekamy krotko i sprawdzamy dysk,
// zamiast polegac na zawodnym mechanizmie kodu wyjscia.
// 4000ms bylo za krotkie w praktyce - podniesione do 12s (2026-08-05) jako
// bezpieczny zapas na start nowego procesu (dysk/AV moga chwilowo spowolnic
// pierwszy zapis), niezaleznie od tego, co dokladnie ten proces spawnuje.
async function realConfirmUpdaterStarted({ updateRoot, sinceMs, waitMs = 12000 }) {
  await new Promise(resolve => setTimeout(resolve, waitMs));
  try {
    const logsDir = path.join(updateRoot, 'logs');
    const names = fs.readdirSync(logsDir).filter(name => name.startsWith('update-') && name.endsWith('.log'));
    return names.some(name => {
      try { return fs.statSync(path.join(logsDir, name)).mtimeMs >= sinceMs; } catch (_) { return false; }
    });
  } catch (_) {
    return false;
  }
}

const defaultDeps = {
  fetchLatestRelease: updateGithub.fetchLatestRelease,
  downloadText: updateDownload.downloadText,
  downloadToPartialFile: updateDownload.downloadToPartialFile,
  parseSha256File: updateDownload.parseSha256File,
  spawnUpdaterProcess: realSpawnUpdaterProcess,
  confirmUpdaterStarted: realConfirmUpdaterStarted,
  now: () => Date.now()
};

function createUpdateService(options) {
  const {
    rootDir,
    getInstalledVersion, // () => { version, commit, builtAt }
    repo,
    updateRoot,
    enabled = true,
    apiBaseUrl,
    log = () => {}
  } = options;
  const deps = { ...defaultDeps, ...(options.deps || {}) };

  fs.mkdirSync(updateRoot, { recursive: true });
  const statePath = path.join(updateRoot, 'state.json');
  const lastResultPath = path.join(updateRoot, 'last-result.json');

  let state = {
    state: enabled ? 'idle' : 'disabled',
    available: false,
    latestVersion: null,
    releaseName: null,
    releaseNotes: null,
    publishedAt: null,
    downloadedBytes: 0,
    totalBytes: 0,
    percent: null,
    error: null,
    lastCheckedAt: null,
    lastResult: null
  };
  // Cache ostatniego poprawnego sprawdzenia - przetrwa restart procesu, zeby
  // przy braku internetu na starcie nadal moc pokazac wczesniej wykryta,
  // wciaz aktualna dostepna aktualizacje (patrz specyfikacja p.10).
  if (enabled) {
    const cached = readJsonSafe(statePath);
    if (cached && typeof cached === 'object') {
      state = {
        ...state,
        available: Boolean(cached.available),
        latestVersion: cached.latestVersion || null,
        releaseName: cached.releaseName || null,
        releaseNotes: cached.releaseNotes || null,
        publishedAt: cached.publishedAt || null,
        lastCheckedAt: cached.lastCheckedAt || null
      };
      const currentVersion = getInstalledVersion().version;
      const stillOutdated = state.latestVersion && isNewerVersion(state.latestVersion, currentVersion);
      if (!stillOutdated) {
        // Zainstalowana wersja dogonila (albo przegonila) ostatnio wykryta -
        // aktualizacja sie udala (albo i tak juz byla aktualna).
        state.available = false;
        state.state = 'idle';
      } else if (cached.state && INSTALL_ACTIVE_STATES.has(cached.state)) {
        // Ostatni zapisany stan to aktywna proba instalacji (downloading/ready/
        // installing/restarting), a mimo to zainstalowana wersja SIE NIE ZMIENILA -
        // aktualizacja albo nigdy nie ruszyla (np. cichy blad odpalenia
        // run-update.ps1), albo zostala przerwana. Bez tego uzytkownik widzial
        // po prostu czysty stan "dostepna aktualizacja" bez zadnej wzmianki, ze
        // cos juz probowano i sie nie udalo - myslal ze aplikacja nic nie robi.
        state.state = 'error';
        state.error = `Poprzednia proba aktualizacji do wersji ${state.latestVersion} nie zakonczyla sie sukcesem (nadal zainstalowana jest wersja ${currentVersion}). Sprobuj ponownie.`;
      } else {
        state.state = 'available';
      }
    }
  }
  const lastResult = readJsonSafe(lastResultPath);
  if (lastResult) state.lastResult = lastResult;

  let cachedRelease = null; // pelne dane wydania (w tym URL-e assetow) - NIGDY nie wystawiane do frontendu
  let checkInFlightPromise = null;
  let installInProgress = false;

  function setState(patch) {
    state = { ...state, ...patch };
  }

  function persistState() {
    try { writeJsonFileNoBom(statePath, getStatusPayload()); } catch (err) { log('warn', 'update-state-persist-failed', { message: err.message }); }
  }

  function getStatusPayload() {
    return {
      enabled,
      state: state.state,
      available: state.available,
      currentVersion: getInstalledVersion().version,
      latestVersion: state.latestVersion,
      releaseName: state.releaseName,
      releaseNotes: state.releaseNotes,
      publishedAt: state.publishedAt,
      downloadedBytes: state.downloadedBytes,
      totalBytes: state.totalBytes,
      percent: state.percent,
      error: state.error,
      lastCheckedAt: state.lastCheckedAt,
      lastResult: state.lastResult
    };
  }

  async function checkForUpdate({ manual = false } = {}) {
    if (!enabled) return { ok: false, message: 'Aktualizacje sa wylaczone.' };
    if (INSTALL_ACTIVE_STATES.has(state.state)) {
      return { ok: false, message: 'Aktualizacja jest juz w trakcie instalowania.' };
    }
    if (checkInFlightPromise) return checkInFlightPromise;

    checkInFlightPromise = (async () => {
      setState({ error: null });
      try {
        const current = getInstalledVersion().version;
        const release = await deps.fetchLatestRelease(repo, { apiBaseUrl, timeoutMs: 10000 });

        if (!release) {
          // Brak stabilnego wydania (nowe repo / tylko drafty) - nie
          // zmieniamy juz znanej dostepnej aktualizacji, jesli taka byla.
          setState({ state: state.available ? 'available' : 'up-to-date', lastCheckedAt: nowIso() });
        } else if (isNewerVersion(release.version, current)) {
          cachedRelease = release;
          setState({
            state: 'available',
            available: true,
            latestVersion: release.version,
            releaseName: release.name,
            releaseNotes: release.notes,
            publishedAt: release.publishedAt,
            lastCheckedAt: nowIso()
          });
        } else {
          cachedRelease = null;
          setState({ state: 'up-to-date', available: false, latestVersion: release.version, lastCheckedAt: nowIso() });
        }
        persistState();
        return { ok: true };
      } catch (err) {
        log('warn', 'update-check-failed', { message: sanitizeForLog(err.message) });
        // Blad sieci/GitHuba nie cofa juz wykrytej, wciaz aktualnej dostepnej
        // aktualizacji i nie pojawia sie jako alarmujacy stan - tylko
        // diagnostyczny komunikat w polu error.
        setState({ error: sanitizeForLog(err.message), lastCheckedAt: nowIso(), state: state.available ? 'available' : 'idle' });
        persistState();
        return { ok: false, message: 'Nie udalo sie sprawdzic aktualizacji.' };
      } finally {
        checkInFlightPromise = null;
      }
    })();
    return checkInFlightPromise;
  }

  // Audyt 2026-08-06 (Chrome/AV + zastrzezenie wlasciciela: node_modules/
  // Chromium, ~1,2 GB, nie moga byc pobierane przy kazdej aktualizacji).
  // Wybiera miedzy pelnym instalatorem a maleńkim wariantem aktualizacyjnym
  // (bez node-runtime/node_modules). Domyslnie ZAWSZE pelny - wariant
  // aktualizacyjny jest uzywany WYLACZNIE gdy WSZYSTKIE warunki sa spelnione:
  // wydanie w ogole go ma (starsze wydania sprzed tej funkcji go nie maja),
  // lokalnie jest znany fingerprint runtime, pobranie zdalnego fingerprinta
  // sie udalo, i oba sie zgadzaja. Kazdy inny przypadek (brak assetu, brak
  // lokalnego pliku, blad sieci, niezgodnosc) bezpiecznie cofa sie do
  // pelnego instalatora - nigdy w druga strone (nigdy nie "zgaduje", ze
  // maly wariant jest bezpieczny, gdy czegokolwiek brakuje do pewnosci).
  async function chooseInstallerAssets(release) {
    const full = { variant: 'full', installerAsset: release.installerAsset, shaAsset: release.shaAsset };
    if (!release.updateInstallerAsset || !release.updateShaAsset || !release.runtimeFingerprintAsset) {
      return full;
    }

    let localFingerprint;
    try {
      localFingerprint = fs.readFileSync(path.join(rootDir, 'runtime-fingerprint.txt'), 'utf8').trim();
    } catch (_) {
      return full; // instalacja sprzed tej funkcji - brak lokalnego fingerprinta
    }
    if (!localFingerprint) return full;

    let remoteFingerprint;
    try {
      remoteFingerprint = (await deps.downloadText(release.runtimeFingerprintAsset.url, { timeoutMs: 15000 })).trim();
    } catch (err) {
      log('warn', 'update-fingerprint-check-failed', { message: sanitizeForLog(err.message) });
      return full; // nie udalo sie sprawdzic - bezpieczniej wziac caly instalator
    }

    if (remoteFingerprint && remoteFingerprint === localFingerprint) {
      return { variant: 'update', installerAsset: release.updateInstallerAsset, shaAsset: release.updateShaAsset };
    }
    return full;
  }

  async function runInstallFlow(release) {
    const versionDir = path.join(updateRoot, release.version);
    fs.mkdirSync(versionDir, { recursive: true });
    cleanupUpdatesDir(updateRoot);

    const chosen = await chooseInstallerAssets(release);
    log('info', 'update-variant-chosen', { variant: chosen.variant, asset: chosen.installerAsset.name });

    const installerName = chosen.installerAsset.name;
    const installerDest = path.join(versionDir, installerName);
    const shaDest = `${installerDest}.sha256`;

    const shaText = await deps.downloadText(chosen.shaAsset.url, { timeoutMs: 15000 });
    const expectedHex = deps.parseSha256File(shaText, installerName);
    fs.writeFileSync(shaDest, shaText, 'utf8');

    const maxBytes = chosen.installerAsset.sizeBytes ? chosen.installerAsset.sizeBytes * 2 : undefined;
    const download = await deps.downloadToPartialFile(chosen.installerAsset.url, installerDest, {
      timeoutMs: 180000,
      maxBytes,
      onProgress: ({ downloadedBytes, totalBytes }) => {
        const percent = totalBytes ? Math.min(99, Math.round((downloadedBytes / totalBytes) * 100)) : null;
        setState({ downloadedBytes, totalBytes, percent });
        persistState();
      }
    });

    if (download.sha256.toLowerCase() !== expectedHex.toLowerCase()) {
      try { fs.unlinkSync(download.partialPath); } catch (_) {}
      throw new Error('Suma kontrolna pobranego instalatora nie zgadza sie - plik zostal odrzucony.');
    }
    fs.renameSync(download.partialPath, installerDest);
    setState({ state: 'ready', percent: 100 });
    persistState();

    // Powtorzone sprawdzenie druku (nie tylko w startInstall()) - pobieranie
    // trwa kilka(-naście) sekund, w ktorych druk mogl sie rozpoczac PO
    // pierwszym kliknieciu. Instalator NIGDY nie powinien zaczac zabijac
    // procesow w trakcie aktywnego wydruku.
    if (isPrintingActive()) {
      throw new Error('Aktualizacja przerwana: drukowanie rozpoczelo sie w trakcie pobierania. Sprobuj ponownie, gdy druk sie zakonczy.');
    }

    // Kopiujemy TERAZ dzialajacy Scyzoryk.exe do katalogu tej konkretnej
    // aktualizacji, zeby przetrwal nawet gdyby instalator zdazyl juz zaczac
    // nadpisywac folder programu, z ktorego zostal skopiowany (ten sam powod,
    // dla ktorego wczesniej kopiowany byl run-update.ps1).
    const launcherSource = path.join(rootDir, 'Scyzoryk.exe');
    const launcherExePath = path.join(versionDir, 'Scyzoryk.exe');
    fs.copyFileSync(launcherSource, launcherExePath);

    setState({ state: 'installing' });
    persistState();
    const invocation = buildUpdaterInvocation({
      launcherExePath,
      installerPath: installerDest,
      updateRoot,
      expectedVersion: release.version
    });
    const spawnedAt = Date.now();
    const updaterChild = deps.spawnUpdaterProcess(invocation);
    // Jesli samo odpalenie procesu aktualizatora zawiedzie (np. ENOENT), spawn()
    // na Windows zglasza to ASYNCHRONICZNIE przez zdarzenie 'error' na obiekcie
    // procesu, nie przez wyjatek w tym miejscu - bez tego nasluchiwania stan
    // zostawal na zawsze w "installing" (100%) bez ZADNEGO widocznego bledu,
    // dokladnie to zlapane realnie przy prawdziwym kliknieciu przycisku. To
    // NADAL warte nasluchiwania (lapie np. ENOENT samego powershell.exe), ale
    // NIE lapie sytuacji gdy proces sie odpalil, a potem zaraz padl - patrz
    // ponizej, dlaczego 'exit' z ta logika juz tu nie wystepuje.
    if (updaterChild && typeof updaterChild.on === 'function') {
      updaterChild.on('error', err => {
        const message = `Nie udalo sie uruchomic procesu aktualizatora: ${sanitizeForLog(err.message)}`;
        log('error', 'update-spawn-failed', { message });
        setState({ state: 'error', error: message });
        persistState();
      });
    }

    // Patrz obszerny komentarz przy realConfirmUpdaterStarted() wyzej -
    // 'exit' na procesie detached na Windows zawsze pokazuje kod 0
    // niezaleznie od realnego wyniku, wiec jedynym wiarygodnym potwierdzeniem
    // jest nowy plik logu na dysku. Sprawdzamy to asynchronicznie, PO
    // powrocie invocation (nie blokuje niczego, co juz czeka na ta funkcje) -
    // jesli proces nie zdazyl nawet zapisac pierwszej linii logu, cos jest
    // powaznie nie tak (antywirus, zasady wykonywania skryptow, uszkodzona
    // kopia run-update.ps1) i uzytkownik musi to zobaczyc, nie czekac
    // bez konca na "installing", ktore nigdy nie ruszy dalej.
    deps.confirmUpdaterStarted({ updateRoot, sinceMs: spawnedAt }).then(started => {
      if (started) return;
      if (state.state !== 'installing') return; // juz zaktualizowane przez 'error' powyzej albo cos innego
      const message = 'Proces aktualizatora nie uruchomil sie (brak nowego logu po uruchomieniu) - mozliwe zablokowanie przez antywirus albo zasady wykonywania skryptow na tym komputerze. Sprobuj ponownie.';
      log('error', 'update-process-never-started', { message });
      setState({ state: 'error', error: message });
      persistState();
    }).catch(() => {});

    return invocation;
  }

  // Rozdzielone na SYNCHRONICZNA czesc (walidacja + odpowiedz HTTP) i
  // asynchroniczny przebieg w tle (pobieranie/weryfikacja/spawn) - dzieki
  // temu endpoint POST /api/update/install odpowiada natychmiast (202), a
  // postep pobierania jest widoczny przez oddzielne odpytywanie
  // GET /api/update/status, zamiast trzymac jedno polaczenie HTTP otwarte na
  // caly czas pobierania.
  function startInstall() {
    if (!enabled) return { started: false, statusCode: 409, message: 'Aktualizacje sa wylaczone.' };
    if (installInProgress || INSTALL_ACTIVE_STATES.has(state.state)) {
      return { started: false, statusCode: 409, message: 'Aktualizacja jest juz w trakcie instalowania.' };
    }
    const retryableAfterError = state.state === 'error' && cachedRelease;
    if (!(state.state === 'available' || retryableAfterError) || !cachedRelease) {
      return { started: false, statusCode: 409, message: 'Nie ma dostepnej nowszej wersji do zainstalowania.' };
    }
    if (isPrintingActive()) {
      return { started: false, statusCode: 409, message: 'Aktualizacja jest zablokowana: trwa drukowanie. Sprobuj ponownie, gdy druk sie zakonczy.' };
    }

    installInProgress = true;
    const release = cachedRelease;
    setState({ state: 'downloading', downloadedBytes: 0, totalBytes: release.installerAsset.sizeBytes || 0, percent: 0, error: null });
    persistState();

    const flowPromise = runInstallFlow(release)
      .catch(err => {
        log('error', 'update-install-failed', { message: sanitizeForLog(err.message) });
        setState({ state: 'error', error: sanitizeForLog(err.message) });
        persistState();
      })
      .finally(() => { installInProgress = false; });

    return { started: true, statusCode: 202, message: 'Rozpoczeto pobieranie aktualizacji.', flowPromise };
  }

  let autoCheckTimer = null;
  function scheduleAutoChecks(intervalMs) {
    if (!enabled) return;
    setTimeout(() => { checkForUpdate({ manual: false }).catch(() => {}); }, 3000).unref();
    autoCheckTimer = setInterval(() => {
      checkForUpdate({ manual: false }).catch(() => {});
    }, Math.max(60000, Number(intervalMs) || 21600000));
    autoCheckTimer.unref();
  }

  function stopAutoChecks() {
    if (autoCheckTimer) clearInterval(autoCheckTimer);
    autoCheckTimer = null;
  }

  return {
    getStatusPayload,
    checkForUpdate,
    startInstall,
    scheduleAutoChecks,
    stopAutoChecks,
    // Wylacznie do testow - podglad wewnetrznego stanu bez przechodzenia
    // przez JSON serializacji getStatusPayload().
    _debugState: () => ({ ...state, hasCachedRelease: Boolean(cachedRelease) })
  };
}

module.exports = { createUpdateService, cleanupUpdatesDir, buildUpdaterInvocation, INSTALL_ACTIVE_STATES, realConfirmUpdaterStarted };
