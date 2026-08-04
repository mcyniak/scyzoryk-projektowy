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
    private readonly LauncherTimings _timings;

    public LauncherApp(
        InstallPaths paths,
        IHealthChecker health,
        IProcessManager processManager,
        IBrowserLauncher browser,
        ISingleInstanceGate gate,
        ILauncherLogger logger,
        IFatalErrorPresenter errorPresenter,
        LauncherTimings? timings = null)
    {
        _paths = paths;
        _health = health;
        _processManager = processManager;
        _browser = browser;
        _gate = gate;
        _logger = logger;
        _errorPresenter = errorPresenter;
        _timings = timings ?? LauncherTimings.Production;
    }

    public async Task<int> RunAsync(LauncherMode mode)
    {
        _logger.Log(LogLevel.Info, "Start launchera.", new Dictionary<string, string>
        {
            ["mode"] = mode.ToString(),
            ["installDir"] = _paths.InstallDir,
        });

        return mode switch
        {
            LauncherMode.Normal => await RunNormalAsync().ConfigureAwait(false),
            LauncherMode.Autostart => await RunAutostartAsync().ConfigureAwait(false),
            LauncherMode.Stop => await RunStopAsync().ConfigureAwait(false),
            LauncherMode.Health => await RunHealthAsync().ConfigureAwait(false),
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
            _timings.WaiterTopUpTimeout, TimeSpan.Zero, () => false).ConfigureAwait(false);

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
            _timings.BaseStartupTimeout, _timings.ExtendedStartupTimeout, () => _processManager.IsProcessStillAlive(spawn.Pid)).ConfigureAwait(false);
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
        if (!File.Exists(_paths.NodeExePath))
        {
            _logger.Log(LogLevel.Info, "Brak node-runtime\\node.exe - nic do zatrzymania.");
            return Task.FromResult(ExitCodes.Ok);
        }

        var stopped = _processManager.StopOwnedProcesses(_paths.NodeExePath);
        _logger.Log(LogLevel.Info, "Zatrzymano procesy Scyzoryka (--stop).", new Dictionary<string, string>
        {
            ["count"] = stopped.Count.ToString(),
            ["pids"] = string.Join(",", stopped),
        });

        // --stop zawsze zwraca 0, nawet jesli nic nie dzialalo lub pojedyncze
        // zatrzymanie sie nie udalo (juz obsluzone/zalogowane wewnatrz ProcessManager) -
        // jedynym sposobem na kod niezerowy jest siatka bezpieczenstwa w Program.cs.
        return Task.FromResult(ExitCodes.Ok);
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

    private int LogUnknownArgumentAndExit()
    {
        _logger.Log(LogLevel.Error, "Nieznany argument wiersza polecen - brak jakichkolwiek efektow.");
        return ExitCodes.UnknownArgument;
    }
}
