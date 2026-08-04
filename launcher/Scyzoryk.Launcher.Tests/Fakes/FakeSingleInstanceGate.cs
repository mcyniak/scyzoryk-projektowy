namespace Scyzoryk.Launcher.Tests.Fakes;

public sealed class FakeSingleInstanceGate : ISingleInstanceGate
{
    public bool AcquireResult { get; set; } = true;
    public int TryAcquireCallCount { get; private set; }
    public int ReleaseCallCount { get; private set; }

    public bool TryAcquire(TimeSpan timeout)
    {
        TryAcquireCallCount++;
        return AcquireResult;
    }

    public void Release()
    {
        ReleaseCallCount++;
    }

    public void Dispose()
    {
    }
}
