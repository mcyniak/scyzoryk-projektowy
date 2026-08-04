using Scyzoryk.Launcher.Tests.Fakes;
using Xunit;

namespace Scyzoryk.Launcher.Tests;

public sealed class HealthCheckerTests
{
    [Fact]
    public async Task IsRespondingOnce_Returns200_True()
    {
        using var server = new FakeHealthServer { StatusCodeToReturn = 200 };
        var checker = new HealthChecker();

        var result = await checker.IsRespondingOnceAsync(server.HealthUrl, TimeSpan.FromSeconds(2));

        Assert.True(result);
    }

    [Fact]
    public async Task IsRespondingOnce_Returns500_False()
    {
        using var server = new FakeHealthServer { StatusCodeToReturn = 500 };
        var checker = new HealthChecker();

        var result = await checker.IsRespondingOnceAsync(server.HealthUrl, TimeSpan.FromSeconds(2));

        Assert.False(result);
    }

    [Fact]
    public async Task IsRespondingOnce_ConnectionRefused_False()
    {
        var port = FakeHealthServer.GetFreePort();
        var checker = new HealthChecker();

        // 127.0.0.1 literalnie (nie "localhost") - bez zadnego listenera odmowa
        // polaczenia na loopbacku jest natychmiastowa na poziomie jadra systemu;
        // nazwa "localhost" wymaga rozwiazania (IPv4/IPv6 dual-stack), co na
        // niektorych sandboxach CI bywa zauwazalnie wolniejsze (zlapane realnie).
        var result = await checker.IsRespondingOnceAsync($"http://127.0.0.1:{port}/api/health", TimeSpan.FromSeconds(1));

        Assert.False(result);
    }

    [Fact]
    public async Task ProbeAlreadyRunning_RespondsFirstAttempt_ReturnsTrueImmediately()
    {
        using var server = new FakeHealthServer { StatusCodeToReturn = 200 };
        var checker = new HealthChecker();
        var sw = System.Diagnostics.Stopwatch.StartNew();

        var result = await checker.ProbeAlreadyRunningAsync(server.HealthUrl, attempts: 3, attemptTimeout: TimeSpan.FromSeconds(1), delayBetween: TimeSpan.FromSeconds(5));

        sw.Stop();
        Assert.True(result);
        Assert.True(sw.Elapsed < TimeSpan.FromSeconds(5), "powinno wrocic natychmiast po 1. udanej probie, bez czekania na delayBetween");
    }

    [Fact]
    public async Task ProbeAlreadyRunning_NeverResponds_ReturnsFalseAfterConfiguredAttempts()
    {
        var port = FakeHealthServer.GetFreePort();
        var checker = new HealthChecker();

        var result = await checker.ProbeAlreadyRunningAsync($"http://127.0.0.1:{port}/api/health", attempts: 3, attemptTimeout: TimeSpan.FromMilliseconds(100), delayBetween: TimeSpan.FromMilliseconds(50));

        Assert.False(result);
    }

    [Fact]
    public async Task WaitForHealthy_BecomesHealthyInBaseWindow()
    {
        using var server = new FakeHealthServer { StatusCodeToReturn = 500 };
        var checker = new HealthChecker();

        var waitTask = checker.WaitForHealthyAsync(server.HealthUrl, TimeSpan.FromSeconds(3), TimeSpan.FromSeconds(1), () => true);
        await Task.Delay(300);
        server.StatusCodeToReturn = 200;

        var outcome = await waitTask;

        Assert.Equal(HealthWaitOutcome.Healthy, outcome);
    }

    [Fact]
    public async Task WaitForHealthy_BecomesHealthyOnlyInExtendedWindow_WhenProcessAlive()
    {
        using var server = new FakeHealthServer { StatusCodeToReturn = 500 };
        var checker = new HealthChecker();

        var waitTask = checker.WaitForHealthyAsync(server.HealthUrl, TimeSpan.FromMilliseconds(300), TimeSpan.FromSeconds(2), () => true);
        await Task.Delay(600); // minela juz baza, jestesmy w rozszerzeniu
        server.StatusCodeToReturn = 200;

        var outcome = await waitTask;

        Assert.Equal(HealthWaitOutcome.Healthy, outcome);
    }

    [Fact]
    public async Task WaitForHealthy_NeverHealthy_ProcessDead_NoExtensionAttempted()
    {
        var port = FakeHealthServer.GetFreePort();
        var checker = new HealthChecker();
        var sw = System.Diagnostics.Stopwatch.StartNew();

        var outcome = await checker.WaitForHealthyAsync($"http://127.0.0.1:{port}/api/health", TimeSpan.FromMilliseconds(300), TimeSpan.FromSeconds(5), () => false);

        sw.Stop();
        Assert.Equal(HealthWaitOutcome.TimedOutProcessDead, outcome);
        Assert.True(sw.Elapsed < TimeSpan.FromSeconds(2), "proces martwy - NIE powinno czekac na cale rozszerzenie");
    }

    [Fact]
    public async Task WaitForHealthy_NeverHealthy_ProcessAlive_WaitsFullExtendedWindow()
    {
        var port = FakeHealthServer.GetFreePort();
        var checker = new HealthChecker();

        var outcome = await checker.WaitForHealthyAsync($"http://127.0.0.1:{port}/api/health", TimeSpan.FromMilliseconds(200), TimeSpan.FromMilliseconds(300), () => true);

        Assert.Equal(HealthWaitOutcome.TimedOutProcessAlive, outcome);
    }
}
