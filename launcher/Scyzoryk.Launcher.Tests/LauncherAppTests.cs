using Scyzoryk.Launcher.Tests.Fakes;
using Xunit;

namespace Scyzoryk.Launcher.Tests;

public sealed class LauncherAppTests
{
    private static (LauncherApp App, FakeHealthChecker Health, FakeProcessManager Process, FakeBrowserLauncher Browser, FakeSingleInstanceGate Gate, FakeLauncherLogger Logger, FakeFatalErrorPresenter ErrorPresenter, FakeUpdateApplier UpdateApplier, FakeAutostartManager AutostartManager)
        CreateApp(InstallPaths paths)
    {
        var health = new FakeHealthChecker();
        var process = new FakeProcessManager();
        var browser = new FakeBrowserLauncher();
        var gate = new FakeSingleInstanceGate();
        var logger = new FakeLauncherLogger();
        var errorPresenter = new FakeFatalErrorPresenter();
        var updateApplier = new FakeUpdateApplier();
        var autostartManager = new FakeAutostartManager();
        var app = new LauncherApp(paths, health, process, browser, gate, logger, errorPresenter, updateApplier, autostartManager, TestTimings.Fast);
        return (app, health, process, browser, gate, logger, errorPresenter, updateApplier, autostartManager);
    }

    private static ParsedArgs Args(LauncherMode mode) => new(mode);

    [Fact]
    public async Task AlreadyRunning_NormalMode_OpensBrowserOnce_NoSpawn()
    {
        using var dir = new TempInstallDir();
        var (app, health, process, browser, gate, _, _, _, _) = CreateApp(dir.Paths);
        health.AlreadyRunningResult = true;

        var code = await app.RunAsync(Args(LauncherMode.Normal));

        Assert.Equal(ExitCodes.Ok, code);
        Assert.Equal(1, browser.OpenCallCount);
        Assert.Equal(dir.Paths.PanelUrl, browser.LastUrl);
        Assert.Equal(0, process.StartServerCallCount);
        Assert.Equal(0, gate.TryAcquireCallCount);
    }

    [Fact]
    public async Task AlreadyRunning_AutostartMode_NoBrowserOpen_NoSpawn()
    {
        using var dir = new TempInstallDir();
        var (app, health, process, browser, gate, _, _, _, _) = CreateApp(dir.Paths);
        health.AlreadyRunningResult = true;

        var code = await app.RunAsync(Args(LauncherMode.Autostart));

        Assert.Equal(ExitCodes.Ok, code);
        Assert.Equal(0, browser.OpenCallCount);
        Assert.Equal(0, process.StartServerCallCount);
        Assert.Equal(0, gate.TryAcquireCallCount);
    }

    [Fact]
    public async Task NotRunning_NormalMode_SpawnsThenOpensBrowserOnce()
    {
        using var dir = new TempInstallDir();
        var (app, health, process, browser, gate, _, _, _, _) = CreateApp(dir.Paths);
        health.AlreadyRunningResult = false;
        health.RespondOnceResult = false;
        health.WaitOutcomeResult = HealthWaitOutcome.Healthy;
        gate.AcquireResult = true;
        process.SpawnResultToReturn = SpawnResult.Ok(4321);

        var code = await app.RunAsync(Args(LauncherMode.Normal));

        Assert.Equal(ExitCodes.Ok, code);
        Assert.Equal(1, process.StartServerCallCount);
        Assert.Equal(dir.Paths.InstallDir, process.LastInstallDir);
        Assert.Equal(dir.Paths.NodeExePath, process.LastNodeExePath);
        Assert.Equal(1, browser.OpenCallCount);
        Assert.Equal(1, gate.ReleaseCallCount);
    }

    [Fact]
    public async Task NotRunning_AutostartMode_SpawnsAndNeverOpensBrowser()
    {
        using var dir = new TempInstallDir();
        var (app, health, process, browser, gate, _, _, _, _) = CreateApp(dir.Paths);
        health.AlreadyRunningResult = false;
        health.RespondOnceResult = false;
        health.WaitOutcomeResult = HealthWaitOutcome.Healthy;
        gate.AcquireResult = true;
        process.SpawnResultToReturn = SpawnResult.Ok(4321);

        var code = await app.RunAsync(Args(LauncherMode.Autostart));

        Assert.Equal(ExitCodes.Ok, code);
        Assert.Equal(1, process.StartServerCallCount);
        Assert.Equal(0, browser.OpenCallCount);
        Assert.Equal(1, gate.ReleaseCallCount);
    }

