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

    private string? _logFilePath;

    public UpdateApplier(IProcessManager processManager, IHealthChecker health, InstallPaths paths, ILauncherLogger logger)
    {
        _processManager = processManager;
        _health = health;
        _paths = paths;
        _logger = logger;
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

        var exitCode = -1;
        var ok = false;
        var message = string.Empty;

        try
        {
            WriteLog($"=== Start aktualizacji Scyzoryka Projektowego do wersji {expectedVersion} ===");
            WriteLog($"InstallerPath = {installerPath}");
            WriteLog($"InstallDir    = {_paths.InstallDir}");

            // Krotka pauza, aby odpowiedz HTTP (202 z /api/update/install) zdazyla
            // dojsc do przegladarki, zanim zaczniemy zatrzymywac serwer, ktory ja
            // wysylal - identycznie jak dawny run-update.ps1.
            WriteLog("Czekam 2s, aby odpowiedz HTTP dotarla do przegladarki...");
            await Task.Delay(TimeSpan.FromSeconds(2)).ConfigureAwait(false);

            await WaitWhilePrintingActiveAsync().ConfigureAwait(false);

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

            // Audyt v1.0.4, P0-8: kod wyjscia instalatora (0 = "sukces") sam
            // w sobie nie dowodzi, ze faktycznie dziala nowa wersja - Restart
            // Manager potrafi po cichu pominac zablokowany plik. To jest
            // jedyny prawdziwy test sukcesu z punktu widzenia uzytkownika.
            if (ok && healthy && runningVersion is not null && runningVersion != expectedVersion)
            {
                ok = false;
                message = $"Instalator zakonczyl sie bez bledu, ale po restarcie nadal dziala wersja {runningVersion} (oczekiwano {expectedVersion}). Sprobuj ponownie.";
                WriteLog(message);
            }
            else if (ok && healthy && runningVersion is null)
            {
                WriteLog("OSTRZEZENIE: nie udalo sie odczytac wersji z /api/health po restarcie - nie mozna w pelni potwierdzic aktualizacji.");
            }

            WriteLastResult(ok, expectedVersion, exitCode, message);
            WriteLog("=== Koniec aktualizacji ===");
        }

        return exitCode;
    }

    /// <summary>Odpowiednik Test-PrintingActive w dawnym run-update.ps1 - ten sam plik
    /// blokady JSON {"pid": ...} zapisywany przez lib/printCoordinator.js, czekamy do
    /// 30s zamiast przerywac aktywny wydruk na sile.</summary>
    private async Task WaitWhilePrintingActiveAsync()
    {
        if (!IsPrintingActive()) return;

        WriteLog("Wykryto aktywne drukowanie - czekam do 30s przed zatrzymaniem procesow...");
        var deadline = DateTime.UtcNow.AddSeconds(30);
        while (IsPrintingActive() && DateTime.UtcNow < deadline)
        {
            await Task.Delay(TimeSpan.FromSeconds(2)).ConfigureAwait(false);
        }

        WriteLog(IsPrintingActive()
            ? "OSTRZEZENIE: drukowanie nadal aktywne po 30s oczekiwania - kontynuuje mimo to (aktualizacja nie moze utknac w nieskonczonosc)."
            : "Drukowanie zakonczone - kontynuuje aktualizacje.");
    }

    private bool IsPrintingActive()
    {
        try
        {
            var lockPath = Path.Combine(_paths.DataRoot, "runtime", "printing", "active.lock");
            if (!File.Exists(lockPath)) return false;

            using var doc = JsonDocument.Parse(File.ReadAllText(lockPath));
            if (!doc.RootElement.TryGetProperty("pid", out var pidEl) || pidEl.ValueKind != JsonValueKind.Number) return false;

            using var proc = Process.GetProcessById(pidEl.GetInt32());
            return true;
        }
        catch
        {
            return false;
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
