using Scyzoryk.Launcher.Tests.Fakes;
using Xunit;

namespace Scyzoryk.Launcher.Tests;

/// <summary>
/// Tylko dymny test - realne Process.Start(UseShellExecute:true) na prawdziwy adres
/// nie powinno byc wykonywane w CI (otworzyloby faktyczna przegladarke). Liczniki
/// wywolan ("otwarto raz w trybie normalnym", "nigdy w --autostart") sa sprawdzane
/// w LauncherAppTests przez FakeBrowserLauncher, nie tutaj.
/// </summary>
public sealed class BrowserLauncherTests
{
    [Fact]
    public void OpenDefaultBrowser_InvalidTarget_NeverThrows_LogsWarningInstead()
    {
        var logger = new FakeLauncherLogger();
        var browser = new BrowserLauncher(logger);

        // Pusty FileName gwarantowanie rzuca InvalidOperationException wewnatrz
        // samego .NET (Process.Start), PRZED jakimkolwiek wywolaniem ShellExecute -
        // deterministyczne na kazdej maszynie/Windows, w przeciwienstwie do
        // "smieciowego" tekstu z bajtem \0, ktorego zachowanie przez ShellExecute
        // jest niepewne (zlapane realnie: na CI Windows nie rzucalo wcale).
        var exception = Record.Exception(() => browser.OpenDefaultBrowser(string.Empty));

        Assert.Null(exception);
        Assert.True(logger.HasEntryAt(LogLevel.Warning));
    }
}