    // =====================================================================
    // Ikona w zasobniku (ITrayIconHost) - dodane razem z NotifyIconTrayHost.
    // Testy tutaj konstruuja LauncherApp bezposrednio (nie przez CreateApp,
    // ktory nie zna tray) z FakeTrayIconHost, zeby nigdy nie dotykac realnego
    // WinForms/petli komunikatow w testach jednostkowych.
    // =====================================================================

    [Fact]
    public async Task SuccessfulStart_NormalMode_CallsTryRunResident_WithWorkingCallbacks()
    {
        using var dir = new TempInstallDir();
        var health = new FakeHealthChecker { AlreadyRunningResult = true };
        var process = new FakeProcessManager();
        var browser = new FakeBrowserLauncher();
        var tray = new FakeTrayIconHost { BecomeOwner = true };
        var app = new LauncherApp(dir.Paths, health, process, browser, new FakeSingleInstanceGate(),
            new FakeLauncherLogger(), new FakeFatalErrorPresenter(), new FakeUpdateApplier(), new FakeAutostartManager(),
            TestTimings.Fast, tray);

        var code = await app.RunAsync(Args(LauncherMode.Normal));

        Assert.Equal(ExitCodes.Ok, code);
        Assert.Equal(1, tray.TryRunResidentCallCount);

        // Callbacki przekazane do TryRunResident faktycznie robia to, co maja -
        // "Otworz panel" otwiera przegladarke na PanelUrl, "Zamknij Scyzoryka"
        // zatrzymuje node.exe (nie samo Scyzoryk.exe - to robi UpdateApplier
        // osobno przy aktualizacji, patrz UpdateApplierTests).
        var browserOpensBefore = browser.OpenCallCount;
        tray.SimulateOpenPanelClicked();
        Assert.Equal(browserOpensBefore + 1, browser.OpenCallCount);
        Assert.Equal(dir.Paths.PanelUrl, browser.LastUrl);

        tray.SimulateQuitClicked();
        Assert.Equal(1, process.StopOwnedProcessesCallCount);
        Assert.Equal(dir.Paths.NodeExePath, process.LastExpectedNodeExeFullPath);
    }

    [Fact]
    public async Task SuccessfulStart_AutostartMode_AlsoCallsTryRunResident()
    {
        // Audyt: logowanie (--autostart) tez ma dostac widoczna ikone, nie tylko
        // recznie klikniety skrot - obie sciezki ida przez ta sama
        // RunEnsureAndReportAsync.
        using var dir = new TempInstallDir();
        var health = new FakeHealthChecker { AlreadyRunningResult = true };
        var tray = new FakeTrayIconHost { BecomeOwner = false };
        var app = new LauncherApp(dir.Paths, health, new FakeProcessManager(), new FakeBrowserLauncher(), new FakeSingleInstanceGate(),
            new FakeLauncherLogger(), new FakeFatalErrorPresenter(), new FakeUpdateApplier(), new FakeAutostartManager(),
            TestTimings.Fast, tray);

        var code = await app.RunAsync(Args(LauncherMode.Autostart));

        Assert.Equal(ExitCodes.Ok, code);
        Assert.Equal(1, tray.TryRunResidentCallCount);
    }

    [Fact]
    public async Task AnotherResidentAlreadyOwnsTray_TryRunResidentReturnsFalse_StillReturnsOk()
    {
        // Gdy inny rezydentny proces juz ma ikone, TryRunResident wraca false bez
        // blokowania - RunEnsureAndReportAsync i tak konczy sie normalnie Ok.
        using var dir = new TempInstallDir();
        var health = new FakeHealthChecker { AlreadyRunningResult = true };
        var tray = new FakeTrayIconHost { BecomeOwner = false };
        var app = new LauncherApp(dir.Paths, health, new FakeProcessManager(), new FakeBrowserLauncher(), new FakeSingleInstanceGate(),
            new FakeLauncherLogger(), new FakeFatalErrorPresenter(), new FakeUpdateApplier(), new FakeAutostartManager(),
            TestTimings.Fast, tray);

        var code = await app.RunAsync(Args(LauncherMode.Normal));

        Assert.Equal(ExitCodes.Ok, code);
        Assert.Equal(1, tray.TryRunResidentCallCount);
    }

