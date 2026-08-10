using System.Diagnostics;
using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

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
    private readonly TimeSpan _stopConfirmTimeout;
    private readonly TimeSpan _stopConfirmPollInterval;
    private readonly TimeSpan _installRetryDelay;

    private string? _logFilePath;

    public UpdateApplier(IProcessManager processManager, IHealthChecker health, InstallPaths paths, ILauncherLogger logger,
        TimeSpan? printWaitTimeout = null, TimeSpan? printPollInterval = null,
        TimeSpan? stopConfirmTimeout = null, TimeSpan? stopConfirmPollInterval = null,
        TimeSpan? installRetryDelay = null)
    {
        _processManager = processManager;
        _health = health;
        _paths = paths;
        _logger = logger;
        _printWaitTimeout = printWaitTimeout ?? TimeSpan.FromSeconds(30);
        _printPollInterval = printPollInterval ?? TimeSpan.FromSeconds(2);
        _stopConfirmTimeout = stopConfirmTimeout ?? TimeSpan.FromSeconds(15);
        _stopConfirmPollInterval = stopConfirmPollInterval ?? TimeSpan.FromMilliseconds(500);
        _installRetryDelay = installRetryDelay ?? TimeSpan.FromSeconds(2);
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
            // Rezydentna ikona w zasobniku (patrz ITrayIconHost) trzyma otwarty
            // WLASNY plik .exe caly czas, gdy jest aktywna - ten sam plik, ktory
            // instalator zaraz probuje nadpisac. _paths tutaj to PRAWDZIWY katalog
            // instalacji (patrz Program.cs/ArgsParser dla --apply-update), wiec to
            // NIGDY nie zamyka tej wlasnie dzialajacej kopii-aktualizatora (ta zyje
            // w oddzielnym katalogu Updates\<wersja>\, inna sciezka).
            await StopAllOwnedProcessesUntilConfirmedAsync().ConfigureAwait(false);

            var attempt = await RunInstallerWithRetryAsync(installerPath).ConfigureAwait(false);
            exitCode = attempt.ExitCode;
            ok = attempt.Ok;
            message = ok ? $"Zainstalowano wersje {expectedVersion}." : attempt.FailureReason!;
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

    /// <summary>
    /// Audyt v1.1.7 (zlapane live na produkcji): Process.Kill() jest tylko
    /// ZADANIEM zakonczenia, nie gwarancja natychmiastowego zniknięcia z
    /// systemu. Zlapane realnie: stary proces server.js przetrwal
    /// StopOwnedProcesses (byl akurat w trakcie obslugi TEGO WLASNIE
    /// requestu /api/update/install, gdy przyszlo zabicie), instalator i tak
    /// ruszyl dalej, a stary proces zostal SIEROTA obok swiezo
    /// zainstalowanej wersji - dalej odpowiadal na tym samym porcie ze
    /// STARYM kodem (m.in. bez poprawki drukowania), a panel w przegladarce
    /// uzytkownika nigdy nie zobaczyl postepu poza "installing" (85%), bo
    /// ten martwy-ale-zywy proces nigdy juz nie zaktualizowal wlasnego stanu
    /// w pamieci. Ponawia StopOwnedProcesses/StopResidentTrayProcesses (obie
    /// funkcje sa idempotentne - kolejne wywolanie na juz-martwym procesie
    /// po prostu nic nie znajduje), az OBIE zwroca zero dopasowan w TEJ
    /// SAMEJ probie, albo minie limit czasu (wtedy kontynuuje mimo to -
    /// lepiej sprobowac zainstalowac niz utknac w nieskonczonosc). Krotka
    /// dodatkowa pauza po potwierdzeniu (TYLKO jesli cokolwiek naprawde
    /// trzeba bylo dogonic) daje systemowi czas na zwolnienie uchwytow
    /// plikow, zanim ruszy instalator - identyczny wzorzec jak juz
    /// sprawdzony Stop-Scyzoryk w scripts/ci/test-installed-scyzoryk.ps1.
    /// </summary>
    private async Task<(IReadOnlyList<int> stoppedNode, IReadOnlyList<int> stoppedTray)> StopAllOwnedProcessesUntilConfirmedAsync()
    {
        var deadline = DateTime.UtcNow.Add(_stopConfirmTimeout);
        var attempt = 0;
        IReadOnlyList<int> stoppedNode;
        IReadOnlyList<int> stoppedTray;
        while (true)
        {
            attempt++;
            stoppedNode = _processManager.StopOwnedProcesses(_paths.NodeExePath);
            stoppedTray = _processManager.StopResidentTrayProcesses(_paths.ScyzorykExePath);
            WriteLog($"Proba {attempt}: zatrzymano {stoppedNode.Count} procesow node.exe ({string.Join(",", stoppedNode)}), zamknieto {stoppedTray.Count} rezydentnych Scyzoryk.exe ({string.Join(",", stoppedTray)}).");

            if (stoppedNode.Count == 0 && stoppedTray.Count == 0)
            {
                if (attempt > 1)
                {
                    // Cos bylo do zabicia we wczesniejszej probie - krotki bufor na
                    // zwolnienie uchwytow plikow przez system, zanim ruszy instalator.
                    await Task.Delay(TimeSpan.FromSeconds(2)).ConfigureAwait(false);
                }
                return (stoppedNode, stoppedTray);
            }

            if (DateTime.UtcNow >= deadline)
            {
                WriteLog("Uwaga: procesy Scyzoryka nadal byly wykrywane po uplywie limitu czasu potwierdzenia zatrzymania - kontynuuje aktualizacje mimo to.");
                return (stoppedNode, stoppedTray);
            }
            await Task.Delay(_stopConfirmPollInterval).ConfigureAwait(false);
        }
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

    private sealed record InstallAttemptResult(int ExitCode, bool Ok, string? FailureReason);

    // Audyt na zywo 2026-08-10: prawdziwa awaria produkcyjna zlapana przez
    // wlasciciela ("aktualizacja sie wyjebala jak zawsze") - instalator
    // zwrocil kod 5 (Inno Setup: przerwane/nieudane kopiowanie, cicho
    // "potwierdzone" jako Abort przez /SUPPRESSMSGBOXES zamiast pokazac
    // uzytkownikowi realny blad), zostawiajac apps\formularze-varmero
    // (i jego cale node_modules) NIESKOPIOWANE, mimo ze build-info.json i
    // kilka innych plikow zdazyly sie juz podmienic - polowiczna, cicho
    // zepsuta instalacja. Recznie powtorzone URUCHOMIENIE TEGO SAMEGO
    // instalatora chwile pozniej zadzialalo od razu (przejsciowa blokada
    // pliku/skan antywirusa), wiec zamiast poddawac sie po jednej probie,
    // ponawiamy caly krok RAZ automatycznie - i, kluczowe, NIE ufamy juz
    // samemu kodowi wyjscia 0 jako dowodowi kompletnej kopii (Restart
    // Manager potrafi po cichu pominac zablokowany plik przy exitCode 0 -
    // patrz komentarz przy koncowej weryfikacji ok/healthy/runningVersion
    // nizej w tym samym duchu) - sprawdzamy realnie na dysku, ze KAZDA
    // apka w apps\* ma niepusty node_modules, dokladnie ten sam test co
    // scripts\build-installer.ps1 robi PRZED spakowaniem instalatora.
    private async Task<InstallAttemptResult> RunInstallerWithRetryAsync(string installerPath)
    {
        const int maxAttempts = 2;
        var logsDir = Path.Combine(_paths.UpdateRoot, "logs");
        var exitCode = -1;

        for (var attempt = 1; attempt <= maxAttempts; attempt++)
        {
            var innoLogPath = Path.Combine(logsDir, $"inno-{DateTime.Now:yyyyMMddTHHmmss}-proba{attempt}.log");
            WriteLog($"Uruchamiam instalator cicho (proba {attempt}/{maxAttempts}): {installerPath}");
            exitCode = RunInstaller(installerPath, _paths.InstallDir, innoLogPath);
            WriteLog($"Instalator zakonczony kodem wyjscia: {exitCode} (proba {attempt}/{maxAttempts}, szczegolowy log Inno: {Path.GetFileName(innoLogPath)})");

            var integrityIssue = DescribeIntegrityIssue();
            if (exitCode == 0 && integrityIssue is null)
            {
                return new InstallAttemptResult(exitCode, true, null);
            }

            if (integrityIssue is not null)
            {
                WriteLog($"Weryfikacja integralnosci po instalacji NIE przeszla: {integrityIssue}");
            }

            if (attempt < maxAttempts)
            {
                WriteLog("Instalacja niekompletna - ponawiam po krotkiej przerwie...");
                await StopAllOwnedProcessesUntilConfirmedAsync().ConfigureAwait(false);
                await Task.Delay(_installRetryDelay).ConfigureAwait(false);
            }
            else
            {
                var reason = integrityIssue is not null
                    ? (exitCode == 0
                        ? $"Instalator zglosil sukces, ale po {maxAttempts} probach instalacja jest nadal niekompletna: {integrityIssue}."
                        : $"Instalator zakonczyl sie kodem {exitCode} po {maxAttempts} probach, instalacja jest niekompletna: {integrityIssue}.")
                    : $"Instalator zakonczyl sie kodem {exitCode} po {maxAttempts} probach.";
                return new InstallAttemptResult(exitCode, false, reason);
            }
        }

        // Nieosiagalne (petla zawsze zwraca wewnatrz), ale kompilator wymaga zwrotu.
        return new InstallAttemptResult(exitCode, false, $"Instalator zakonczyl sie kodem {exitCode}.");
    }

    // Regex zamiast hardkodowanej listy - server.js (dopiero co skopiowany
    // przez INSTALATOR, wiec to zawsze najswiezsza wersja rejestru) jest
    // jedynym miejscem, ktore juz i tak zna PELNA liste aplikacji (patrz
    // CLAUDE.md - "register it in both the apps array..."), wiec czytamy
    // stamtad zamiast utrzymywac tu WLASNA, kolejna kopie listy nazw apek,
    // ktora rowniez moglaby sie zestarzec.
    private static readonly Regex AppSlugPattern = new(@"'apps',\s*'([a-z0-9][a-z0-9-]*)'", RegexOptions.Compiled);

    // Ten sam duch co "Walidacja node_modules w stagingu" w
    // scripts\build-installer.ps1 (krok 7) - tam sprawdza SWIEZO
    // zainstalowany staging PRZED spakowaniem do .exe, tutaj sprawdzamy
    // PRAWDZIWY katalog instalacji PO tym, jak instalator go rozpakowal na
    // dysku uzytkownika. Celowo NIE polega WYLACZNIE na tym, co juz fizycznie
    // istnieje pod apps\* (audyt na zywo 2026-08-10: apps\formularze-varmero
    // nie istnialo W OGOLE po nieudanej instalacji - sprawdzanie tylko
    // istniejacych katalogow nigdy by tego nie zlapalo) - oczekiwana lista
    // aplikacji pochodzi z rejestru w server.js, a fizyczna obecnosc katalogu
    // apps\* jest sprawdzana dodatkowo, na wypadek gdyby regex czegos nie
    // zlapal. Zwraca null, gdy wszystko jest w porzadku, albo czytelny opis
    // brakujacych/pustych aplikacji.
    private string? DescribeIntegrityIssue()
    {
        var appsDir = Path.Combine(_paths.InstallDir, "apps");
        var expectedSlugs = new SortedSet<string>(StringComparer.OrdinalIgnoreCase);

        var serverJsPath = Path.Combine(_paths.InstallDir, "server.js");
        if (File.Exists(serverJsPath))
        {
            string serverJsContent;
            try { serverJsContent = File.ReadAllText(serverJsPath); }
            catch { serverJsContent = string.Empty; }
            foreach (Match m in AppSlugPattern.Matches(serverJsContent))
            {
                expectedSlugs.Add(m.Groups[1].Value);
            }
        }

        if (Directory.Exists(appsDir))
        {
            foreach (var appDir in Directory.GetDirectories(appsDir))
            {
                expectedSlugs.Add(Path.GetFileName(appDir));
            }
        }

        var incomplete = new List<string>();
        foreach (var slug in expectedSlugs)
        {
            var nodeModules = Path.Combine(appsDir, slug, "node_modules");
            var hasFiles = Directory.Exists(nodeModules)
                && Directory.EnumerateFileSystemEntries(nodeModules, "*", SearchOption.TopDirectoryOnly).Any();
            if (!hasFiles)
            {
                incomplete.Add(slug);
            }
        }
        return incomplete.Count == 0 ? null : $"brak/pusty node_modules dla: {string.Join(", ", incomplete)}";
    }

    private static int RunInstaller(string installerPath, string installDir, string logPath)
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
        // podmienia pliki i wychodzi, restart robimy sami. /LOG dodany po
        // audycie na zywo 2026-08-10: bez tego, przy niepowodzeniu instalatora
        // (np. kod 5) jedyna dostepna informacja jest sam kod liczbowy - zero
        // wiedzy KTORY plik/krok faktycznie zawiodl. Inno Setup samo tworzy i
        // zamyka ten plik, wiec zostaje na dysku do recznej analizy nawet po
        // sukcesie (nadpisywany kolejnym uruchomieniem tej samej nazwy nie
        // jest problemem - kazda proba dostaje wlasna, znacznikiem czasu+numerem
        // proby nazwana sciezke, patrz RunInstallerWithRetryAsync).
        startInfo.ArgumentList.Add("/VERYSILENT");
        startInfo.ArgumentList.Add("/SUPPRESSMSGBOXES");
        startInfo.ArgumentList.Add("/NORESTART");
        startInfo.ArgumentList.Add("/SP-");
        startInfo.ArgumentList.Add("/SCYZORYKUPDATE");
        startInfo.ArgumentList.Add($"/DIR={installDir}");
        startInfo.ArgumentList.Add($"/LOG={logPath}");

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
