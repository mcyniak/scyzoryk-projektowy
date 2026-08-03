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

const INSTALL_ACTIVE_STATES = new Set(['downloading', 'ready', 'installing', 'restarting']);

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

// Pelna sciezka do Windows PowerShell 5.1, tak samo jak juz robi to
// installer\scyzoryk.iss dla install-autostart.ps1 ("{sys}\WindowsPowerShell\v1.0\powershell.exe")
// - zlapane realnie: samo "powershell.exe" (poleganie na PATH) zawiodlo przy
// prawdziwym kliknieciu przycisku aktualizacji (proces sie nie odpalil, bez
// zadnego widocznego bledu), mimo ze dzialalo przy recznym Start-Process w
// interaktywnej sesji PowerShell. Pelna sciezka jest odporna na to, czym
// dokladnie jest PATH procesu Node w danym momencie.
function resolvePowerShellExe() {
  const systemRoot = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
  return path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

function buildUpdaterInvocation({ runUpdateScript, installerPath, installDir, updateRoot, expectedVersion, port }) {
  return {
    exe: resolvePowerShellExe(),
    // Argumenty jako osobne elementy tablicy (nigdy skladanie jednego
    // stringa) - bezpieczne wobec spacji/polskich znakow w sciezkach
    // (np. "C:\Users\Jan Kowalski\AppData\Local\...").
    args: [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden',
      '-File', runUpdateScript,
      '-InstallerPath', installerPath,
      '-InstallDir', installDir,
      '-UpdateRoot', updateRoot,
      '-ExpectedVersion', expectedVersion,
      '-Port', String(port || 3000)
    ]
  };
}

// Produkcyjna implementacja odpalenia aktualizatora: odlaczony proces, bez
// okna, bez dziedziczenia stdio, .unref() zeby nie blokowal zamkniecia
// procesu Node. NIGDY nie jest wywolywana wprost z testow (patrz deps w
// createUpdateService) - testy podstawiaja funkcje, ktora tylko zapisuje
// argumenty, z ktorymi ZOSTAŁABY wywolana.
function realSpawnUpdaterProcess({ exe, args }) {
  const child = spawn(exe, args, { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
  return child;
}

const defaultDeps = {
  fetchLatestRelease: updateGithub.fetchLatestRelease,
  assetFileName: updateGithub.assetFileName,
  downloadText: updateDownload.downloadText,
  downloadToPartialFile: updateDownload.downloadToPartialFile,
  parseSha256File: updateDownload.parseSha256File,
  spawnUpdaterProcess: realSpawnUpdaterProcess,
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
    port,
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
      state.state = state.available ? 'available' : 'idle';
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

  async function runInstallFlow(release) {
    const versionDir = path.join(updateRoot, release.version);
    fs.mkdirSync(versionDir, { recursive: true });
    cleanupUpdatesDir(updateRoot);

    const installerName = deps.assetFileName(release.version);
    const installerDest = path.join(versionDir, installerName);
    const shaDest = `${installerDest}.sha256`;

    const shaText = await deps.downloadText(release.shaAsset.url, { timeoutMs: 15000 });
    const expectedHex = deps.parseSha256File(shaText, installerName);
    fs.writeFileSync(shaDest, shaText, 'utf8');

    const maxBytes = release.installerAsset.sizeBytes ? release.installerAsset.sizeBytes * 2 : undefined;
    const download = await deps.downloadToPartialFile(release.installerAsset.url, installerDest, {
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

    // Kopiujemy TERAZ dzialajacy skrypt aktualizatora do katalogu tej
    // konkretnej aktualizacji, zeby przetrwal nawet gdyby instalator zdazyl
    // juz zaczac nadpisywac folder programu, z ktorego zostal skopiowany.
    const runUpdateSource = path.join(rootDir, 'scripts', 'run-update.ps1');
    const runUpdateScript = path.join(versionDir, 'run-update.ps1');
    fs.copyFileSync(runUpdateSource, runUpdateScript);

    setState({ state: 'installing' });
    persistState();
    const invocation = buildUpdaterInvocation({
      runUpdateScript,
      installerPath: installerDest,
      installDir: rootDir,
      updateRoot,
      expectedVersion: release.version,
      port
    });
    const updaterChild = deps.spawnUpdaterProcess(invocation);
    // Jesli samo odpalenie procesu aktualizatora zawiedzie (np. ENOENT), spawn()
    // na Windows zglasza to ASYNCHRONICZNIE przez zdarzenie 'error' na obiekcie
    // procesu, nie przez wyjatek w tym miejscu - bez tego nasluchiwania stan
    // zostawal na zawsze w "installing" (100%) bez ZADNEGO widocznego bledu,
    // dokladnie to zlapane realnie przy prawdziwym kliknieciu przycisku.
    if (updaterChild && typeof updaterChild.on === 'function') {
      updaterChild.on('error', err => {
        const message = `Nie udalo sie uruchomic procesu aktualizatora: ${sanitizeForLog(err.message)}`;
        log('error', 'update-spawn-failed', { message });
        setState({ state: 'error', error: message });
        persistState();
      });
    }
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

module.exports = { createUpdateService, cleanupUpdatesDir, buildUpdaterInvocation, INSTALL_ACTIVE_STATES };
