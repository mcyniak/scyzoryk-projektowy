namespace Scyzoryk.Launcher.Tests.Fakes;

public sealed class FakeUpdateApplier : IUpdateApplier
{
    public int ExitCodeToReturn { get; set; }
    public Exception? ExceptionToThrow { get; set; }

    public int ApplyCallCount { get; private set; }
    public string? LastInstallerPath { get; private set; }
    public string? LastExpectedVersion { get; private set; }

    public Task<int> ApplyAsync(string installerPath, string expectedVersion)
    {
        ApplyCallCount++;
        LastInstallerPath = installerPath;
        LastExpectedVersion = expectedVersion;
        if (ExceptionToThrow is not null) throw ExceptionToThrow;
        return Task.FromResult(ExitCodeToReturn);
    }
}
