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

        var exception = Record.Exception(() => browser.OpenDefaultBrowser("\0-nie-jest-to-uruchamialny-adres"));

        Assert.Null(exception);
        Assert.True(logger.HasEntryAt(LogLevel.Warning));
    }
}
