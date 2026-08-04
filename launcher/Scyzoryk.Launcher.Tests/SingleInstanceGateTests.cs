using Xunit;

namespace Scyzoryk.Launcher.Tests;

public sealed class SingleInstanceGateTests
{
    private static string UniqueMutexName() => "Local\\ScyzorykLauncherTest_" + Guid.NewGuid().ToString("N");

    [Fact]
    public void TryAcquire_WhenFree_Succeeds_ThenReleaseAllowsReacquire()
    {
        var mutexName = UniqueMutexName();
        using var gate = new SingleInstanceGate(mutexName);

        Assert.True(gate.TryAcquire(TimeSpan.FromSeconds(1)));
        gate.Release();

        Assert.True(gate.TryAcquire(TimeSpan.FromSeconds(1)));
        gate.Release();
    }

    [Fact]
    public void TryAcquire_WhenHeldByAnotherHandle_ReturnsFalseWithinTimeout()
    {
        var mutexName = UniqueMutexName();
        using var owner = new SingleInstanceGate(mutexName);
        using var contender = new SingleInstanceGate(mutexName);

        Assert.True(owner.TryAcquire(TimeSpan.FromSeconds(1)));

        var sw = System.Diagnostics.Stopwatch.StartNew();
        var acquired = contender.TryAcquire(TimeSpan.FromMilliseconds(200));
        sw.Stop();

        Assert.False(acquired);
        Assert.True(sw.Elapsed < TimeSpan.FromSeconds(2));

        owner.Release();
    }

    [Fact]
    public void TryAcquire_AfterOwnerReleases_ContenderCanAcquire()
    {
        var mutexName = UniqueMutexName();
        using var owner = new SingleInstanceGate(mutexName);
        using var contender = new SingleInstanceGate(mutexName);

        Assert.True(owner.TryAcquire(TimeSpan.FromSeconds(1)));
        owner.Release();

        Assert.True(contender.TryAcquire(TimeSpan.FromSeconds(1)));
        contender.Release();
    }
}
