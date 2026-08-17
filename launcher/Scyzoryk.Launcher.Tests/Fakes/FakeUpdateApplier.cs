namespace Scyzoryk.Launcher.Tests.Fakes;

public sealed class FakeUpdateApplier : IUpdateApplier
{
    public int ExitCodeToReturn { get; set; }
    public Exception? ExceptionToThrow { get; set; }

    public int ApplyCallCount { get; private set; }
    public string? LastInstallerPath { get; private set; }
    public string? LastExpectedVersion { get; private set; }
    public string? LastParentPid { get; private set; }
    public string? LastResidentTrayPid { get; private set; }

    public Task<int> ApplyAsync(string installerPath, string expectedVersion, string? parentPid = null, string? residentTrayPid = null)
    {
        ApplyCallCount++;
        LastInstallerPath = installerPath;
        LastExpectedVersion = expectedVersion;
        LastParentPid = parentPid;
        LastResidentTrayPid = residentTrayPid;
        if (ExceptionToThrow is not null) throw ExceptionToThrow;
        return Task.FromResult(ExitCodeToReturn);
    }
}
