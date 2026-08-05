using System.Text.Json;
using Scyzoryk.Launcher.Tests.Fakes;
using Xunit;

namespace Scyzoryk.Launcher.Tests;

/// <summary>
/// UpdateApplier zastepuje dawny scripts\run-update.ps1 (patrz komentarz w
/// LauncherApp.RunApplyUpdateAsync dla pelnego uzasadnienia). Testy tutaj
/// pokrywaja wylacznie orkiestracje (kolejnosc krokow, kontrakt plikowy
/// last-result.json/update-*.log, ktory czyta lib/updateService.js) - nigdy
/// nie odpalaja prawdziwego instalatora. Zamiast tego uzywaja jako
/// "InstallerPath" malego, prawdziwego pliku wykonywalnego z ustalonym kodem
/// wyjscia (dotnet/cmd nie sa potrzebne - wystarczy dowolny .exe z PATH).
/// </summary>
public sealed class UpdateApplierTests
{
    // Uzywamy cmd.exe /c exit <kod> jako "instalatora" - jedyny w pelni
    // przenosny sposob na kontrolowany kod wyjscia bez budowania wlasnego
    // pomocniczego .exe. UpdateApplier i tak przekazuje dodatkowe /VERYSILENT
    // itd. argumenty, ktore cmd.exe po prostu ignoruje (cmd /c bierze TYLKO
    // pierwszy "argument" po /c jako komende, reszta to argumenty do niej -
    // zamiast tego uzywamy wrappera .cmd, ktory sam wywoluje "exit").
    private static string WriteFakeInstaller(string dir, int exitCode)
    {
        var path = Path.Combine(dir, "fake-installer.cmd");
        File.WriteAllText(path, $"@exit /b {exitCode}\r\n");
        return path;
    }

    private sealed class IsolatedRoots : IDisposable
    {
        public string UpdateRoot { get; }
        public string DataRoot { get; }
        private readonly string? _previousUpdateRoot;
        private readonly string? _previousDataRoot;

        public IsolatedRoots()
        {
            var baseDir = Path.Combine(Path.GetTempPath(), "scyzoryk-updateapplier-tests-" + Guid.NewGuid().ToString("N"));
            UpdateRoot = Path.Combine(baseDir, "Updates");
            DataRoot = Path.Combine(baseDir, "Data");
            Directory.CreateDirectory(UpdateRoot);
            Directory.CreateDirectory(DataRoot);

            _previousUpdateRoot = Environment.GetEnvironmentVariable("SCYZORYK_UPDATE_ROOT");
            _previousDataRoot = Environment.GetEnvironmentVariable("SCYZORYK_DATA_ROOT");
            Environment.SetEnvironmentVariable("SCYZORYK_UPDATE_ROOT", UpdateRoot);
            Environment.SetEnvironmentVariable("SCYZORYK_DATA_ROOT", DataRoot);
        }

        public void Dispose()
        {
            Environment.SetEnvironmentVariable("SCYZORYK_UPDATE_ROOT", _previousUpdateRoot);
            Environment.SetEnvironmentVariable("SCYZORYK_DATA_ROOT", _previousDataRoot);
            try { Directory.Delete(Path.GetDirectoryName(UpdateRoot)!, recursive: true); } catch { }
        }
    }

    private static JsonElement ReadLastResult(string updateRoot)
    {
        var json = File.ReadAllText(Path.Combine(updateRoot, "last-result.json"));
        return JsonDocument.Parse(json).RootElement.Clone();
    }

    [Fact]
    public async Task Success_InstallerExitsZero_HealthReportsExpectedVersion_WritesOkResult()
    {
        using var dir = new TempInstallDir();
        using var roots = new IsolatedRoots();
        var paths = InstallPaths.FromInstallDir(dir.Path);
        var installerPath = WriteFakeInstaller(roots.UpdateRoot, exitCode: 0);

        var process = new FakeProcessManager();
        var health = new FakeHealthChecker { RespondOnceResult = true, RunningVersionResult = "1.2.3" };
        var applier = new UpdateApplier(process, health, paths, new FakeLauncherLogger());

        var exitCode = await applier.ApplyAsync(installerPath, "1.2.3");

        Assert.Equal(0, exitCode);
        Assert.Equal(1, process.StopOwnedProcessesCallCount);
        Assert.Equal(1, process.StartServerCallCount);

        var result = ReadLastResult(roots.UpdateRoot);
        Assert.True(result.GetProperty("ok").GetBoolean());
        Assert.Equal("1.2.3", result.GetProperty("version").GetString());
        Assert.Equal(0, result.GetProperty("exitCode").GetInt32());

        var logFiles = Directory.GetFiles(Path.Combine(roots.UpdateRoot, "logs"), "update-*.log");
        Assert.Single(logFiles);
        Assert.True(new FileInfo(logFiles[0]).Length > 0);
    }

