using System.Drawing;
using System.Drawing.Drawing2D;
using System.Runtime.InteropServices;
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
/// Wlasny, recznie rysowany pasek postepu (zamiast natywnego ProgressBar) -
/// natywna kontrolka Win32 daje kolor TYLKO po wylaczeniu jej motywu
/// (SetWindowTheme(hwnd,"","") + PBM_SETBARCOLOR), a bez motywu wraca do
/// starego, "klasycznego" wygladu Windows z widoczna ramka/segmentami - zlapane
/// na zywo 2026-08-21 ("głupia ramka"). Rysowanie samemu (GDI+, wygladzanie
/// wlaczone) daje pelna kontrole: zaokraglone rogi, brak ramki, dokladny kolor
/// marki, dowolna wysokosc.
/// </summary>
internal sealed class FilledProgressBar : Control
{
    private double _valuePercent;
    public double ValuePercent
    {
        get => _valuePercent;
        set
        {
            _valuePercent = Math.Clamp(value, 0, 100);
            Invalidate();
        }
    }

    public Color FillColor { get; set; } = Color.FromArgb(0xCF, 0x17, 0x1F);
    public Color TrackColor { get; set; } = Color.FromArgb(0xEC, 0xEC, 0xEF);

    public FilledProgressBar()
    {
        SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.UserPaint
            | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        var g = e.Graphics;
        g.SmoothingMode = SmoothingMode.AntiAlias;
        var rect = ClientRectangle;
        if (rect.Width <= 0 || rect.Height <= 0) return;

        var radius = rect.Height / 2;
        using (var trackPath = RoundedRect(rect, radius))
        using (var trackBrush = new SolidBrush(TrackColor))
        {
            g.FillPath(trackBrush, trackPath);
        }

        var fillWidth = (int)Math.Round(rect.Width * (_valuePercent / 100.0));
        if (fillWidth <= 0) return;
        // Minimalna szerokosc = pelna wysokosc (srednica) - zeby przy niskich
        // procentach wypelnienie zawsze wygladalo jak "pigulka", nie plaski,
        // obciety prostokat.
        fillWidth = Math.Max(fillWidth, Math.Min(rect.Height, rect.Width));

        var fillRect = new Rectangle(rect.X, rect.Y, fillWidth, rect.Height);
        using var clipPath = RoundedRect(rect, radius);
        var oldClip = g.Clip;
        g.SetClip(clipPath, CombineMode.Replace);
        using (var fillPath = RoundedRect(fillRect, radius))
        using (var fillBrush = new SolidBrush(FillColor))
        {
            g.FillPath(fillBrush, fillPath);
        }
        g.Clip = oldClip;
    }

    private static GraphicsPath RoundedRect(Rectangle bounds, int radius)
    {
        var path = new GraphicsPath();
        var d = radius * 2;
        if (d <= 0 || d >= bounds.Width || d >= bounds.Height)
        {
            path.AddRectangle(bounds);
            return path;
        }
        path.AddArc(bounds.X, bounds.Y, d, d, 180, 90);
        path.AddArc(bounds.Right - d, bounds.Y, d, d, 270, 90);
        path.AddArc(bounds.Right - d, bounds.Bottom - d, d, d, 0, 90);
        path.AddArc(bounds.X, bounds.Bottom - d, d, d, 90, 90);
        path.CloseFigure();
        return path;
    }
}

/// <summary>
/// Prawdziwa implementacja WinForms. Formularz zyje na WLASNYM, dedykowanym
/// watku STA z wlasna petla komunikatow (Application.Run) - watek wywolujacy
/// (LauncherApp.RunEnsureAndReportAsync) jest w trakcie asynchronicznego
/// oczekiwania na proby sieciowe i nie moze sam pompowac komunikatow Windows.
/// Wszystkie operacje po starcie (UpdateMessage/Close) marshaluja przez
/// Control.BeginInvoke z dowolnego watku wywolujacego.
///
/// Pasek postepu jest CELOWO "falszywy" (determinate, ale nie liczony z
/// realnego postepu startu) - nie ma tu zadnego wiarygodnego zrodla procentu
/// (czekamy na health-check, nie na policzalne kroki), wiec plynnie zblizamy
/// sie do ~92% i dopiero Close() domyka go do 100% - czytelniejsze dla oka niz
/// pasek "w nieskonczonosc" (marquee), a jednoczesnie nie klamie, ze cos jest
/// dokladnie w polowie.
/// </summary>
public sealed class WinFormsStartupProgressPresenter : IStartupProgressPresenter
{
    private const double FakeProgressCeiling = 92.0;

    private readonly object _gate = new();
    private Thread? _uiThread;
    private Form? _form;
    private Label? _statusLabel;
    private FilledProgressBar? _progressBar;
    private System.Windows.Forms.Timer? _progressTimer;
    private double _fakeProgress;

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
                var built = BuildForm(message);
                _form = built.Form;
                _statusLabel = built.StatusLabel;
                _progressBar = built.ProgressBar;

