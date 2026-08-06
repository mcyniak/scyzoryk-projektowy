using System.Diagnostics;
using System.Globalization;
using System.Text;
using System.Text.Json;

namespace Scyzoryk.Launcher;

public interface IUpdateApplier
{
    /// <summary>
    /// Port scripts\run-update.ps1 na C# - patrz komentarz przy wywolaniu w
    /// LauncherApp.RunApplyUpdateAsync dla pelnego uzasadnienia (usuniecie
    /// PowerShella z lancucha procesow, ktory byl wychwytywany przez firmowy
    /// EDR jako sygnatura "living-off-the-land dropper"). Zatrzymuje Scyzoryka,
    /// uruchamia instalator po cichu, uruchamia Scyzoryka ponownie i zapisuje
    /// wynik do last-result.json - dokladnie ten sam kontrakt plikowy z Node
    /// (lib/updateService.js), niezmieniony wzgledem wersji PowerShell.
    /// </summary>
    Task<int> ApplyAsync(string installerPath, string expectedVersion);
}

public sealed class UpdateApplier : IUpdateApplier
{
    private readonly IProcessManager _processManager;
    private readonly IHealthChecker _health;
    private readonly InstallPaths _paths;
    private readonly ILauncherLogger _logger;
    private readonly TimeSpan _printWaitTimeout;
    private readonly TimeSpan _printPollInterval;

    private string? _logFilePath;

    public UpdateApplier(IProcessManager processManager, IHealthChecker health, InstallPaths paths, ILauncherLogger logger,
        TimeSpan? printWaitTimeout = null, TimeSpan? printPollInterval = null)
    {
        _processManager = processManager;
        _health = health;
        _paths = paths;
        _logger = logger;
        _printWaitTimeout = printWaitTimeout ?? TimeSpan.FromSeconds(30);
        _printPollInterval = printPollInterval ?? TimeSpan.FromSeconds(2);
    }

