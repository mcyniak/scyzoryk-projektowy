using Scyzoryk.Launcher.Tests.Fakes;
using Xunit;

namespace Scyzoryk.Launcher.Tests;

public sealed class LauncherAppTests
{
    private static (LauncherApp App, FakeHealthChecker Health, FakeProcessManager Process, FakeBrowserLauncher Browser, FakeSingleInstanceGate Gate, FakeLauncherLogger Logger, FakeFatalErrorPresenter ErrorPresenter)
        CreateApp(InstallPaths paths)
    {
        var health = new FakeHealthChecker();
        var process = new FakeProcessManager();
        var browser = new FakeBrowserLauncher();
        var gate = new FakeSingleInstanceGate();
        var logger = new FakeLauncherLogger();
        var errorPresenter = new FakeFatalErrorPresenter();
        var app = new LauncherApp(paths, health, process, browser, gate, logger, errorPresenter, TestTimings.Fast);
        return (app, health, process, browser, gate, logger, errorPresenter);
    }

    [Fact]
    public async Task AlreadyRunning_NormalMode_OpensBrowserOnce_NoSpawn()
    {
        using var dir = new TempInstallDir();
        var (app, health, process, browser, gate, _, _) = CreateApp(dir.Paths);
        health.AlreadyRunningResult = true;

        var code = await app.RunAsync(LauncherMode.Normal);

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
        var (app, health, process, browser, gate, _, _) = CreateApp(dir.Paths);
        health.AlreadyRunningResult = true;

        var code = await app.RunAsync(LauncherMode.Autostart);

        Assert.Equal(ExitCodes.Ok, code);
        Assert.Equal(0, browser.OpenCallCount);
        Assert.Equal(0, process.StartServerCallCount);
        Assert.Equal(0, gate.TryAcquireCallCount);
    }

    [Fact]
    public async Task NotRunning_NormalMode_SpawnsThenOpensBrowserOnce()
    {
        using var dir = new TempInstallDir();
        var (app, health, process, browser, gate, _, _) = CreateApp(dir.Paths);
        health.AlreadyRunningResult = false;
        health.RespondOnceResult = false;
        health.WaitOutcomeResult = HealthWaitOutcome.Healthy;
        gate.AcquireResult = true;
        process.SpawnResultToReturn = SpawnResult.Ok(4321);

        var code = await app.RunAsync(LauncherMode.Normal);

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
        var (app, health, process, browser, gate, _, _) = CreateApp(dir.Paths);
        health.AlreadyRunningResult = false;
        health.RespondOnceResult = false;
        health.WaitOutcomeResult = HealthWaitOutcome.Healthy;
        gate.AcquireResult = true;
        process.SpawnResultToReturn = SpawnResult.Ok(4321);

        var code = await app.RunAsync(LauncherMode.Autostart);

        Assert.Equal(ExitCodes.Ok, code);
        Assert.Equal(1, process.StartServerCallCount);
        Assert.Equal(0, browser.OpenCallCount);
        Assert.Equal(1, gate.ReleaseCallCount);
    }

    [Fact]
    public async Task MissingNodeExe_NormalMode_NoSpawnAttempted_ReturnsNonZero_LogsReadableError()
    {
        using var dir = new TempInstallDir(includeNodeExe: false);
        var (app, health, process, browser, gate, logger, errorPresenter) = CreateApp(dir.Paths);

        var code = await app.RunAsync(LauncherMode.Normal);

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
        var (app, health, process, _, _, _, errorPresenter) = CreateApp(dir.Paths);

        var code = await app.RunAsync(LauncherMode.Normal);

        Assert.Equal(ExitCodes.MissingFile, code);
        Assert.Equal(0, process.StartServerCallCount);
        Assert.Equal(0, health.ProbeAlreadyRunningCallCount);
        Assert.Contains("server.js", errorPresenter.LastMessage);
    }

    [Fact]
    public async Task MissingNodeExe_StopMode_StillReturnsZero()
    {
        using var dir = new TempInstallDir(includeNodeExe: false);
        var (app, _, process, _, _, _, _) = CreateApp(dir.Paths);

        var code = await app.RunAsync(LauncherMode.Stop);

        Assert.Equal(ExitCodes.Ok, code);
        Assert.Equal(0, process.StopOwnedProcessesCallCount);
    }

