namespace Scyzoryk.Launcher.Tests.Fakes;

public sealed class FakeFatalErrorPresenter : IFatalErrorPresenter
{
    public int ShowCallCount { get; private set; }
    public string? LastMessage { get; private set; }

    public void Show(string message)
    {
        ShowCallCount++;
        LastMessage = message;
    }
}
