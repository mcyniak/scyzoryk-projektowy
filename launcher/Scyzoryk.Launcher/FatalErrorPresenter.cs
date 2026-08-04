using System.Windows.Forms;

namespace Scyzoryk.Launcher;

public interface IFatalErrorPresenter
{
    /// <summary>Pokazuje jeden, czytelny komunikat bledu. Nigdy surowego stack trace -
    /// to zadanie osoby wywolujacej (LauncherApp/Program), zeby przekazac tu juz
    /// gotowy, zrozumiały tekst.</summary>
    void Show(string message);
}

public sealed class MessageBoxFatalErrorPresenter : IFatalErrorPresenter
{
    public void Show(string message)
    {
        MessageBox.Show(message, "Scyzoryk Projektowy", MessageBoxButtons.OK, MessageBoxIcon.Error);
    }
}