    public async Task<int> ApplyAsync(string installerPath, string expectedVersion)
    {
        var logsDir = Path.Combine(_paths.UpdateRoot, "logs");
        Directory.CreateDirectory(logsDir);
        // Ta sama konwencja nazwy jak dawny run-update.ps1 - Node
        // (confirmUpdaterStarted w lib/updateService.js) wykrywa sukces
        // odpalenia wylacznie po pojawieniu sie nowego pliku pasujacego do
        // "update-*.log" w tym katalogu, wiec nazwa MUSI zostac identyczna.
        _logFilePath = Path.Combine(logsDir, $"update-{DateTime.Now:yyyyMMddTHHmmss}.log");

        WriteLog($"=== Start aktualizacji Scyzoryka Projektowego do wersji {expectedVersion} ===");
        WriteLog($"InstallerPath = {installerPath}");
        WriteLog($"InstallDir    = {_paths.InstallDir}");

        // Krotka pauza, aby odpowiedz HTTP (202 z /api/update/install) zdazyla
        // dojsc do przegladarki, zanim zaczniemy zatrzymywac serwer, ktory ja
        // wysylal - identycznie jak dawny run-update.ps1.
        WriteLog("Czekam 2s, aby odpowiedz HTTP dotarla do przegladarki...");
        await Task.Delay(TimeSpan.FromSeconds(2)).ConfigureAwait(false);

        // Audyt rozdz. 26, P0: dawniej po limicie oczekiwania aktualizacja
        // BYLA WYMUSZANA - procesy Scyzoryka zatrzymywane mimo trwajacego
        // druku, co moglo przerwac serie w polowie i zostawic niekompletna,
        // trudna do ustalenia dokumentacje. Teraz sprawdzamy PRZED
        // jakimkolwiek zatrzymaniem procesow: jesli druk nadal trwa po
        // limicie czasu, aktualizacja jest w calosci ODLOZONA (nie
        // wymuszona) - nic nie jest zatrzymywane ani instalowane, wiec nie
        // ma tez nic do przywracania w finally.
        if (!await WaitForPrintingToFinishAsync().ConfigureAwait(false))
        {
            var deferMessage = "Aktualizacja odlozona - drukowanie nadal trwa po czasie oczekiwania. Sprobuj ponownie pozniej.";
            WriteLog(deferMessage);
            WriteLastResult(false, expectedVersion, -1, deferMessage);
            WriteLog("=== Koniec aktualizacji (odlozona z powodu aktywnego druku) ===");
            return -1;
        }

        var exitCode = -1;
        var ok = false;
        var message = string.Empty;

        try
        {
            WriteLog("Zatrzymuje procesy Scyzoryka...");
            var stopped = _processManager.StopOwnedProcesses(_paths.NodeExePath);
            WriteLog($"Zatrzymano {stopped.Count} procesow: {string.Join(",", stopped)}");

            WriteLog($"Uruchamiam instalator cicho: {installerPath}");
            exitCode = RunInstaller(installerPath, _paths.InstallDir);
            WriteLog($"Instalator zakonczony kodem wyjscia: {exitCode}");
            ok = exitCode == 0;
            message = ok ? $"Zainstalowano wersje {expectedVersion}." : $"Instalator zakonczyl sie kodem {exitCode}.";
        }
        catch (Exception ex)
        {
            exitCode = -1;
            ok = false;
            message = $"Blad aktualizacji: {ex.Message}";
            WriteLog(message);
        }
        finally
        {
            // Restart Scyzoryka NIEZALEZNIE od wyniku instalacji - uzytkownik
            // ma zawsze zostac z dzialajaca aplikacja (starsza lub nowa), a
            // nie z niczym - identycznie jak dawny run-update.ps1's finally.
            WriteLog("Uruchamiam Scyzoryka ponownie...");
            try
            {
                var spawn = _processManager.StartServer(_paths.InstallDir, _paths.NodeExePath);
                if (!spawn.Success)
                {
                    WriteLog($"Nie udalo sie uruchomic ponownie Scyzoryka: {spawn.ErrorMessage}");
                }
            }
            catch (Exception ex)
            {
                WriteLog($"Nie udalo sie uruchomic ponownie Scyzoryka: {ex.Message}");
            }

            WriteLog("Sprawdzam /api/health po restarcie...");
            var healthy = await _health.IsRespondingOnceAsync(_paths.HealthUrl, TimeSpan.FromSeconds(60)).ConfigureAwait(false);
            string? runningVersion = null;
            if (healthy)
            {
                runningVersion = await _health.GetRunningVersionAsync(_paths.HealthUrl, TimeSpan.FromSeconds(5)).ConfigureAwait(false);
            }
            WriteLog($"Health-check po restarcie: {healthy}, wersja dzialajaca: {runningVersion ?? "(brak)"}");

            // Audyt v1.0.4, P0-8 + audyt rozdz. 26, P1: kod wyjscia instalatora
            // (0 = "sukces") sam w sobie nie dowodzi, ze faktycznie dziala nowa
            // wersja - Restart Manager potrafi po cichu pominac zablokowany
            // plik, panel moze w ogole nie wrocic, albo odpowiedziec bez
            // wersji. Sukces wymaga WSZYSTKICH warunkow naraz: ok, healthy i
            // runningVersion==expectedVersion - kazdy inny przypadek to
            // niepowodzenie z czytelnym powodem, nie samo ostrzezenie w logu.
            if (ok && !healthy)
            {
                ok = false;
                message = "Instalator zakonczyl sie bez bledu, ale panel nie odpowiedzial na /api/health po restarcie.";
                WriteLog(message);
            }
            else if (ok && runningVersion is null)
            {
                ok = false;
                message = "Instalator zakonczyl sie bez bledu, ale nie udalo sie odczytac wersji z /api/health po restarcie - nie mozna potwierdzic aktualizacji.";
                WriteLog(message);
            }
            else if (ok && runningVersion != expectedVersion)
            {
                ok = false;
                message = $"Instalator zakonczyl sie bez bledu, ale po restarcie nadal dziala wersja {runningVersion} (oczekiwano {expectedVersion}). Sprobuj ponownie.";
                WriteLog(message);
            }

            WriteLastResult(ok, expectedVersion, exitCode, message);
            WriteLog("=== Koniec aktualizacji ===");
        }

        return exitCode;
    }

    /// <summary>Odpowiednik Test-PrintingActive w dawnym run-update.ps1 - ten sam plik
    /// blokady JSON {"pid": ...} zapisywany przez lib/printCoordinator.js.
    /// </summary>
    /// <returns>true jesli mozna kontynuowac aktualizacje (druk sie zakonczyl albo
    /// nigdy nie byl aktywny), false jesli druk nadal trwa po uplywie limitu czasu.</returns>
    private async Task<bool> WaitForPrintingToFinishAsync()
    {
        if (!IsPrintingActive()) return true;

        WriteLog($"Wykryto aktywne drukowanie - czekam do {_printWaitTimeout.TotalSeconds}s przed kontynuacja aktualizacji...");
        var deadline = DateTime.UtcNow.Add(_printWaitTimeout);
        while (IsPrintingActive() && DateTime.UtcNow < deadline)
        {
            await Task.Delay(_printPollInterval).ConfigureAwait(false);
        }

        if (IsPrintingActive())
        {
            WriteLog("Drukowanie nadal aktywne po uplywie limitu czasu oczekiwania.");
            return false;
        }

        WriteLog("Drukowanie zakonczone - kontynuuje aktualizacje.");
        return true;
    }

