namespace Scyzoryk.Launcher;

internal sealed record EnsureResult(bool Healthy, string? ErrorMessage)
{
    public static EnsureResult Ok() => new(true, null);
    public static EnsureResult Fail(string message) => new(false, message);
}

/// <summary>
/// Orkiestrator - jedyna klasa z realnym rozgałęzieniem logiki, w calosci
/// testowalna przez wstrzykniete interfejsy (zero realnej przegladarki/procesu w
/// testach jednostkowych, poza kilkoma integracyjno-lekkimi testami ProcessManagera).
/// </summary>
public sealed class LauncherApp
{
    private readonly InstallPaths _paths;
    private readonly IHealthChecker _health;
    private readonly IProcessManager _processManager;
    private readonly IBrowserLauncher _browser;
    private readonly ISingleInstanceGate _gate;
    private readonly ILauncherLogger _logger;
    private readonly IFatalErrorPresenter _errorPresenter;
    private readonly IUpdateApplier _updateApplier;
    private readonly IAutostartManager _autostartManager;
    private readonly ITrayIconHost _tray;
    private readonly LauncherTimings _timings;

    /// <summary>Domyslny "brak ikony" - TryRunResident zawsze zwraca false (nigdy nie
    /// blokuje, nigdy nie dotyka realnego WinForms). Uzywany wylacznie gdy wywolujacy
    /// nie poda wlasnego ITrayIconHost - istniejace testy/wywolania sprzed wprowadzenia
    /// ikony w zasobniku dalej dzialaja dokladnie tak jak wczesniej (Program.cs
    /// zawsze jawnie podaje prawdziwy NotifyIconTrayHost).</summary>
    private sealed class NullTrayIconHost : ITrayIconHost
    {
        public bool TryRunResident(Action onOpenPanel, Action onQuit) => false;
    }

    public LauncherApp(
        InstallPaths paths,
        IHealthChecker health,
        IProcessManager processManager,
        IBrowserLauncher browser,
        ISingleInstanceGate gate,
        ILauncherLogger logger,
        IFatalErrorPresenter errorPresenter,
        IUpdateApplier updateApplier,
        IAutostartManager autostartManager,
        LauncherTimings? timings = null,
        ITrayIconHost? tray = null)
    {
        _paths = paths;
        _health = health;
        _processManager = processManager;
        _browser = browser;
        _gate = gate;
        _logger = logger;
        _errorPresenter = errorPresenter;
        _updateApplier = updateApplier;
        _autostartManager = autostartManager;
        _timings = timings ?? LauncherTimings.Production;
        _tray = tray ?? new NullTrayIconHost();
    }

    public async Task<int> RunAsync(ParsedArgs args)
    {
        _logger.Log(LogLevel.Info, "Start launchera.", new Dictionary<string, string>
        {
            ["mode"] = args.Mode.ToString(),
            ["installDir"] = _paths.InstallDir,
        });

        return args.Mode switch
        {
            LauncherMode.Normal => await RunNormalAsync().ConfigureAwait(false),
            LauncherMode.Autostart => await RunAutostartAsync().ConfigureAwait(false),
            LauncherMode.Stop => await RunStopAsync().ConfigureAwait(false),
            LauncherMode.Health => await RunHealthAsync().ConfigureAwait(false),
            LauncherMode.ApplyUpdate => await RunApplyUpdateAsync(args.InstallerPath!, args.ExpectedVersion!, args.ParentPid, args.ResidentTrayPid).ConfigureAwait(false),
            LauncherMode.RegisterAutostart => RunRegisterAutostart(),
            LauncherMode.UnregisterAutostart => RunUnregisterAutostart(),
            _ => LogUnknownArgumentAndExit(),
        };
    }

    private Task<int> RunNormalAsync() => RunEnsureAndReportAsync(openBrowserOnSuccess: true);

    private Task<int> RunAutostartAsync() => RunEnsureAndReportAsync(openBrowserOnSuccess: false);

