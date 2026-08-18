namespace Scyzoryk.Launcher.Tests.Fakes;

public sealed class FakeProcessManager : IProcessManager
{
    public SpawnResult SpawnResultToReturn { get; set; } = SpawnResult.Ok(1234);
    public IReadOnlyList<int> StopResultToReturn { get; set; } = Array.Empty<int>();
    public bool ProcessAliveResult { get; set; } = true;
    public bool KillProcessByIdResult { get; set; } = true;
    public int KillProcessByIdCallCount { get; private set; }
    public List<int> KilledPids { get; } = new();
    public bool KillProcessByIdIfPathMatchesResult { get; set; } = true;
    public int KillProcessByIdIfPathMatchesCallCount { get; private set; }
    public List<(int Pid, string ExpectedFullPath)> KillIfPathMatchesCalls { get; } = new();

    public int StartServerCallCount { get; private set; }
    public string? LastInstallDir { get; private set; }
    public string? LastNodeExePath { get; private set; }
    public int RunAndWaitCallCount { get; private set; }
    public string? LastRunAndWaitExePath { get; private set; }
    public IReadOnlyList<string>? LastRunAndWaitArgs { get; private set; }
    public int RunAndWaitExitCodeToReturn { get; set; } = 0;
    public int StopOwnedProcessesCallCount { get; private set; }
    public string? LastExpectedNodeExeFullPath { get; private set; }
    public int StopResidentTrayProcessesCallCount { get; private set; }
    public string? LastExpectedScyzorykExeFullPath { get; private set; }
    public IReadOnlyList<int> StopResidentTrayResultToReturn { get; set; } = Array.Empty<int>();

    // Audyt v1.1.7: sekwencje wynikow dla kolejnych wywolan, zeby dalo sie
    // przetestowac "proces przetrwal pierwsza probe, zniknal przy drugiej" -
    // patrz StopAllOwnedProcessesUntilConfirmedAsync. Jesli puste, kazde
    // wywolanie zwraca po prostu *ResultToReturn jak dotychczas.
    public Queue<IReadOnlyList<int>>? StopResultSequence { get; set; }
    public Queue<IReadOnlyList<int>>? StopResidentTraySequence { get; set; }

    public SpawnResult StartServer(string installDir, string nodeExePath)
    {
        StartServerCallCount++;
        LastInstallDir = installDir;
        LastNodeExePath = nodeExePath;
        return SpawnResultToReturn;
    }

    public Task<int> RunAndWaitAsync(string exePath, IReadOnlyList<string> args)
    {
        RunAndWaitCallCount++;
        LastRunAndWaitExePath = exePath;
        LastRunAndWaitArgs = args;
        return Task.FromResult(RunAndWaitExitCodeToReturn);
    }

    public IReadOnlyList<int> StopOwnedProcesses(string expectedNodeExeFullPath)
    {
        StopOwnedProcessesCallCount++;
        LastExpectedNodeExeFullPath = expectedNodeExeFullPath;
        if (StopResultSequence is { Count: > 0 }) return StopResultSequence.Dequeue();
        return StopResultToReturn;
    }

    public IReadOnlyList<int> StopResidentTrayProcesses(string expectedScyzorykExeFullPath)
    {
        StopResidentTrayProcessesCallCount++;
        LastExpectedScyzorykExeFullPath = expectedScyzorykExeFullPath;
        if (StopResidentTraySequence is { Count: > 0 }) return StopResidentTraySequence.Dequeue();
        return StopResidentTrayResultToReturn;
    }

    public bool IsProcessStillAlive(int pid) => ProcessAliveResult;

    public bool KillProcessById(int pid)
    {
        KillProcessByIdCallCount++;
        KilledPids.Add(pid);
        return KillProcessByIdResult;
    }

    public bool KillProcessByIdIfPathMatches(int pid, string expectedFullPath)
    {
        KillProcessByIdIfPathMatchesCallCount++;
        KillIfPathMatchesCalls.Add((pid, expectedFullPath));
        return KillProcessByIdIfPathMatchesResult;
    }
}