    [Fact]
    public async Task TwoParallelLaunches_OnlyFirstSpawns_SecondWaitsOnHealthWithoutSpawning()
    {
        using var dir = new TempInstallDir();

        var health1 = new FakeHealthChecker { AlreadyRunningResult = false, RespondOnceResult = false, WaitOutcomeResult = HealthWaitOutcome.Healthy };
        var gate1 = new FakeSingleInstanceGate { AcquireResult = true };
        var process1 = new FakeProcessManager { SpawnResultToReturn = SpawnResult.Ok(111) };
        var app1 = new LauncherApp(dir.Paths, health1, process1, new FakeBrowserLauncher(), gate1, new FakeLauncherLogger(), new FakeFatalErrorPresenter(), TestTimings.Fast);

        var health2 = new FakeHealthChecker { AlreadyRunningResult = false, WaitOutcomeResult = HealthWaitOutcome.Healthy };
        var gate2 = new FakeSingleInstanceGate { AcquireResult = false };
        var process2 = new FakeProcessManager();
        var app2 = new LauncherApp(dir.Paths, health2, process2, new FakeBrowserLauncher(), gate2, new FakeLauncherLogger(), new FakeFatalErrorPresenter(), TestTimings.Fast);

        var code1 = await app1.RunAsync(LauncherMode.Autostart);
        var code2 = await app2.RunAsync(LauncherMode.Autostart);

        Assert.Equal(ExitCodes.Ok, code1);
        Assert.Equal(ExitCodes.Ok, code2);
        Assert.Equal(1, process1.StartServerCallCount);
        Assert.Equal(0, process2.StartServerCallCount);
    }

    [Fact]
    public async Task SecondLaunch_FirstNeverSucceeds_ReturnsReadableErrorNotHang()
    {
        using var dir = new TempInstallDir();
        var (app, health, process, _, gate, _, errorPresenter) = CreateApp(dir.Paths);
        health.AlreadyRunningResult = false;
        gate.AcquireResult = false;
        health.WaitOutcomeResult = HealthWaitOutcome.TimedOutProcessAlive;

        var code = await app.RunAsync(LauncherMode.Normal);

        Assert.Equal(ExitCodes.StartupFailed, code);
        Assert.Equal(0, process.StartServerCallCount);
        Assert.Equal(1, errorPresenter.ShowCallCount);
        Assert.NotNull(errorPresenter.LastMessage);
    }

    [Fact]
    public async Task StartupTimeout_ReturnsNonZero_LogsError_DoesNotRespawnOrKillAgain()
    {
        using var dir = new TempInstallDir();
        var (app, health, process, browser, gate, logger, errorPresenter) = CreateApp(dir.Paths);
        health.AlreadyRunningResult = false;
        health.RespondOnceResult = false;
        health.WaitOutcomeResult = HealthWaitOutcome.TimedOutProcessAlive;
        gate.AcquireResult = true;
        process.SpawnResultToReturn = SpawnResult.Ok(999);
        process.ProcessAliveResult = true;

        var code = await app.RunAsync(LauncherMode.Normal);

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
        var (app, _, process, _, _, _, _) = CreateApp(dir.Paths);
        process.StopResultToReturn = new[] { 111, 222 };

        var code = await app.RunAsync(LauncherMode.Stop);

        Assert.Equal(ExitCodes.Ok, code);
        Assert.Equal(1, process.StopOwnedProcessesCallCount);
        Assert.Equal(dir.Paths.NodeExePath, process.LastExpectedNodeExeFullPath);
    }

    [Fact]
    public async Task HealthMode_Responding_ReturnsZero_NeverSpawnsNeverOpensBrowser()
    {
        using var dir = new TempInstallDir();
        var (app, health, process, browser, _, _, _) = CreateApp(dir.Paths);
        health.RespondOnceResult = true;

        var code = await app.RunAsync(LauncherMode.Health);

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
        var (app, _, process, browser, _, _, _) = CreateApp(dir.Paths);

        var code = await app.RunAsync(LauncherMode.Health);

        Assert.Equal(ExitCodes.HealthNotResponding, code);
        Assert.Equal(0, process.StartServerCallCount);
        Assert.Equal(0, browser.OpenCallCount);
    }

    [Fact]
    public async Task UnrecognizedArgument_NoSideEffects_ReturnsNonZero()
    {
        using var dir = new TempInstallDir();
        var (app, health, process, browser, gate, logger, errorPresenter) = CreateApp(dir.Paths);
        var mode = ArgsParser.Parse(new[] { "--not-a-real-flag" });
        Assert.Equal(LauncherMode.Unknown, mode);

        var code = await app.RunAsync(mode);

        Assert.Equal(ExitCodes.UnknownArgument, code);
        Assert.Equal(0, health.ProbeAlreadyRunningCallCount);
        Assert.Equal(0, process.StartServerCallCount);
        Assert.Equal(0, browser.OpenCallCount);
        Assert.Equal(0, gate.TryAcquireCallCount);
        Assert.Equal(0, errorPresenter.ShowCallCount);
        Assert.True(logger.HasEntryAt(LogLevel.Error));
    }
}
