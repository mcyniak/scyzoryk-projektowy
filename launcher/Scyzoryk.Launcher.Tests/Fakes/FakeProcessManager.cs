namespace Scyzoryk.Launcher.Tests.Fakes;

public sealed class FakeProcessManager : IProcessManager
{
    public SpawnResult SpawnResultToReturn { get; set; } = SpawnResult.Ok(1234);
    public IReadOnlyList<int> StopResultToReturn { get; set; } = Array.Empty<int>();
    public bool ProcessAliveResult { get; set; } = true;

    public int StartServerCallCount { get; private set; }
    public string? LastInstallDir { get; private set; }
    public string? LastNodeExePath { get; private set; }
    public int StopOwnedProcessesCallCount { get; private set; }
    public string? LastExpectedNodeExeFullPath { get; private set; }

    public SpawnResult StartServer(string installDir, string nodeExePath)
    {
        StartServerCallCount++;
        LastInstallDir = installDir;
        LastNodeExePath = nodeExePath;
        return SpawnResultToReturn;
    }

    public IReadOnlyList<int> StopOwnedProcesses(string expectedNodeExeFullPath)
    {
        StopOwnedProcessesCallCount++;
        LastExpectedNodeExeFullPath = expectedNodeExeFullPath;
        return StopResultToReturn;
    }

    public bool IsProcessStillAlive(int pid) => ProcessAliveResult;
}