    [Fact]
    public async Task InstallerFails_NonZeroExitCode_WritesFailedResult_StillRestarts()
    {
        using var dir = new TempInstallDir();
        using var roots = new IsolatedRoots();
        var paths = InstallPaths.FromInstallDir(dir.Path);
        var installerPath = WriteFakeInstaller(roots.UpdateRoot, exitCode: 5);

        var process = new FakeProcessManager();
        var health = new FakeHealthChecker { RespondOnceResult = true, RunningVersionResult = "1.0.0" };
        var applier = new UpdateApplier(process, health, paths, new FakeLauncherLogger());

        var exitCode = await applier.ApplyAsync(installerPath, "1.2.3");

        Assert.Equal(5, exitCode);
        Assert.Equal(1, process.StartServerCallCount); // restart dzieje sie NIEZALEZNIE od wyniku

        var result = ReadLastResult(roots.UpdateRoot);
        Assert.False(result.GetProperty("ok").GetBoolean());
        Assert.Equal(5, result.GetProperty("exitCode").GetInt32());
    }

    [Fact]
    public async Task InstallerExitsZero_ButOldVersionStillRunningAfterRestart_TreatedAsFailure()
    {
        // Audyt v1.0.4, P0-8: Restart Manager potrafi po cichu pominac
        // zablokowany plik, dajac exitCode 0 mimo braku faktycznej podmiany.
        using var dir = new TempInstallDir();
        using var roots = new IsolatedRoots();
        var paths = InstallPaths.FromInstallDir(dir.Path);
        var installerPath = WriteFakeInstaller(roots.UpdateRoot, exitCode: 0);

        var process = new FakeProcessManager();
        var health = new FakeHealthChecker { RespondOnceResult = true, RunningVersionResult = "1.1.0" }; // stara wersja
        var applier = new UpdateApplier(process, health, paths, new FakeLauncherLogger());

        var exitCode = await applier.ApplyAsync(installerPath, "1.2.3");

        Assert.Equal(0, exitCode); // kod wyjscia instalatora zostaje, ale...
        var result = ReadLastResult(roots.UpdateRoot);
        Assert.False(result.GetProperty("ok").GetBoolean()); // ...ok jest false
        Assert.Contains("1.1.0", result.GetProperty("message").GetString());
    }

    [Fact]
    public async Task InstallerThrows_RestartStillHappens_ResultWritten()
    {
        using var dir = new TempInstallDir();
        using var roots = new IsolatedRoots();
        var paths = InstallPaths.FromInstallDir(dir.Path);
        var missingInstaller = Path.Combine(roots.UpdateRoot, "does-not-exist.exe");

        var process = new FakeProcessManager();
        var health = new FakeHealthChecker { RespondOnceResult = false };
        var applier = new UpdateApplier(process, health, paths, new FakeLauncherLogger());

        var exitCode = await applier.ApplyAsync(missingInstaller, "1.2.3");

        Assert.Equal(-1, exitCode);
        Assert.Equal(1, process.StartServerCallCount); // restart w finally, mimo wyjatku

        var result = ReadLastResult(roots.UpdateRoot);
        Assert.False(result.GetProperty("ok").GetBoolean());
    }

    [Fact]
    public async Task StaleDeadPidPrintLock_DoesNotBlockInstallation()
    {
        using var dir = new TempInstallDir();
        using var roots = new IsolatedRoots();
        var paths = InstallPaths.FromInstallDir(dir.Path);
        var installerPath = WriteFakeInstaller(roots.UpdateRoot, exitCode: 0);

        var lockDir = Path.Combine(roots.DataRoot, "runtime", "printing");
        Directory.CreateDirectory(lockDir);
        // PID praktycznie na pewno nie odpowiadajacy zadnemu zywemu procesowi.
        File.WriteAllText(Path.Combine(lockDir, "active.lock"), "{\"pid\": 999999}");

        var process = new FakeProcessManager();
        var health = new FakeHealthChecker { RespondOnceResult = true, RunningVersionResult = "1.2.3" };
        var applier = new UpdateApplier(process, health, paths, new FakeLauncherLogger());

        var exitCode = await applier.ApplyAsync(installerPath, "1.2.3");

        Assert.Equal(0, exitCode);
        Assert.Equal(1, process.StopOwnedProcessesCallCount);
    }
}