    private async Task<int> RunEnsureAndReportAsync(bool openBrowserOnSuccess)
    {
        if (!_paths.TryValidate(out var missingFriendlyName, out var missingFullPath))
        {
            var message =
                $"Brak wymaganego pliku: {missingFriendlyName} ({missingFullPath}).\n" +
                "Zainstaluj Scyzoryka Projektowego ponownie.\n" +
                $"Szczegoly: {_paths.LogFilePath}";

            _logger.Log(LogLevel.Error, "Brak wymaganego pliku - nie podejmuje próby startu.", new Dictionary<string, string>
            {
                ["missingFile"] = missingFullPath ?? string.Empty,
            });
            _errorPresenter.Show(message);
            return ExitCodes.MissingFile;
        }

        var ensure = await EnsureServerRunningAsync().ConfigureAwait(false);
        if (!ensure.Healthy)
        {
            var message =
                $"Nie udalo sie uruchomic Scyzoryka Projektowego.\n{ensure.ErrorMessage}\n" +
                $"Szczegoly: {_paths.LogFilePath}";

            _logger.Log(LogLevel.Error, "Start zakonczony niepowodzeniem.", new Dictionary<string, string>
            {
                ["reason"] = ensure.ErrorMessage ?? string.Empty,
            });
            _errorPresenter.Show(message);
            return ExitCodes.StartupFailed;
        }

        if (openBrowserOnSuccess)
        {
            _browser.OpenDefaultBrowser(_paths.PanelUrl);
        }

        _logger.Log(LogLevel.Info, "Start zakonczony sukcesem.", new Dictionary<string, string>
        {
            ["openedBrowser"] = openBrowserOnSuccess.ToString(),
        });

        // Ikona w zasobniku - widoczny znak, ze Scyzoryk dziala, z prostym menu do
        // otwarcia panelu albo zamkniecia. TryRunResident sam sprawdza, czy inny
        // rezydentny proces juz ma ikone (patrz InstallPaths.TrayMutexName) - jesli
        // tak, wraca od razu (dokladnie dawne zachowanie, bez blokowania). Jesli
        // zostajemy wlascicielem, BLOKUJE tutaj az do wybrania "Zamknij Scyzoryka" -
        // dotyczy zarowno zwyklego startu, jak i --autostart (logowanie tez ma dostac
        // widoczna ikone, nie tylko klikniecie skrotu).
        _tray.TryRunResident(
            onOpenPanel: () => _browser.OpenDefaultBrowser(_paths.PanelUrl),
            onQuit: () => _processManager.StopOwnedProcesses(_paths.NodeExePath));

        return ExitCodes.Ok;
    }

    /// <summary>
    /// Sprawdza czy panel juz zyje; jesli nie - przejmuje (albo czeka na przejecie
    /// przez kogos innego) odpowiedzialnosc za odpalenie node.exe. Muteks jest
    /// trzymany WYLACZNIE na czas tego kroku - nigdy przez otwieranie przegladarki.
    /// </summary>
    private async Task<EnsureResult> EnsureServerRunningAsync()
    {
        if (await _health.ProbeAlreadyRunningAsync(
                _paths.HealthUrl, _timings.ProbeAttempts, _timings.ProbeAttemptTimeout, _timings.ProbeDelayBetween).ConfigureAwait(false))
        {
            _logger.Log(LogLevel.Info, "Panel juz odpowiada - nie odpalam nowego procesu.");
            return EnsureResult.Ok();
        }

        _logger.Log(LogLevel.Info, "Panel nie odpowiada po kilku probach - probuje przejac start.");

        if (_gate.TryAcquire(_timings.OwnerAcquireTimeout))
        {
            try
            {
                return await StartAndWaitAsOwnerAsync().ConfigureAwait(false);
            }
            finally
            {
                _gate.Release();
            }
        }

        _logger.Log(LogLevel.Info, "Inna instancja launchera juz odpala serwer - czekam na jej wynik, bez wlasnego spawnu.");
        var waiterOutcome = await _health.WaitForHealthyAsync(
            _paths.HealthUrl, _timings.WaiterTopUpTimeout, TimeSpan.Zero, () => false).ConfigureAwait(false);

        return waiterOutcome == HealthWaitOutcome.Healthy
            ? EnsureResult.Ok()
            : EnsureResult.Fail("Inna instancja Scyzoryka probowala wystartowac serwer, ale nie doczekano sie odpowiedzi w wyznaczonym czasie.");
    }

