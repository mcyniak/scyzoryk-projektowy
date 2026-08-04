using System.Globalization;
using System.Text;

namespace Scyzoryk.Launcher;

public enum LogLevel
{
    Info,
    Warning,
    Error,
}

public interface ILauncherLogger
{
    void Log(LogLevel level, string message, IReadOnlyDictionary<string, string>? fields = null);
}

/// <summary>
/// Zapisuje do %LOCALAPPDATA%\ScyzorykProjektowy\logs\launcher.log - oddzielnie od
/// panelu (patrz lib/hardening.js, ...\Data\panel\logs\panel-glowny.jsonl), zeby
/// logi launchera nigdy nie przeplatywaly sie z logami samego serwera. Prosta
/// rotacja jednej generacji (launcher.log -> launcher.log.1) po przekroczeniu limitu
/// rozmiaru. Kazdy blad zapisu jest wylapywany i wyciszany - nieudany log NIE moze
/// nigdy zablokowac faktycznego startu Scyzoryka.
///
/// NIGDY nie loguj: tokenow/nagłowkow autoryzacji, tresci dokumentow uzytkownika,
/// danych formularzy, danych OCR - tylko metadane samego procesu uruchamiania
/// (czas, tryb, PID-y, wynik health-checka, bledy startu).
/// </summary>
public sealed class LauncherLogger : ILauncherLogger
{
    private const long MaxBytes = 4L * 1024 * 1024;
    private readonly string _logFilePath;
    private readonly string _launcherVersion;
    private readonly object _lock = new();

    public LauncherLogger(string logFilePath, string launcherVersion)
    {
        _logFilePath = logFilePath;
        _launcherVersion = launcherVersion;
    }

    public void Log(LogLevel level, string message, IReadOnlyDictionary<string, string>? fields = null)
    {
        try
        {
            lock (_lock)
            {
                RotateIfNeeded();

                var line = new StringBuilder();
                line.Append('[').Append(DateTimeOffset.Now.ToString("o", CultureInfo.InvariantCulture)).Append("] ");
                line.Append(level.ToString().ToUpperInvariant()).Append(' ');
                line.Append("launcher=").Append(_launcherVersion).Append(' ');
                line.Append(message);

                if (fields is { Count: > 0 })
                {
                    foreach (var kv in fields)
                    {
                        line.Append(' ').Append(kv.Key).Append('=').Append(kv.Value);
                    }
                }

                var directory = Path.GetDirectoryName(_logFilePath);
                if (!string.IsNullOrEmpty(directory)) Directory.CreateDirectory(directory);

                File.AppendAllText(_logFilePath, line.ToString() + Environment.NewLine, Encoding.UTF8);
            }
        }
        catch
        {
            // Zapis logu nigdy nie moze przerwac faktycznej pracy launchera
            // (dysk pelny, plik zablokowany przez inny proces, brak uprawnien do
            // %LOCALAPPDATA% w nietypowej konfiguracji - i tak dalej).
        }
    }

    private void RotateIfNeeded()
    {
        try
        {
            var info = new FileInfo(_logFilePath);
            if (!info.Exists || info.Length < MaxBytes) return;

            var rotatedPath = _logFilePath + ".1";
            File.Copy(_logFilePath, rotatedPath, overwrite: true);
            File.WriteAllText(_logFilePath, string.Empty, Encoding.UTF8);
        }
        catch
        {
            // Nieudana rotacja nie powinna blokowac dalszego dopisywania do logu.
        }
    }
}