    private bool IsPrintingActive()
    {
        var lockPath = Path.Combine(_paths.DataRoot, "runtime", "printing", "active.lock");
        if (!File.Exists(lockPath)) return false;

        string content;
        try
        {
            content = File.ReadAllText(lockPath);
        }
        catch
        {
            // Audyt rozdz. 26, P1: plik istnieje, ale w tej chwili nie da sie go
            // odczytac (np. wspolbiezny zapis przez printCoordinator.js) -
            // traktujemy to ZACHOWAWCZO jako mozliwy aktywny druk, zamiast
            // cicho zwracac "false" (ten sam wzorzec co
            // lib/printCoordinator.js#readLock po stronie Node).
            return true;
        }

        JsonDocument doc;
        try
        {
            doc = JsonDocument.Parse(content);
        }
        catch
        {
            return true;
        }

        using (doc)
        {
            if (!doc.RootElement.TryGetProperty("pid", out var pidEl) || pidEl.ValueKind != JsonValueKind.Number) return true;

            try
            {
                using var proc = Process.GetProcessById(pidEl.GetInt32());
                return true;
            }
            catch
            {
                // PID z locka juz nie istnieje - druk faktycznie sie zakonczyl,
                // to zwykly nieposprzatany (stary) lock, nie blad odczytu.
                return false;
            }
        }
    }

    private static int RunInstaller(string installerPath, string installDir)
    {
        var startInfo = new ProcessStartInfo
        {
            FileName = installerPath,
            UseShellExecute = false,
            CreateNoWindow = true,
        };
        // Identyczne flagi jak dawny run-update.ps1 - /SCYZORYKUPDATE (patrz
        // installer\scyzoryk.iss [Code]) pomija kreator, ponowna konfiguracje
        // autostartu, UAC i postinstall-autostart aplikacji - instalator tylko
        // podmienia pliki i wychodzi, restart robimy sami.
        startInfo.ArgumentList.Add("/VERYSILENT");
        startInfo.ArgumentList.Add("/SUPPRESSMSGBOXES");
        startInfo.ArgumentList.Add("/NORESTART");
        startInfo.ArgumentList.Add("/SP-");
        startInfo.ArgumentList.Add("/SCYZORYKUPDATE");
        startInfo.ArgumentList.Add($"/DIR={installDir}");

        using var proc = Process.Start(startInfo);
        if (proc is null) return -1;
        proc.WaitForExit();
        return proc.ExitCode;
    }

    private void WriteLastResult(bool ok, string version, int exitCode, string message)
    {
        var result = new
        {
            ok,
            version,
            exitCode,
            message,
            logFile = Path.GetFileName(_logFilePath),
            timestamp = DateTime.UtcNow.ToString("o", CultureInfo.InvariantCulture)
        };
        var json = JsonSerializer.Serialize(result);
        var resultPath = Path.Combine(_paths.UpdateRoot, "last-result.json");
        var tmpPath = $"{resultPath}.tmp-{Environment.ProcessId}";
        try
        {
            File.WriteAllText(tmpPath, json, new UTF8Encoding(false));
            File.Move(tmpPath, resultPath, overwrite: true);
        }
        catch (Exception ex)
        {
            WriteLog($"Nie udalo sie zapisac last-result.json: {ex.Message}");
        }
    }

    /// <summary>Dopisuje NATYCHMIAST do pliku na dysku (nigdy buforowane do konca) -
    /// Node (confirmUpdaterStarted w lib/updateService.js) czeka najwyzej ~12s na
    /// pojawienie sie/zaktualizowanie tego pliku jako dowodu, ze ten proces
    /// faktycznie wystartowal, wiec pierwsza linia musi trafic na dysk zanim
    /// zdazymy zrobic cokolwiek innego (dokladnie jak Write-Log w dawnym
    /// run-update.ps1).</summary>
    private void WriteLog(string message)
    {
        var line = $"[{DateTime.Now:o}] {message}";
        _logger.Log(LogLevel.Info, message);
        if (_logFilePath is null) return;
        try
        {
            File.AppendAllText(_logFilePath, line + Environment.NewLine, Encoding.UTF8);
        }
        catch
        {
            // Nieudany zapis logu diagnostycznego nie moze zablokowac zakonczenia
            // aktualizacji - last-result.json (osobny, wlasny try/catch) jest
            // jedynym kontraktem, na ktorym polega Node.
        }
    }
}