    private async Task<EnsureResult> StartAndWaitAsOwnerAsync()
    {
        // Krotkie ponowne sprawdzenie na wypadek nieszkodliwej gonitwy - ktos inny mogl
        // zdazyc wystartowac miedzy naszym probe a przejeciem muteksu.
        if (await _health.IsRespondingOnceAsync(_paths.HealthUrl, TimeSpan.FromSeconds(2)).ConfigureAwait(false))
        {
            return EnsureResult.Ok();
        }

        var stopped = _processManager.StopOwnedProcesses(_paths.NodeExePath);
        if (stopped.Count > 0)
        {
            _logger.Log(LogLevel.Info, "Zatrzymano nieodpowiadajace procesy Scyzoryka przed ponownym startem.", new Dictionary<string, string>
            {
                ["pids"] = string.Join(",", stopped),
            });
        }

        var spawn = _processManager.StartServer(_paths.InstallDir, _paths.NodeExePath);
        if (!spawn.Success)
        {
            return EnsureResult.Fail($"Nie udalo sie odpalic serwera: {spawn.ErrorMessage}");
        }

        _logger.Log(LogLevel.Info, "Odpalono serwer.", new Dictionary<string, string> { ["pid"] = spawn.Pid.ToString() });

        var startedAt = DateTime.UtcNow;
        var outcome = await _health.WaitForHealthyAsync(
            _paths.HealthUrl, _timings.BaseStartupTimeout, _timings.ExtendedStartupTimeout, () => _processManager.IsProcessStillAlive(spawn.Pid)).ConfigureAwait(false);
        var elapsedSeconds = (DateTime.UtcNow - startedAt).TotalSeconds;

        _logger.Log(LogLevel.Info, "Zakonczono oczekiwanie na zdrowy serwer.", new Dictionary<string, string>
        {
            ["outcome"] = outcome.ToString(),
            ["elapsedSeconds"] = elapsedSeconds.ToString("F0"),
        });

        return outcome switch
        {
            HealthWaitOutcome.Healthy => EnsureResult.Ok(),
            HealthWaitOutcome.TimedOutProcessDead =>
                EnsureResult.Fail($"Serwer zakonczyl dzialanie przed osiagnieciem stanu 'zdrowy' (po {elapsedSeconds:F0}s)."),
            HealthWaitOutcome.TimedOutProcessAlive =>
                EnsureResult.Fail($"Serwer nie odpowiedzial w oczekiwanym czasie (po {elapsedSeconds:F0}s), mimo ze proces wciaz dziala - moze wciaz instalowac zaleznosci."),
            _ => EnsureResult.Fail("Nieznany wynik oczekiwania na start serwera."),
        };
    }

    private Task<int> RunStopAsync()
    {
        if (File.Exists(_paths.NodeExePath))
        {
            var stopped = _processManager.StopOwnedProcesses(_paths.NodeExePath);
            _logger.Log(LogLevel.Info, "Zatrzymano procesy Scyzoryka (--stop).", new Dictionary<string, string>
            {
                ["count"] = stopped.Count.ToString(),
                ["pids"] = string.Join(",", stopped),
            });
        }
        else
        {
            _logger.Log(LogLevel.Info, "Brak node-runtime\\node.exe - pomijam zatrzymywanie node.exe.");
        }

        // Audyt v1.1.6 (zlapane na CI, exit code 5 przy cichej aktualizacji): --stop
        // jest kanonicznym "wygaś Scyzoryka calkowicie" - uzywanym przez
        // [UninstallRun] i przez reczna ciche uruchomienie instalatora z
        // /SCYZORYKUPDATE (bez przejscia przez Scyzoryk.exe --apply-update, ktore
        // samo juz zamyka rezydentna ikone przed instalacja). Rezydentna ikona w
        // zasobniku trzyma otwarty WLASNY plik Scyzoryk.exe przez cala swoja
        // zywotnosc - bez tego wywolania instalator/deinstalator dostawal
        // Abort-Retry-Ignore przy probie nadpisania/usuniecia zablokowanego pliku.
        // Wywolywane ZAWSZE, niezaleznie od obecnosci node.exe - to dwa niezalezne
        // pliki/procesy (patrz tez wykluczenie wlasnego PID w ProcessManager, zeby
        // to wywolanie nie zabilo samo siebie).
        var closedTray = _processManager.StopResidentTrayProcesses(_paths.ScyzorykExePath);
        _logger.Log(LogLevel.Info, "Zamknieto rezydentna ikone w zasobniku (--stop).", new Dictionary<string, string>
        {
            ["count"] = closedTray.Count.ToString(),
            ["pids"] = string.Join(",", closedTray),
        });

        // --stop zawsze zwraca 0, nawet jesli nic nie dzialalo lub pojedyncze
        // zatrzymanie sie nie udalo (juz obsluzone/zalogowane wewnatrz ProcessManager) -
        // jedynym sposobem na kod niezerowy jest siatka bezpieczenstwa w Program.cs.
        return Task.FromResult(ExitCodes.Ok);
    }

