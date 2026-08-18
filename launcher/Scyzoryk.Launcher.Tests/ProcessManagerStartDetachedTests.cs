using Xunit;

namespace Scyzoryk.Launcher.Tests;

/// <summary>
/// Real-process integracyjny test dla ProcessManager.StartDetached (cold-start
/// apply, patrz LauncherApp.ApplyPendingUpdateIfAnyAsync) - w odroznieniu od
/// LauncherAppTests (ktore uzywaja FakeProcessManager), ten test uruchamia
/// PRAWDZIWY node.exe i sprawdza, ze proces faktycznie startuje i dziala
/// NIEZALEZNIE od wywolujacego - StartDetached celowo NIE czeka na zakonczenie
/// (audyt na zywo 2026-08-18: wczesniejsza wersja tej metody, RunAndWaitAsync,
/// czekala synchronicznie, przez co wywolujacy proces trzymal otwarty wlasny
/// plik .exe i prawdziwy instalator padal kodem 5 "plik w uzyciu" - dokladnie
/// to, co cala przebudowa aktualizatora miala wyeliminowac).
/// </summary>
public sealed class ProcessManagerRunAndWaitTests
{
    [Fact]
    public async Task StartDetached_ReturnsImmediately_WhileRealProcessContinuesRunningIndependently()
    {
        var nodeExe = ResolveRealNodeExePath();
        var manager = new ProcessManager();
        var marker = Path.GetTempFileName();
        File.Delete(marker); // istnieje tylko jesli spawniony proces zdazyl go zapisac

        var sw = System.Diagnostics.Stopwatch.StartNew();
        // Proces spi 3s zanim cokolwiek zapisze - gdyby StartDetached czekalo na
        // zakonczenie (jak dawne RunAndWaitAsync), to wywolanie zajeloby >=3s.
        var script = $"setTimeout(() => require('fs').writeFileSync({System.Text.Json.JsonSerializer.Serialize(marker)}, 'done'), 3000)";
        var result = manager.StartDetached(nodeExe, new[] { "-e", script });
        sw.Stop();

        Assert.True(result.Success);
        Assert.True(result.Pid > 0);
        Assert.True(sw.ElapsedMilliseconds < 2000, $"StartDetached powinno wracac natychmiast, nie czekac na spiacy proces (zajelo {sw.ElapsedMilliseconds}ms).");
        Assert.False(File.Exists(marker), "Spiacy proces nie mial jeszcze czasu dokonczyc pracy - StartDetached na pewno na niego nie czekalo.");

        // Sprzatanie: poczekaj az proces faktycznie skonczy (dowod, ze naprawde
        // dziala niezaleznie), potem usun znacznik.
        var deadline = DateTime.UtcNow.AddSeconds(10);
        while (!File.Exists(marker) && DateTime.UtcNow < deadline) await Task.Delay(200);
        Assert.True(File.Exists(marker), "Odlaczony proces powinien byl dokonczyc prace mimo ze wywolujacy juz dawno wrocil.");
        try { File.Delete(marker); } catch { }
    }

    [Fact]
    public void StartDetached_ReturnsFailed_ForNonExistentExecutable()
    {
        var manager = new ProcessManager();

        var result = manager.StartDetached(@"C:\this\path\does\not\exist\Scyzoryk.exe", Array.Empty<string>());

        Assert.False(result.Success);
        Assert.NotNull(result.ErrorMessage);
    }

    private static string ResolveRealNodeExePath()
    {
        var fromPath = Environment.GetEnvironmentVariable("PATH")?.Split(Path.PathSeparator)
            .Select(dir => Path.Combine(dir, "node.exe"))
            .FirstOrDefault(File.Exists);
        return fromPath ?? throw new InvalidOperationException("node.exe nie znaleziony w PATH - test wymaga prawdziwego node.exe.");
    }
}
