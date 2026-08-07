namespace Scyzoryk.Launcher.Tests.Fakes;

/// <summary>Nigdy nie dotyka realnego WinForms/petli komunikatow - jesli
/// BecomeOwner=true, synchronicznie woła onOpenPanel/onQuit tylko jesli test sam
/// jawnie to zrobi przez zapamietane delegaty (SimulateOpenPanel/SimulateQuit),
/// zamiast prawdziwej interakcji uzytkownika z ikona.</summary>
public sealed class FakeTrayIconHost : ITrayIconHost
{
    public bool BecomeOwner { get; set; }
    public int TryRunResidentCallCount { get; private set; }
    private Action? _onOpenPanel;
    private Action? _onQuit;

    public bool TryRunResident(Action onOpenPanel, Action onQuit)
    {
        TryRunResidentCallCount++;
        _onOpenPanel = onOpenPanel;
        _onQuit = onQuit;
        return BecomeOwner;
    }

    public void SimulateOpenPanelClicked() => _onOpenPanel?.Invoke();
    public void SimulateQuitClicked() => _onQuit?.Invoke();
}
