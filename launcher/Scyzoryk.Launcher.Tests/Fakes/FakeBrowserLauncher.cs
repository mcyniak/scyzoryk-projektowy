namespace Scyzoryk.Launcher.Tests.Fakes;

public sealed class FakeBrowserLauncher : IBrowserLauncher
{
    public int OpenCallCount { get; private set; }
    public string? LastUrl { get; private set; }

    public void OpenDefaultBrowser(string url)
    {
        OpenCallCount++;
        LastUrl = url;
    }
}
