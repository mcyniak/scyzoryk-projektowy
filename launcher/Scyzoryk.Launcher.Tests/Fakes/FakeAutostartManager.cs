namespace Scyzoryk.Launcher.Tests.Fakes;

public sealed class FakeAutostartManager : IAutostartManager
{
    public AutostartResult RegisterResultToReturn { get; set; } = AutostartResult.Ok();
    public AutostartResult UnregisterResultToReturn { get; set; } = AutostartResult.Ok();

    public int RegisterCallCount { get; private set; }
    public int UnregisterCallCount { get; private set; }
    public string? LastExePath { get; private set; }

    public AutostartResult Register(string exePath)
    {
        RegisterCallCount++;
        LastExePath = exePath;
        return RegisterResultToReturn;
    }

    public AutostartResult Unregister()
    {
        UnregisterCallCount++;
        return UnregisterResultToReturn;
    }
}