    /// <summary>
    /// Zastepuje dawne installer\scyzoryk.iss [Run]: "powershell.exe
    /// -ExecutionPolicy Bypass -File install-autostart.ps1" (Flags: runhidden) -
    /// zlapane realnie 2026-08-06: dokladnie ten wzorzec (ukryty interpreter
    /// odpalany z ominieciem polityki wykonania) byl powodem, dla ktorego Chrome/AV
    /// flagowaly pobrany instalator jako wirus na czesci komputerow. Zawsze zwraca
    /// ExitCodes.Ok, tak jak RunStopAsync - nieudana rejestracja autostartu (np.
    /// brak uprawnien do Harmonogramu Zadan) nie moze przerwac calej instalacji,
    /// uzytkownik moze zarejestrowac autostart pozniej recznie.
    /// </summary>
    private int RunRegisterAutostart()
    {
        var exePath = Path.Combine(_paths.InstallDir, "Scyzoryk.exe");
        var result = _autostartManager.Register(exePath);
        _logger.Log(result.Success ? LogLevel.Info : LogLevel.Warning, "Rejestracja autostartu (--register-autostart).", new Dictionary<string, string>
        {
            ["success"] = result.Success.ToString(),
            ["error"] = result.ErrorMessage ?? string.Empty,
        });
        return ExitCodes.Ok;
    }

    /// <summary>Zastepuje dawne installer\scyzoryk.iss [Run]: "powershell.exe
    /// -ExecutionPolicy Bypass -File uninstall-autostart.ps1" - patrz
    /// RunRegisterAutostart dla pelnego uzasadnienia.</summary>
    private int RunUnregisterAutostart()
    {
        var result = _autostartManager.Unregister();
        _logger.Log(result.Success ? LogLevel.Info : LogLevel.Warning, "Wyrejestrowanie autostartu (--unregister-autostart).", new Dictionary<string, string>
        {
            ["success"] = result.Success.ToString(),
            ["error"] = result.ErrorMessage ?? string.Empty,
        });
        return ExitCodes.Ok;
    }

    private async Task<int> RunHealthAsync()
    {
        var healthy = await _health.IsRespondingOnceAsync(_paths.HealthUrl, _timings.HealthCommandTimeout).ConfigureAwait(false);
        _logger.Log(healthy ? LogLevel.Info : LogLevel.Warning, "Wynik --health.", new Dictionary<string, string>
        {
            ["healthy"] = healthy.ToString(),
        });
        return healthy ? ExitCodes.Ok : ExitCodes.HealthNotResponding;
    }

    /// <summary>
    /// Zastepuje dawny scripts\run-update.ps1 (usuniety) - zlapane realnie
    /// (2026-08-05): firmowy EDR na maszynie wlasciciela zabijal cichy
    /// powershell.exe -ExecutionPolicy Bypass -WindowStyle Hidden odpalany przez
    /// Node w ramach aktualizacji (0 bajtow stdout/stderr, proces nigdy nie
    /// pojawial sie na liscie procesow, zero lokalnie widocznych sladow w
    /// Defenderze/AppLockerze) - klasyczna sygnatura "living-off-the-land
    /// dropper" (interpreter odpala ukryty interpreter, ktory uruchamia
    /// niepodpisany .exe). Ten tryb usuwa PowerShella z lancucha calkowicie:
    /// Node (lib/updateService.js) spawnuje TERAZ kopie tego samego, juz
    /// zainstalowanego i zaufanego Scyzoryk.exe z argumentem --apply-update,
    /// zamiast powershell.exe. Zawsze zwraca ExitCodes.Ok niezaleznie od
    /// wyniku aktualizacji - dokladnie ten sam, juz udokumentowany wzorzec co
    /// RunStopAsync: to krok wywolywany automatycznie z panelu w przegladarce,
    /// nieudana (opcjonalna) aktualizacja nie moze pokazac uzytkownikowi
    /// przerazajacego okna bledu - wynik i tak trafia do last-result.json,
    /// ktore czyta panel.
    /// </summary>
    private async Task<int> RunApplyUpdateAsync(string installerPath, string expectedVersion, string? parentPid, string? residentTrayPid)
    {
        try
        {
            await _updateApplier.ApplyAsync(installerPath, expectedVersion, parentPid, residentTrayPid).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            _logger.Log(LogLevel.Error, "Nieobslugiwany wyjatek podczas --apply-update.", new Dictionary<string, string>
            {
                ["exception"] = ex.ToString(),
            });
        }

        return ExitCodes.Ok;
    }

    private int LogUnknownArgumentAndExit()
    {
        _logger.Log(LogLevel.Error, "Nieznany argument wiersza polecen - brak jakichkolwiek efektow.");
        return ExitCodes.UnknownArgument;
    }
}
