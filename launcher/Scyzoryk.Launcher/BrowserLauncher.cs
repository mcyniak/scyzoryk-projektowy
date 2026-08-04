using System.Diagnostics;

namespace Scyzoryk.Launcher;

public interface IBrowserLauncher
{
    /// <summary>Otwiera domyslna przegladarke systemowa na podanym adresie. Nigdy nie
    /// wybiera konkretnej przegladarki (Chrome/Edge) i nie wywoluje niczego wiecej niz
    /// raz na wywolanie.</summary>
    void OpenDefaultBrowser(string url);
}

public sealed class BrowserLauncher : IBrowserLauncher
{
    private readonly ILauncherLogger _logger;

    public BrowserLauncher(ILauncherLogger logger)
    {
        _logger = logger;
    }

    public void OpenDefaultBrowser(string url)
    {
        try
        {
            using var process = Process.Start(new ProcessStartInfo
            {
                FileName = url,
                UseShellExecute = true,
            });
        }
        catch (Exception ex)
        {
            // Brak zarejestrowanej domyslnej przegladarki albo inny blad powloki nie
            // powinien wyglądać jak awaria calego launchera - serwer juz dziala, tylko
            // nie udalo sie otworzyc karty.
            _logger.Log(LogLevel.Warning, "Nie udalo sie otworzyc przegladarki.", new Dictionary<string, string>
            {
                ["url"] = url,
                ["error"] = ex.Message,
            });
        }
    }
}
