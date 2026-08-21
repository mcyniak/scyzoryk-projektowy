using System.Drawing;
using System.Windows.Forms;

namespace Scyzoryk.Launcher;

/// <summary>
/// Male okno z paskiem postepu pokazywane podczas startu (klikniecie skrotu na
/// pulpicie) - audyt na zywo 2026-08-21: bez zadnej informacji zwrotnej,
/// uzytkownik zobaczywszy "nic sie nie dzieje" (np. w trakcie cichej instalacji
/// aktualizacji, ktora moze trwac dlugo - kopiowanie node_modules 14 apek +
/// Chromium + Ghostscript) klikal skrot PONOWNIE, co odpalalo kolejna,
/// zbedna probe przejecia startu serwera i kolidowalo plikowo z wlasnie
/// trwajaca instalacja. Pokazywane WYLACZNIE w normalnym trybie (klikniecie
/// skrotu), nigdy przy --autostart (celowo ciche logowanie) ani gdy panel juz
/// odpowiada na pierwsza probe (typowy przypadek - "juz dziala", bez zadnego
/// widocznego okna, zeby nie migac niepotrzebnie).
/// </summary>
public interface IStartupProgressPresenter
{
    void Show(string message);
    void UpdateMessage(string message);
    void Close();
}

/// <summary>Domyslny "no-op" dla trybow, ktore nie powinny pokazywac zadnego okna
/// (--autostart, wszystkie istniejace testy jednostkowe LauncherApp).</summary>
public sealed class NullStartupProgressPresenter : IStartupProgressPresenter
{
    public void Show(string message) { }
    public void UpdateMessage(string message) { }
    public void Close() { }
}

/// <summary>
/// Prawdziwa implementacja WinForms. Formularz zyje na WLASNYM, dedykowanym
/// watku STA z wlasna petla komunikatow (Application.Run) - watek wywolujacy
/// (LauncherApp.RunEnsureAndReportAsync) jest w trakcie asynchronicznego
/// oczekiwania na proby sieciowe i nie moze sam pompowac komunikatow Windows.
/// Wszystkie operacje po starcie (UpdateMessage/Close) marshaluja przez
/// Control.BeginInvoke z dowolnego watku wywolujacego.
/// </summary>
public sealed class WinFormsStartupProgressPresenter : IStartupProgressPresenter
{
    private readonly object _gate = new();
    private Thread? _uiThread;
    private Form? _form;
    private Label? _label;

    public void Show(string message)
    {
        lock (_gate)
        {
            if (_uiThread is not null)
            {
                UpdateMessage(message);
                return;
            }

            var ready = new ManualResetEventSlim(false);
            _uiThread = new Thread(() =>
            {
                var (form, label) = BuildForm(message);
                _form = form;
                _label = label;
                form.Shown += (_, _) => ready.Set();
                Application.Run(form);
            })
            {
                IsBackground = true,
                Name = "ScyzorykStartupProgress",
            };
            _uiThread.SetApartmentState(ApartmentState.STA);
            _uiThread.Start();
            // Best-effort - jesli okno nie zdazy sie pokazac w 2s (np. bardzo
            // obciazona maszyna), kontynuujemy i tak; kolejne UpdateMessage/Close
            // ponizej same sprawdzaja stan _form przed uzyciem.
            ready.Wait(TimeSpan.FromSeconds(2));
        }
    }

    public void UpdateMessage(string message)
    {
        var form = _form;
        var label = _label;
        if (form is null || label is null) return;
        try
        {
            if (form.IsDisposed) return;
            if (form.InvokeRequired) form.BeginInvoke(new Action(() => { if (!label.IsDisposed) label.Text = message; }));
            else label.Text = message;
        }
        catch (ObjectDisposedException) { /* okno wlasnie sie zamyka - bez znaczenia */ }
        catch (InvalidOperationException) { /* uchwyt okna jeszcze/juz nie istnieje - bez znaczenia */ }
    }

    public void Close()
    {
        Thread? uiThread;
        lock (_gate)
        {
            var form = _form;
            uiThread = _uiThread;
            if (form is null) return;
            try
            {
                if (!form.IsDisposed)
                {
                    if (form.InvokeRequired) form.BeginInvoke(new Action(form.Close));
                    else form.Close();
                }
            }
            catch (ObjectDisposedException) { }
            catch (InvalidOperationException) { }
            _form = null;
            _label = null;
            _uiThread = null;
        }
        // Poza lockiem - Join czeka na zakonczenie watku UI, ktory sam nie
        // probuje wejsc w ten sam lock.
        uiThread?.Join(TimeSpan.FromSeconds(2));
    }

    private static (Form Form, Label Label) BuildForm(string message)
    {
        var label = new Label
        {
            Text = message,
            AutoSize = false,
            TextAlign = ContentAlignment.MiddleCenter,
            Dock = DockStyle.Fill,
            Font = new Font("Segoe UI", 9.5F),
            Padding = new Padding(16, 8, 16, 0),
        };
        var progressBar = new ProgressBar
        {
            Style = ProgressBarStyle.Marquee,
            MarqueeAnimationSpeed = 30,
            Dock = DockStyle.Bottom,
            Height = 18,
            Margin = new Padding(16, 0, 16, 12),
        };
        var panel = new Panel { Dock = DockStyle.Fill, Padding = new Padding(0, 0, 0, 12) };
        panel.Controls.Add(label);

        var form = new Form
        {
            Text = "Scyzoryk Projektowy",
            FormBorderStyle = FormBorderStyle.FixedDialog,
            StartPosition = FormStartPosition.CenterScreen,
            ClientSize = new Size(380, 120),
            MaximizeBox = false,
            MinimizeBox = false,
            ControlBox = false,
            ShowInTaskbar = true,
            TopMost = true,
        };
        form.Controls.Add(panel);
        form.Controls.Add(progressBar);
        try
        {
            var icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
            if (icon is not null) form.Icon = icon;
        }
        catch
        {
            // Brak ikony okna nie moze zablokowac pokazania samego okna.
        }
        return (form, label);
    }
}
