namespace Scyzoryk.Launcher.Tests.Fakes;

/// <summary>Nigdy nie dotyka realnego WinForms - tylko zapisuje wywolania, zeby
/// testy mogly sprawdzic KIEDY (i czy w ogole) okno postepu bylo pokazywane.</summary>
public sealed class FakeStartupProgressPresenter : IStartupProgressPresenter
{
    public List<string> ShowMessages { get; } = new();
    public List<string> UpdateMessages { get; } = new();
    public int CloseCallCount { get; private set; }
    public bool WasShown => ShowMessages.Count > 0;

    public void Show(string message) => ShowMessages.Add(message);
    public void UpdateMessage(string message) => UpdateMessages.Add(message);
    public void Close() => CloseCallCount++;
}
