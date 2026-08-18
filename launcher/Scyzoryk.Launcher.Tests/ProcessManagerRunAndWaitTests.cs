using Xunit;

namespace Scyzoryk.Launcher.Tests;

/// <summary>
/// Real-process integracyjny test dla ProcessManager.RunAndWaitAsync (cold-start
/// apply, patrz LauncherApp.ApplyPendingUpdateIfAnyAsync) - w odroznieniu od
/// LauncherAppTests (ktore uzywaja FakeProcessManager), ten test uruchamia
/// PRAWDZIWY node.exe i sprawdza, ze prawdziwy kod wyjscia jest poprawnie
/// przechwycony i zwrocony - dokladnie to, na czym polega roznica wzgledem
/// dawnego, odlaczonego spawnUpdaterProcess (ktory na Windows zawsze widzial
/// kod wyjscia 0 niezaleznie od realnego wyniku, patrz historyczny komentarz w
/// lib/updateService.js).
/// </summary>
public sealed class ProcessManagerRunAndWaitTests
{
    [Fact]
    public async Task RunAndWaitAsync_ReturnsRealExitCode_FromRealProcess()
    {
        var nodeExe = ResolveRealNodeExePath();
        var manager = new ProcessManager();

        var exitCode = await manager.RunAndWaitAsync(nodeExe, new[] { "-e", "process.exit(7)" });

        Assert.Equal(7, exitCode);
    }

    [Fact]
    public async Task RunAndWaitAsync_ReturnsZero_WhenProcessSucceeds()
    {
        var nodeExe = ResolveRealNodeExePath();
        var manager = new ProcessManager();

        var exitCode = await manager.RunAndWaitAsync(nodeExe, new[] { "-e", "process.exit(0)" });

        Assert.Equal(0, exitCode);
    }

    private static string ResolveRealNodeExePath()
    {
        var fromPath = Environment.GetEnvironmentVariable("PATH")?.Split(Path.PathSeparator)
            .Select(dir => Path.Combine(dir, "node.exe"))
            .FirstOrDefault(File.Exists);
        return fromPath ?? throw new InvalidOperationException("node.exe nie znaleziony w PATH - test wymaga prawdziwego node.exe.");
    }
}