    [Fact]
    public async Task StartupFailed_NeverCallsTryRunResident()
    {
        // Nieudany start (serwer sie nie odpowiada) nie moze pokazac ikony -
        // nie ma nic "dzialajacego" do reprezentowania.
        using var dir = new TempInstallDir();
        var health = new FakeHealthChecker
        {
            AlreadyRunningResult = false,
            RespondOnceResult = false,
            WaitOutcomeResult = HealthWaitOutcome.TimedOutProcessAlive
        };
        var gate = new FakeSingleInstanceGate { AcquireResult = true };
        var tray = new FakeTrayIconHost { BecomeOwner = true };
        var app = new LauncherApp(dir.Paths, health, new FakeProcessManager(), new FakeBrowserLauncher(), gate,
            new FakeLauncherLogger(), new FakeFatalErrorPresenter(), new FakeUpdateApplier(), new FakeAutostartManager(),
            TestTimings.Fast, tray);

        var code = await app.RunAsync(Args(LauncherMode.Normal));

        Assert.Equal(ExitCodes.StartupFailed, code);
        Assert.Equal(0, tray.TryRunResidentCallCount);
    }

    [Fact]
    public async Task MissingNodeExe_NormalMode_NoSpawnAttempted_ReturnsNonZero_LogsReadableError()
    {
        using var dir = new TempInstallDir(includeNodeExe: false);
        var (app, health, process, browser, gate, logger, errorPresenter, _, _) = CreateApp(dir.Paths);

        var code = await app.RunAsync(Args(LauncherMode.Normal));

        Assert.Equal(ExitCodes.MissingFile, code);
        Assert.Equal(0, process.StartServerCallCount);
        Assert.Equal(0, health.ProbeAlreadyRunningCallCount);
        Assert.Equal(0, browser.OpenCallCount);
        Assert.Equal(0, gate.TryAcquireCallCount);
        Assert.Equal(1, errorPresenter.ShowCallCount);
        Assert.Contains("node-runtime", errorPresenter.LastMessage, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("   at ", errorPresenter.LastMessage); // brak surowego stack trace
        Assert.True(logger.HasEntryAt(LogLevel.Error));
    }

    [Fact]
    public async Task MissingServerJs_NormalMode_NoSpawnAttempted_ReturnsNonZero()
    {
        using var dir = new TempInstallDir(includeNodeExe: true, includeServerJs: false);
        var (app, health, process, _, _, _, errorPresenter, _, _) = CreateApp(dir.Paths);

        var code = await app.RunAsync(Args(LauncherMode.Normal));

        Assert.Equal(ExitCodes.MissingFile, code);
        Assert.Equal(0, process.StartServerCallCount);
        Assert.Equal(0, health.ProbeAlreadyRunningCallCount);
        Assert.Contains("server.js", errorPresenter.LastMessage);
    }

    [Fact]
    public async Task MissingNodeExe_StopMode_StillReturnsZero()
    {
        using var dir = new TempInstallDir(includeNodeExe: false);
        var (app, _, process, _, _, _, _, _, _) = CreateApp(dir.Paths);

        var code = await app.RunAsync(Args(LauncherMode.Stop));

        Assert.Equal(ExitCodes.Ok, code);
        Assert.Equal(0, process.StopOwnedProcessesCallCount);
        // Audyt v1.1.6: rezydentna ikona (Scyzoryk.exe) jest calkowicie niezalezna
        // od obecnosci node-runtime\node.exe - --stop musi ja zamknac nawet gdy
        // node.exe brakuje.
        Assert.Equal(1, process.StopResidentTrayProcessesCallCount);
    }

    [Fact]
    public async Task TwoParallelLaunches_OnlyFirstSpawns_SecondWaitsOnHealthWithoutSpawning()
    {
        using var dir = new TempInstallDir();

        var health1 = new FakeHealthChecker { AlreadyRunningResult = false, RespondOnceResult = false, WaitOutcomeResult = HealthWaitOutcome.Healthy };
        var gate1 = new FakeSingleInstanceGate { AcquireResult = true };
        var process1 = new FakeProcessManager { SpawnResultToReturn = SpawnResult.Ok(111) };
        var app1 = new LauncherApp(dir.Paths, health1, process1, new FakeBrowserLauncher(), gate1, new FakeLauncherLogger(), new FakeFatalErrorPresenter(), new FakeUpdateApplier(), new FakeAutostartManager(), TestTimings.Fast);

        var health2 = new FakeHealthChecker { AlreadyRunningResult = false, WaitOutcomeResult = HealthWaitOutcome.Healthy };
        var gate2 = new FakeSingleInstanceGate { AcquireResult = false };
        var process2 = new FakeProcessManager();
        var app2 = new LauncherApp(dir.Paths, health2, process2, new FakeBrowserLauncher(), gate2, new FakeLauncherLogger(), new FakeFatalErrorPresenter(), new FakeUpdateApplier(), new FakeAutostartManager(), TestTimings.Fast);

        var code1 = await app1.RunAsync(Args(LauncherMode.Autostart));
        var code2 = await app2.RunAsync(Args(LauncherMode.Autostart));

        Assert.Equal(ExitCodes.Ok, code1);
        Assert.Equal(ExitCodes.Ok, code2);
        Assert.Equal(1, process1.StartServerCallCount);
        Assert.Equal(0, process2.StartServerCallCount);
    }

    [Fact]
    public async Task SecondLaunch_FirstNeverSucceeds_ReturnsReadableErrorNotHang()
    {
        using var dir = new TempInstallDir();
        var (app, health, process, _, gate, _, errorPresenter, _, _) = CreateApp(dir.Paths);
        health.AlreadyRunningResult = false;
        gate.AcquireResult = false;
        health.WaitOutcomeResult = HealthWaitOutcome.TimedOutProcessAlive;

        var code = await app.RunAsync(Args(LauncherMode.Normal));

        Assert.Equal(ExitCodes.StartupFailed, code);
        Assert.Equal(0, process.StartServerCallCount);
        Assert.Equal(1, errorPresenter.ShowCallCount);
        Assert.NotNull(errorPresenter.LastMessage);
    }

    [Fact]
    public async Task StartupTimeout_ReturnsNonZero_LogsError_DoesNotRespawnOrKillAgain()
    {
        using var dir = new TempInstallDir();
        var (app, health, process, browser, gate, logger, errorPresenter, _, _) = CreateApp(dir.Paths);
        health.AlreadyRunningResult = false;
        health.RespondOnceResult = false;
        health.WaitOutcomeResult = HealthWaitOutcome.TimedOutProcessAlive;
        gate.AcquireResult = true;
        process.SpawnResultToReturn = SpawnResult.Ok(999);
        process.ProcessAliveResult = true;

        var code = await app.RunAsync(Args(LauncherMode.Normal));

        Assert.Equal(ExitCodes.StartupFailed, code);
        Assert.Equal(1, process.StartServerCallCount);
        Assert.Equal(1, process.StopOwnedProcessesCallCount); // tylko przed spawnem, nie po timeoucie
        Assert.Equal(0, browser.OpenCallCount);
        Assert.Equal(1, errorPresenter.ShowCallCount);
        Assert.True(logger.HasEntryAt(LogLevel.Error));
    }

    [Fact]
    public async Task StopMode_AlwaysReturnsZero_RegardlessOfStopResult()
    {
        using var dir = new TempInstallDir();
        var (app, _, process, _, _, _, _, _, _) = CreateApp(dir.Paths);
        process.StopResultToReturn = new[] { 111, 222 };

        var code = await app.RunAsync(Args(LauncherMode.Stop));

        Assert.Equal(ExitCodes.Ok, code);
        Assert.Equal(1, process.StopOwnedProcessesCallCount);
        Assert.Equal(dir.Paths.NodeExePath, process.LastExpectedNodeExeFullPath);
    }

    [Fact]
    public async Task StopMode_AlsoClosesResidentTrayIcon_RealBugCaughtOnCI()
    {
        // Audyt v1.1.6: zlapane realnie na CI (test instalatora, tryb
        // /SCYZORYKUPDATE) - --stop zatrzymywal TYLKO node.exe, nigdy rezydentnej
        // ikony w zasobniku. Instalator probujacy nadpisac zablokowany
        // (wciaz-otwarty przez rezydentny proces) Scyzoryk.exe dostawal
        // Abort-Retry-Ignore i konczyl sie kodem 5. --stop jest kanonicznym
        // "wygaś Scyzoryka calkowicie", wiec musi zamykac OBA procesy.
        using var dir = new TempInstallDir();
        var (app, _, process, _, _, _, _, _, _) = CreateApp(dir.Paths);

        var code = await app.RunAsync(Args(LauncherMode.Stop));

        Assert.Equal(ExitCodes.Ok, code);
        Assert.Equal(1, process.StopResidentTrayProcessesCallCount);
        Assert.Equal(dir.Paths.ScyzorykExePath, process.LastExpectedScyzorykExeFullPath);
    }

    [Fact]
    public async Task RegisterAutostartMode_CallsAutostartManagerWithLauncherExePath_AlwaysReturnsZero()
    {
        using var dir = new TempInstallDir();
        var (app, _, _, _, _, logger, _, _, autostartManager) = CreateApp(dir.Paths);

        var code = await app.RunAsync(Args(LauncherMode.RegisterAutostart));

        Assert.Equal(ExitCodes.Ok, code);
        Assert.Equal(1, autostartManager.RegisterCallCount);
        Assert.Equal(0, autostartManager.UnregisterCallCount);
        Assert.Equal(Path.Combine(dir.Paths.InstallDir, "Scyzoryk.exe"), autostartManager.LastExePath);
        Assert.True(logger.HasEntryAt(LogLevel.Info));
    }

    [Fact]
    public async Task RegisterAutostartMode_FailureStillReturnsZero_ButLogsWarning()
    {
        using var dir = new TempInstallDir();
        var (app, _, _, _, _, logger, _, _, autostartManager) = CreateApp(dir.Paths);
        autostartManager.RegisterResultToReturn = AutostartResult.Failed("brak uprawnien do Harmonogramu Zadan");

        var code = await app.RunAsync(Args(LauncherMode.RegisterAutostart));

        Assert.Equal(ExitCodes.Ok, code);
        Assert.True(logger.HasEntryAt(LogLevel.Warning));
    }

    [Fact]
    public async Task UnregisterAutostartMode_CallsAutostartManager_AlwaysReturnsZero()
    {
        using var dir = new TempInstallDir();
        var (app, _, _, _, _, _, _, _, autostartManager) = CreateApp(dir.Paths);

        var code = await app.RunAsync(Args(LauncherMode.UnregisterAutostart));

        Assert.Equal(ExitCodes.Ok, code);
        Assert.Equal(1, autostartManager.UnregisterCallCount);
        Assert.Equal(0, autostartManager.RegisterCallCount);
    }

    [Fact]
    public async Task HealthMode_Responding_ReturnsZero_NeverSpawnsNeverOpensBrowser()
    {
        using var dir = new TempInstallDir();
        var (app, health, process, browser, _, _, _, _, _) = CreateApp(dir.Paths);
        health.RespondOnceResult = true;

        var code = await app.RunAsync(Args(LauncherMode.Health));

        Assert.Equal(ExitCodes.Ok, code);
        Assert.Equal(0, process.StartServerCallCount);
        Assert.Equal(0, browser.OpenCallCount);
        Assert.Equal(1, health.IsRespondingOnceCallCount);
        Assert.Equal(0, health.ProbeAlreadyRunningCallCount);
    }

    [Fact]
    public async Task HealthMode_NotResponding_ReturnsNonZero_NeverSpawnsNeverOpensBrowser()
    {
        using var dir = new TempInstallDir();
        var (app, _, process, browser, _, _, _, _, _) = CreateApp(dir.Paths);

        var code = await app.RunAsync(Args(LauncherMode.Health));

        Assert.Equal(ExitCodes.HealthNotResponding, code);
        Assert.Equal(0, process.StartServerCallCount);
        Assert.Equal(0, browser.OpenCallCount);
    }

    [Fact]
    public async Task UnrecognizedArgument_NoSideEffects_ReturnsNonZero()
    {
        using var dir = new TempInstallDir();
        var (app, health, process, browser, gate, logger, errorPresenter, _, _) = CreateApp(dir.Paths);
        var parsed = ArgsParser.Parse(new[] { "--not-a-real-flag" });
        Assert.Equal(LauncherMode.Unknown, parsed.Mode);

        var code = await app.RunAsync(parsed);

        Assert.Equal(ExitCodes.UnknownArgument, code);
        Assert.Equal(0, health.ProbeAlreadyRunningCallCount);
        Assert.Equal(0, process.StartServerCallCount);
        Assert.Equal(0, browser.OpenCallCount);
        Assert.Equal(0, gate.TryAcquireCallCount);
        Assert.Equal(0, errorPresenter.ShowCallCount);
        Assert.True(logger.HasEntryAt(LogLevel.Error));
    }

    [Fact]
    public async Task ApplyUpdateMode_DelegatesToUpdateApplier_AlwaysReturnsZero_EvenOnFailure()
    {
        using var dir = new TempInstallDir();
        var (app, _, _, _, _, _, _, updateApplier, _) = CreateApp(dir.Paths);
        updateApplier.ExitCodeToReturn = 1; // instalator "nieudany" - i tak Ok na poziomie launchera

        var code = await app.RunAsync(new ParsedArgs(LauncherMode.ApplyUpdate, "C:\\fake\\Setup-1.2.3.exe", "1.2.3"));

        Assert.Equal(ExitCodes.Ok, code);
        Assert.Equal(1, updateApplier.ApplyCallCount);
        Assert.Equal("C:\\fake\\Setup-1.2.3.exe", updateApplier.LastInstallerPath);
        Assert.Equal("1.2.3", updateApplier.LastExpectedVersion);
    }

    [Fact]
    public async Task ApplyUpdateMode_UpdateApplierThrows_StillReturnsZero_NeverPropagates()
    {
        using var dir = new TempInstallDir();
        var (app, _, _, _, _, logger, _, updateApplier, _) = CreateApp(dir.Paths);
        updateApplier.ExceptionToThrow = new InvalidOperationException("boom");

        var code = await app.RunAsync(new ParsedArgs(LauncherMode.ApplyUpdate, "C:\\fake\\Setup-1.2.3.exe", "1.2.3"));

        Assert.Equal(ExitCodes.Ok, code);
        Assert.True(logger.HasEntryAt(LogLevel.Error));
    }

    // =====================================================================
    // Cold-start apply (ApplyPendingUpdateIfAnyAsync, wolane na poczatku
    // RunEnsureAndReportAsync - patrz plan "Aktualizacja przy zimnym starcie").
    // SCYZORYK_UPDATE_ROOT jest tu zawsze izolowane do swiezego tymczasowego
    // katalogu (ten sam wzorzec co InstallPathsTests/UpdateApplierTests) -
    // testy NIGDY nie moga dotykac prawdziwego %LOCALAPPDATA%\ScyzorykProjektowy\Updates
    // uzytkownika uruchamiajacego testy. Parallelizacja jest wylaczona dla calego
    // zestawu testow (AssemblyInfo.cs), wiec mutowanie zmiennej srodowiskowej
    // procesu jest tu bezpieczne.
    // =====================================================================

    private static string ScopedUpdateRoot()
    {
        var updateRoot = Path.Combine(Path.GetTempPath(), "scyzoryk-pending-update-tests-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(updateRoot);
        return updateRoot;
    }

    private static void WritePendingUpdateMarker(string updateRoot, PendingUpdate pending)
    {
        var json = System.Text.Json.JsonSerializer.Serialize(pending);
        File.WriteAllText(Path.Combine(updateRoot, "pending-update.json"), json);
    }

    private static string ComputeSha256Hex(string filePath)
        => Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(File.ReadAllBytes(filePath)));

    [Fact]
    public async Task ApplyPendingUpdate_NoMarker_NeverCallsStartDetached_NormalStartupProceeds()
    {
        var previousUpdateRoot = Environment.GetEnvironmentVariable("SCYZORYK_UPDATE_ROOT");
        var updateRoot = ScopedUpdateRoot();
        Environment.SetEnvironmentVariable("SCYZORYK_UPDATE_ROOT", updateRoot);
        try
        {
            using var dir = new TempInstallDir();
            var (app, health, process, browser, gate, _, _, _, _) = CreateApp(dir.Paths);
            health.AlreadyRunningResult = true;

            var code = await app.RunAsync(Args(LauncherMode.Normal));

            Assert.Equal(ExitCodes.Ok, code);
            Assert.Equal(0, process.StartDetachedCallCount);
            Assert.Equal(1, health.ProbeAlreadyRunningCallCount); // normalny start dalej sie wykonal
        }
        finally
        {
            Environment.SetEnvironmentVariable("SCYZORYK_UPDATE_ROOT", previousUpdateRoot);
            try { Directory.Delete(updateRoot, recursive: true); } catch { }
        }
    }

    // Audyt na zywo (2026-08-18, real installer): pierwsza wersja tej metody
    // uzywala RunAndWaitAsync (czekala na zakonczenie --apply-update w TYM SAMYM
    // procesie) - realny test z prawdziwym instalatorem pokazal, ze wywolujacy
    // proces caly czas trzymal otwarty wlasny installDir\Scyzoryk.exe, przez co
    // instalator konsekwentnie padal kodem 5 ("plik w uzyciu"). Poprawka: metoda
    // TYLKO odpala (StartDetached, bez czekania) i wywolujacy MUSI natychmiast
    // zakonczyc dzialanie - stad ten test sprawdza NIE TYLKO poprawne argumenty
    // odpalenia, ale TAKZE ze RunEnsureAndReportAsync przerywa sie od razu i
    // NIGDY nie probuje probowac zdrowia serwera ani otwierac przegladarki.
    [Fact]
    public async Task ApplyPendingUpdate_ValidMarker_StartsDetachedWithApplyUpdateArgs_ThenExitsImmediately()
    {
        var previousUpdateRoot = Environment.GetEnvironmentVariable("SCYZORYK_UPDATE_ROOT");
        var updateRoot = ScopedUpdateRoot();
        Environment.SetEnvironmentVariable("SCYZORYK_UPDATE_ROOT", updateRoot);
        try
        {
            var installerPath = Path.Combine(updateRoot, "ScyzorykProjektowy-Setup-1.2.3.exe");
            File.WriteAllText(installerPath, "# fake installer bytes");
            var launcherExePath = Path.Combine(updateRoot, "Scyzoryk.exe");
            File.WriteAllText(launcherExePath, "# fake launcher copy");
            var pending = new PendingUpdate(launcherExePath, installerPath, ComputeSha256Hex(installerPath), "1.2.3", @"C:\fake-install-dir");
            WritePendingUpdateMarker(updateRoot, pending);

            using var dir = new TempInstallDir();
            var (app, health, process, browser, gate, _, _, _, _) = CreateApp(dir.Paths);
            health.AlreadyRunningResult = true;

            var code = await app.RunAsync(Args(LauncherMode.Normal));

            Assert.Equal(ExitCodes.Ok, code);
            Assert.Equal(1, process.StartDetachedCallCount);
            Assert.Equal(launcherExePath, process.LastStartDetachedExePath);
            Assert.NotNull(process.LastStartDetachedArgs);
            Assert.Equal(new[] { "--apply-update", installerPath, "1.2.3", @"C:\fake-install-dir" }, process.LastStartDetachedArgs);
            Assert.False(File.Exists(Path.Combine(updateRoot, "pending-update.json")));
            // Wywolujacy proces MUSI zakonczyc sie natychmiast po odpaleniu - zero
            // prob sprawdzenia zdrowia serwera, zero otwarcia przegladarki, zero
            // prob przejecia muteksu startu.
            Assert.Equal(0, health.ProbeAlreadyRunningCallCount);
            Assert.Equal(0, browser.OpenCallCount);
            Assert.Equal(0, gate.TryAcquireCallCount);
        }
        finally
        {
            Environment.SetEnvironmentVariable("SCYZORYK_UPDATE_ROOT", previousUpdateRoot);
            try { Directory.Delete(updateRoot, recursive: true); } catch { }
        }
    }

    [Fact]
    public async Task ApplyPendingUpdate_Sha256Mismatch_SkipsApply_DeletesMarker_NormalStartupProceeds()
    {
        var previousUpdateRoot = Environment.GetEnvironmentVariable("SCYZORYK_UPDATE_ROOT");
        var updateRoot = ScopedUpdateRoot();
        Environment.SetEnvironmentVariable("SCYZORYK_UPDATE_ROOT", updateRoot);
        try
        {
            var installerPath = Path.Combine(updateRoot, "ScyzorykProjektowy-Setup-1.2.3.exe");
            File.WriteAllText(installerPath, "# fake installer bytes, zmienione po zapisaniu znacznika");
            var launcherExePath = Path.Combine(updateRoot, "Scyzoryk.exe");
            File.WriteAllText(launcherExePath, "# fake launcher copy");
            var pending = new PendingUpdate(launcherExePath, installerPath, new string('a', 64), "1.2.3", @"C:\fake-install-dir");
            WritePendingUpdateMarker(updateRoot, pending);

            using var dir = new TempInstallDir();
            var (app, health, process, _, _, logger, _, _, _) = CreateApp(dir.Paths);
            health.AlreadyRunningResult = true;

            var code = await app.RunAsync(Args(LauncherMode.Normal));

            Assert.Equal(ExitCodes.Ok, code);
            Assert.Equal(0, process.StartDetachedCallCount);
            Assert.False(File.Exists(Path.Combine(updateRoot, "pending-update.json")));
            Assert.True(logger.HasEntryAt(LogLevel.Warning));
            Assert.Equal(1, health.ProbeAlreadyRunningCallCount); // niewazny znacznik nie blokuje normalnego startu
        }
        finally
        {
            Environment.SetEnvironmentVariable("SCYZORYK_UPDATE_ROOT", previousUpdateRoot);
            try { Directory.Delete(updateRoot, recursive: true); } catch { }
        }
    }

    [Fact]
    public async Task ApplyPendingUpdate_MissingInstallerFile_SkipsApply_DeletesMarker_NormalStartupProceeds()
    {
        var previousUpdateRoot = Environment.GetEnvironmentVariable("SCYZORYK_UPDATE_ROOT");
        var updateRoot = ScopedUpdateRoot();
        Environment.SetEnvironmentVariable("SCYZORYK_UPDATE_ROOT", updateRoot);
        try
        {
            var installerPath = Path.Combine(updateRoot, "does-not-exist.exe"); // nigdy nie zapisany na dysk
            var launcherExePath = Path.Combine(updateRoot, "Scyzoryk.exe");
            File.WriteAllText(launcherExePath, "# fake launcher copy");
            var pending = new PendingUpdate(launcherExePath, installerPath, new string('a', 64), "1.2.3", @"C:\fake-install-dir");
            WritePendingUpdateMarker(updateRoot, pending);

            using var dir = new TempInstallDir();
            var (app, health, process, _, _, _, _, _, _) = CreateApp(dir.Paths);
            health.AlreadyRunningResult = true;

            var code = await app.RunAsync(Args(LauncherMode.Normal));

            Assert.Equal(ExitCodes.Ok, code);
            Assert.Equal(0, process.StartDetachedCallCount);
            Assert.False(File.Exists(Path.Combine(updateRoot, "pending-update.json")));
            Assert.Equal(1, health.ProbeAlreadyRunningCallCount);
        }
        finally
        {
            Environment.SetEnvironmentVariable("SCYZORYK_UPDATE_ROOT", previousUpdateRoot);
            try { Directory.Delete(updateRoot, recursive: true); } catch { }
        }
    }

    [Fact]
    public async Task ApplyPendingUpdate_StartDetachedFails_DeletesMarker_NormalStartupProceeds()
    {
        var previousUpdateRoot = Environment.GetEnvironmentVariable("SCYZORYK_UPDATE_ROOT");
        var updateRoot = ScopedUpdateRoot();
        Environment.SetEnvironmentVariable("SCYZORYK_UPDATE_ROOT", updateRoot);
        try
        {
            var installerPath = Path.Combine(updateRoot, "ScyzorykProjektowy-Setup-1.2.3.exe");
            File.WriteAllText(installerPath, "# fake installer bytes");
            var launcherExePath = Path.Combine(updateRoot, "Scyzoryk.exe");
            File.WriteAllText(launcherExePath, "# fake launcher copy");
            var pending = new PendingUpdate(launcherExePath, installerPath, ComputeSha256Hex(installerPath), "1.2.3", @"C:\fake-install-dir");
            WritePendingUpdateMarker(updateRoot, pending);

            using var dir = new TempInstallDir();
            var (app, health, process, _, _, logger, _, _, _) = CreateApp(dir.Paths);
            health.AlreadyRunningResult = true;
            process.StartDetachedResultToReturn = SpawnResult.Failed("ENOENT (symulacja)");

            var code = await app.RunAsync(Args(LauncherMode.Normal));

            Assert.Equal(ExitCodes.Ok, code);
            Assert.Equal(1, process.StartDetachedCallCount);
            Assert.False(File.Exists(Path.Combine(updateRoot, "pending-update.json")));
            Assert.True(logger.HasEntryAt(LogLevel.Error));
            Assert.Equal(1, health.ProbeAlreadyRunningCallCount); // odpalenie sie nie udalo - normalny start i tak proboje
        }
        finally
        {
            Environment.SetEnvironmentVariable("SCYZORYK_UPDATE_ROOT", previousUpdateRoot);
            try { Directory.Delete(updateRoot, recursive: true); } catch { }
        }
    }
}