                _fakeProgress = 0;
                _progressTimer = new System.Windows.Forms.Timer { Interval = 60 };
                _progressTimer.Tick += (_, _) => AdvanceFakeProgress();
                _progressTimer.Start();

                built.Form.FormClosed += (_, _) => _progressTimer?.Stop();
                built.Form.Shown += (_, _) => ready.Set();
                Application.Run(built.Form);
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

    // Plynne, asymptotyczne zblizanie do sufitu - nigdy go nie osiaga samo z
    // siebie (imituje "wciaz pracujemy" bez klamania, ze zaraz sie skonczy).
    private void AdvanceFakeProgress()
    {
        var bar = _progressBar;
        if (bar is null || bar.IsDisposed) return;
        _fakeProgress += (FakeProgressCeiling - _fakeProgress) * 0.045;
        try { bar.ValuePercent = _fakeProgress; }
        catch (ObjectDisposedException) { }
    }

    public void UpdateMessage(string message)
    {
        var form = _form;
        var label = _statusLabel;
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
                    // Domykamy pasek do pelna TUZ przed zamknieciem - czytelny
                    // sygnal "gotowe", zamiast po prostu znikniecia w polowie.
                    if (form.InvokeRequired)
                    {
                        form.BeginInvoke(new Action(() =>
                        {
                            if (_progressBar is { IsDisposed: false }) _progressBar.ValuePercent = 100;
                            form.Close();
                        }));
                    }
                    else
                    {
                        if (_progressBar is { IsDisposed: false }) _progressBar.ValuePercent = 100;
                        form.Close();
                    }
                }
            }
            catch (ObjectDisposedException) { }
            catch (InvalidOperationException) { }
            _form = null;
            _statusLabel = null;
            _progressBar = null;
            _uiThread = null;
        }
        // Poza lockiem - Join czeka na zakonczenie watku UI, ktory sam nie
        // probuje wejsc w ten sam lock.
        uiThread?.Join(TimeSpan.FromSeconds(2));
    }

    private static (Form Form, Label StatusLabel, FilledProgressBar ProgressBar) BuildForm(string message)
    {
        var titleFont = TryCreateFont("Segoe UI Semibold", 13.5F) ?? new Font("Segoe UI", 13.5F, FontStyle.Bold);
        // Status lekko pogrubiony (waga polgruba zamiast zwyklej) - zadane po
        // pierwszym pokazaniu okna na zywo 2026-08-24 ("troche grubsza czcionka").
        var statusFont = TryCreateStatusFont();

        Icon? appIcon = null;
        try { appIcon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); }
        catch { /* logo ponizej po prostu nie zajmie miejsca */ }

        // Uklad "splash" - logo + tytul wysrodkowane razem w jednym wierszu,
        // status wysrodkowany pod spodem, pasek postepu na samym dole.
        var headerPanel = new TableLayoutPanel
        {
            ColumnCount = 2,
            RowCount = 1,
            AutoSize = true,
            AutoSizeMode = AutoSizeMode.GrowAndShrink,
        };
        headerPanel.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
        headerPanel.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));

        Control? iconBox = null;
        if (appIcon is not null)
        {
            iconBox = new PictureBox
            {
                Image = appIcon.ToBitmap(),
                SizeMode = PictureBoxSizeMode.Zoom,
                Size = new Size(32, 32),
                Margin = new Padding(0, 4, 10, 0),
            };
        }
        var titleLabel = new Label
        {
            Text = "Scyzoryk Projektowy",
            AutoSize = true,
            TextAlign = ContentAlignment.MiddleLeft,
            Font = titleFont,
            ForeColor = Color.FromArgb(0x1A, 0x1A, 0x1E),
            Margin = new Padding(0),
        };
        if (iconBox is not null) headerPanel.Controls.Add(iconBox, 0, 0);
        headerPanel.Controls.Add(titleLabel, iconBox is not null ? 1 : 0, 0);

        var statusLabel = new Label
        {
            Text = message,
            AutoSize = false,
            TextAlign = ContentAlignment.MiddleCenter,
            Dock = DockStyle.Fill,
            Font = statusFont,
            ForeColor = Color.FromArgb(0x66, 0x66, 0x6E),
        };

        var progressBar = new FilledProgressBar
        {
            Dock = DockStyle.Fill,
        };
        var progressHost = new Panel { Dock = DockStyle.Bottom, Height = 12 + 26, Padding = new Padding(28, 0, 28, 26) };
        progressHost.Controls.Add(progressBar);

        var headerHost = new Panel { Dock = DockStyle.Top, Height = 62, Padding = new Padding(0, 20, 0, 0) };
        headerHost.Resize += (_, _) => CenterHorizontally(headerPanel, headerHost);
        headerPanel.SizeChanged += (_, _) => CenterHorizontally(headerPanel, headerHost);
        headerHost.Controls.Add(headerPanel);

        var body = new Panel { Dock = DockStyle.Fill, Padding = new Padding(24, 0, 24, 0) };
        body.Controls.Add(statusLabel);

        var form = new Form
        {
            Text = "Scyzoryk Projektowy",
            // Bezramkowe okno splasu: zadnego paska tytulu ani ramki - tylko
            // bialy kartelusz z logo, statusem i paskiem postepu. Obecnosc w
            // pasku zadan (ShowInTaskbar) zostaje, zeby dało sie go znalezc.
            FormBorderStyle = FormBorderStyle.None,
            StartPosition = FormStartPosition.CenterScreen,
            ClientSize = new Size(440, 172),
            MaximizeBox = false,
            MinimizeBox = false,
            ControlBox = false,
            ShowInTaskbar = true,
            TopMost = true,
            BackColor = Color.White,
            AutoScaleMode = AutoScaleMode.Font,
        };
        form.Controls.Add(body);
        form.Controls.Add(headerHost);
        form.Controls.Add(progressHost);
        if (appIcon is not null) form.Icon = appIcon;
        ApplyRoundedCorners(form);

        return (form, statusLabel, progressBar);
    }

    // DWMWA_WINDOW_CORNER_PREFERENCE - prosba do systemu o zaokraglone rogi.
    // Windows 11 zaokragla natywnie, z wygladzaniem i poprawnym cieniem;
    // na starszych systemach API po prostu nic nie zrobi, stad dodatkowy
    // fallback przez Region (GraphicsPath) ponizej - mniej ladne krawedzie,
    // ale ten sam efekt "okno bez ostrych rogów".
    private const int DwmwaWindowCornerPreference = 33;
    private const int DwmwcpRound = 2;

    [DllImport("dwmapi.dll")]
    private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attribute, ref int value, int sizeOfValue);

    private static void ApplyRoundedCorners(Form form)
    {
        try
        {
            var preference = DwmwcpRound;
            if (Environment.OSVersion.Version.Build >= 22000)
            {
                DwmSetWindowAttribute(form.Handle, DwmwaWindowCornerPreference, ref preference, sizeof(int));
                return;
            }
        }
        catch { /* fallback ponizej */ }

        // Fallback (Win10 i starsze): reczne obciecie rog Regionem. Promien
        // ~22 px przy oknie 440x172 czyta sie jak "karta", nie jak "pole tekstowe".
        const int radius = 22;
        var size = form.ClientSize;
        using var path = new GraphicsPath();
        path.AddArc(0, 0, radius * 2, radius * 2, 180, 90);
        path.AddArc(size.Width - radius * 2, 0, radius * 2, radius * 2, 270, 90);
        path.AddArc(size.Width - radius * 2, size.Height - radius * 2, radius * 2, radius * 2, 0, 90);
        path.AddArc(0, size.Height - radius * 2, radius * 2, radius * 2, 90, 90);
        path.CloseFigure();
        form.Region = new Region(path);
    }

    private static void CenterHorizontally(Control child, Control host)
    {
        child.Left = Math.Max(0, (host.ClientSize.Width - child.Width) / 2);
        child.Top = 0;
    }

    // "Segoe UI Semibold" jest osobna, prawdziwie zainstalowana rodzina na
    // Windows (nie kazdy System.Drawing.Font wariant FontStyle.Bold), ale
    // teoretycznie mogloby jej brakowac na jakiejs maszynie - stad proba z
    // bezpiecznym fallbackiem (zwykle Segoe UI Bold) w BuildForm powyzej.
    private static Font? TryCreateFont(string family, float size)
    {
        try
        {
            var font = new Font(family, size, FontStyle.Bold);
            return string.Equals(font.Name, family, StringComparison.OrdinalIgnoreCase) ? font : null;
        }
        catch
        {
            return null;
        }
    }

    // Czcionka statusu: "Regular" rodziny "Segoe UI Semibold" daje juz wage
    // polgruba (Bold nalozony na nia bylby za ciezki). Fallback: Segoe UI
    // z jawnym Bold - zawsze cos pogrubionego, nigdy kosmetycznie cienkie.
    private static Font TryCreateStatusFont()
    {
        try
        {
            var font = new Font("Segoe UI Semibold", 9.75F, FontStyle.Regular);
            if (string.Equals(font.Name, "Segoe UI Semibold", StringComparison.OrdinalIgnoreCase)) return font;
            font.Dispose();
        }
        catch { /* fallback ponizej */ }
        return new Font("Segoe UI", 9.75F, FontStyle.Bold);
    }
}
