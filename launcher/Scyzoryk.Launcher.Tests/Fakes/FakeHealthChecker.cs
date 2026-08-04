using System.Threading;

namespace Scyzoryk.Launcher.Tests.Fakes;

public sealed class FakeHealthChecker : IHealthChecker
{
    public bool RespondOnceResult { get; set; }
    public bool AlreadyRunningResult { get; set; }
    public HealthWaitOutcome WaitOutcomeResult { get; set; } = HealthWaitOutcome.Healthy;

    public int IsRespondingOnceCallCount { get; private set; }
    public int ProbeAlreadyRunningCallCount { get; private set; }
    public int WaitForHealthyCallCount { get; private set; }
    public List<bool> ObservedIsSpawnedProcessAlive { get; } = new();

    public Task<bool> IsRespondingOnceAsync(string healthUrl, TimeSpan timeout, CancellationToken ct = default)
    {
        IsRespondingOnceCallCount++;
        return Task.FromResult(RespondOnceResult);
    }

    public Task<bool> ProbeAlreadyRunningAsync(string healthUrl, int attempts, TimeSpan attemptTimeout, TimeSpan delayBetween, CancellationToken ct = default)
    {
        ProbeAlreadyRunningCallCount++;
        return Task.FromResult(AlreadyRunningResult);
    }

    public Task<HealthWaitOutcome> WaitForHealthyAsync(string healthUrl, TimeSpan baseTimeout, TimeSpan extendedTimeout, Func<bool> isSpawnedProcessAlive, CancellationToken ct = default)
    {
        WaitForHealthyCallCount++;
        ObservedIsSpawnedProcessAlive.Add(isSpawnedProcessAlive());
        return Task.FromResult(WaitOutcomeResult);
    }
}
