using System.ComponentModel;
using System.Diagnostics;

namespace Scyzoryk.Launcher;

public sealed record SpawnResult(bool Success, int Pid, string? ErrorMessage)
{
    public static SpawnResult Ok(int pid) => new(true, pid, null);
    public static SpawnResult Failed(string errorMessage) => new(false, 0, errorMessage);
}

public interface IProcessManager
{
    /// <summary>Odpala bundlowany node-runtime\node.exe server.js, cwd = installDir.
    /// Nigdy przez cmd/PowerShell/VBS - bezposredni ProcessStartInfo.</summary>
    SpawnResult StartServer(string installDir, string nodeExePath);

    /// <summary>Odpala dowolny plik wykonywalny z podanymi argumentami i CZEKA na
    /// jego zakonczenie, zwracajac prawdziwy kod wyjscia - w odroznieniu od
    /// StartServer/dawnego spawnUpdaterProcess (odlaczony, fire-and-forget proces).
    /// Uzywane wylacznie przez ApplyPendingUpdateIfAnyAsync (cold-start apply, patrz
    /// LauncherApp.cs) do odpalenia skopiowanego Scyzoryk.exe --apply-update PRZED
    /// jakimkolwiek probowaniem startu wlasnego serwera - w tym momencie nic jeszcze
    /// nie zyje, wiec nie ma potrzeby (ani sensu) odlaczac tego procesu od
    /// rodzica.</summary>
    Task<int> RunAndWaitAsync(string exePath, IReadOnlyList<string> args);

    /// <summary>Zatrzymuje WYLACZNIE procesy node.exe, ktorych pelna sciezka pliku
    /// wykonywalnego zgadza sie z bundlowanym node-runtime\node.exe tej instalacji -
    /// dokladnie logika scripts\stop-scyzoryk.ps1. Zwraca PID-y faktycznie zabitych
    /// procesow (moze byc pusta lista).</summary>
    IReadOnlyList<int> StopOwnedProcesses(string expectedNodeExeFullPath);

    /// <summary>Analogiczne do StopOwnedProcesses, ale dla rezydentnych procesow
    /// Scyzoryk.exe (te z otwarta ikona w zasobniku, patrz ITrayIconHost) tej
    /// konkretnej instalacji. UpdateApplier wola to PRZED uruchomieniem instalatora
    /// aktualizacji - inaczej rezydentny proces trzymalby otwarty wlasny plik .exe,
    /// ktory instalator wlasnie probuje nadpisac. Dopasowanie po pelnej sciezce (jak
    /// wyzej), wiec kopia uruchomiona z katalogu aktualizacji (--apply-update, inna
    /// sciezka) nigdy nie zabija sama siebie.</summary>
    IReadOnlyList<int> StopResidentTrayProcesses(string expectedScyzorykExeFullPath);

    bool IsProcessStillAlive(int pid);

    /// <summary>Zabija DOKLADNIE ten jeden PID (bez dopasowania po nazwie/sciezce) -
    /// zapasowa siatka bezpieczenstwa niezalezna od StopOwnedProcesses. Audyt
    /// 2026-08-12: zlapane live na produkcji, ze StopOwnedProcesses potrafi (z
    /// nieznanej, niedeterministycznej przyczyny - prawdopodobnie chwilowa
    /// niespojnosc migawki Process.GetProcessesByName) pominac WLASNIE glowny
    /// proces-nadzorce server.js, mimo ze jego sciezka identycznie pasuje jak
    /// kazdego z jego dzieci. Poniewaz to WLASNIE ten proces spawnuje
    /// --apply-update (patrz lib/updateService.js), jego PID jest znany z
    /// calkowita pewnoscia (przekazywany jako jawny argument, nie zgadywany) -
    /// ta metoda jest ostatnia, gwarantowana proba dobicia go po PID, niezalezna
    /// od tego, czy szerszy skan po nazwie/sciezce go w ogole zobaczyl.
    /// Zwraca true jesli proces zostal zabity albo juz nie zyl.</summary>
    bool KillProcessById(int pid);

    /// <summary>Jak KillProcessById, ale NAJPIERW weryfikuje, ze podany PID wciaz
    /// zyje I jego glowny modul zgadza sie ze wskazana pelna sciezka (dokladnie
    /// IsOwnedNodeProcess) - w odroznieniu od KillProcessById (gdzie PID jest
    /// zawsze ufany bezwarunkowo, bo pochodzi z wlasnego process.pid wywolujacego),
    /// tutaj PID moze pochodzic z pliku zapisanego przez INNY, juz nieistniejacy
    /// proces (patrz InstallPaths.ResidentTrayPidFilePath) - system moglby w
    /// miedzyczasie ponownie uzyc tego samego numeru dla zupelnie niepowiazanego
    /// procesu, ktorego NIGDY nie wolno zabic tylko dlatego, ze zgadza sie numer.
    /// Zwraca true jesli docelowy proces zostal zabity albo juz nie zyl; false
    /// jesli PID zyje, ale NIE jest oczekiwanym procesem (nic nie robimy) albo
    /// zabicie sie nie udalo.</summary>
    bool KillProcessByIdIfPathMatches(int pid, string expectedFullPath);
}

public sealed class ProcessManager : IProcessManager
{
    /// <summary>
    /// Wydzielone z StartServer, zeby dalo sie sprawdzic w tescie jednostkowym (bez
    /// realnego spawnu procesu), ze budowany ProcessStartInfo nigdy nie idzie przez
    /// cmd/powershell/wscript/cscript i ma oczekiwane cwd/argumenty/zmienne
    /// srodowiskowe.
    /// </summary>
    public static ProcessStartInfo BuildServerStartInfo(string installDir, string nodeExePath)
    {
        var nodeDir = Path.GetDirectoryName(nodeExePath) ?? installDir;

        var startInfo = new ProcessStartInfo
        {
            FileName = nodeExePath,
            WorkingDirectory = installDir,
            UseShellExecute = false,
            CreateNoWindow = true,
        };
        startInfo.ArgumentList.Add("server.js");

        // ProcessStartInfo.EnvironmentVariables to System.Collections.Specialized.StringDictionary
        // (nie IDictionary<string,string>) - brak TryGetValue, ale indekser bezpiecznie
        // zwraca null dla brakujacego klucza (nie rzuca).
        var existingPath = startInfo.EnvironmentVariables["PATH"] ?? string.Empty;
        startInfo.EnvironmentVariables["PATH"] = string.IsNullOrEmpty(existingPath)
            ? nodeDir
            : $"{nodeDir};{existingPath}";
        startInfo.EnvironmentVariables["PLAYWRIGHT_BROWSERS_PATH"] = "0";

        return startInfo;
    }

    public SpawnResult StartServer(string installDir, string nodeExePath)
    {
        try
        {
            var startInfo = BuildServerStartInfo(installDir, nodeExePath);

            var process = Process.Start(startInfo);
            if (process is null) return SpawnResult.Failed("Process.Start zwrocil null.");

            return SpawnResult.Ok(process.Id);
        }
        catch (Exception ex)
        {
            return SpawnResult.Failed(ex.Message);
        }
    }

    public async Task<int> RunAndWaitAsync(string exePath, IReadOnlyList<string> args)
    {
        var startInfo = new ProcessStartInfo
        {
            FileName = exePath,
            UseShellExecute = false,
            CreateNoWindow = true,
        };
        foreach (var arg in args) startInfo.ArgumentList.Add(arg);

        using var process = Process.Start(startInfo);
        if (process is null) return -1;
        await process.WaitForExitAsync().ConfigureAwait(false);
        return process.ExitCode;
    }

    public IReadOnlyList<int> StopOwnedProcesses(string expectedNodeExeFullPath)
        => StopProcessesByNameAndPath("node", expectedNodeExeFullPath);

    public IReadOnlyList<int> StopResidentTrayProcesses(string expectedScyzorykExeFullPath)
        => StopProcessesByNameAndPath("Scyzoryk", expectedScyzorykExeFullPath);

    /// <summary>Wspolna implementacja dla StopOwnedProcesses/StopResidentTrayProcesses -
    /// jedyna roznica miedzy nimi to nazwa procesu do wyszukania
    /// (Process.GetProcessesByName nie bierze rozszerzenia .exe).</summary>
    private static IReadOnlyList<int> StopProcessesByNameAndPath(string processName, string expectedFullPathRaw)
    {
        var stopped = new List<int>();
        var expectedFull = Path.GetFullPath(expectedFullPathRaw);
        // Audyt v1.1.6 (zlapane na CI): "Scyzoryk" jako processName pasuje TAKZE do
        // procesu, ktory WLASNIE WYKONUJE to wywolanie (--stop jest samo trybem
        // Scyzoryk.exe, uruchomionym z tej samej sciezki instalacji co rezydentna
        // ikona) - bez tego wykluczenia proces zabijalby SAM SIEBIE w polowie
        // wykonania --stop. StopOwnedProcesses (nazwa "node") nigdy nie trafia w
        // ten przypadek, ale wykluczenie jest tu uniwersalne (nie tylko dla trybu
        // tray), zeby przyszle wywolania tej funkcji byly bezpieczne z zalozenia.
        var currentPid = Environment.ProcessId;

        Process[] candidates;
        try
        {
            candidates = Process.GetProcessesByName(processName);
        }
        catch
        {
            return stopped;
        }

        foreach (var proc in candidates)
        {
            using (proc)
            {
                if (proc.Id == currentPid) continue;

                string? mainModulePath;
                try
                {
                    mainModulePath = proc.MainModule?.FileName;
                }
                catch (Win32Exception)
                {
                    // Brak dostepu do MainModule (np. proces innego uzytkownika/32 vs 64-bit) -
                    // pomijamy, nigdy nie zgadujemy.
                    continue;
                }
                catch (InvalidOperationException)
                {
                    // Proces zdazyl juz zakonczyc sie miedzy enumeracja a odczytem.
                    continue;
                }

                if (mainModulePath is null || !IsOwnedNodeProcess(mainModulePath, expectedFull)) continue;

                try
                {
                    proc.Kill(entireProcessTree: true);
                    stopped.Add(proc.Id);
                }
                catch (InvalidOperationException)
                {
                    // Proces juz zakonczony - nie jest to blad z punktu widzenia "zatrzymaj".
                }
                catch (Win32Exception)
                {
                    // entireProcessTree:true buduje wewnetrznie Job Object - w zasadzie
                    // zawsze dziala nawet dla procesu juz nalezacego do INNEGO joba
                    // (Windows 8+ obsluguje zagniezdzanie), ale to jest cudzy, zewnetrzny
                    // Win32 (np. proces w trakcie zamykania traci uchwyt w polowie
                    // wywolania) - zamiast rezygnowac calkowicie, probujemy jeszcze
                    // zwyklego Kill() bez proby zbudowania drzewa/joba, zanim faktycznie
                    // dodamy do listy pominietych.
                    try
                    {
                        proc.Kill();
                        stopped.Add(proc.Id);
                    }
                    catch (InvalidOperationException)
                    {
                    }
                    catch (Win32Exception)
                    {
                        // Odmowa dostepu / proces w trakcie zamykania - pomijamy, kontynuujemy
                        // z reszta kandydatow zamiast przerywac cala operacje.
                    }
                }
            }
        }

        return stopped;
    }

    public bool KillProcessById(int pid)
    {
        Process proc;
        try
        {
            proc = Process.GetProcessById(pid);
        }
        catch (ArgumentException)
        {
            return true; // juz nie zyje
        }

        using (proc)
        {
            try
            {
                if (proc.HasExited) return true;
                proc.Kill(entireProcessTree: true);
            }
            catch (InvalidOperationException)
            {
                return true; // juz nie zyje
            }
            catch (Win32Exception)
            {
                try
                {
                    proc.Kill();
                }
                catch (InvalidOperationException)
                {
                    return true;
                }
                catch (Win32Exception)
                {
                    return false;
                }
            }

            try
            {
                return proc.WaitForExit(5000);
            }
            catch (InvalidOperationException)
            {
                return true;
            }
        }
    }

    public bool KillProcessByIdIfPathMatches(int pid, string expectedFullPath)
    {
        Process proc;
        try
        {
            proc = Process.GetProcessById(pid);
        }
        catch (ArgumentException)
        {
            return true; // juz nie zyje - nic do zrobienia
        }

        using (proc)
        {
            string? mainModulePath;
            try
            {
                if (proc.HasExited) return true;
                mainModulePath = proc.MainModule?.FileName;
            }
            catch (Win32Exception)
            {
                // Brak dostepu do MainModule - nie zgadujemy, nie zabijamy.
                return false;
            }
            catch (InvalidOperationException)
            {
                return true; // zdazyl sie zakonczyc miedzy sprawdzeniem a odczytem
            }

            if (mainModulePath is null || !IsOwnedNodeProcess(mainModulePath, expectedFullPath))
            {
                // PID zyje, ale to NIE jest oczekiwany proces (numer zostal ponownie
                // uzyty przez cos innego, albo plik z PID-em jest po prostu nieaktualny) -
                // nigdy nie zabijamy cudzego, niepowiazanego procesu.
                return false;
            }

            try
            {
                proc.Kill(entireProcessTree: true);
            }
            catch (InvalidOperationException)
            {
                return true;
            }
            catch (Win32Exception)
            {
                try
                {
                    proc.Kill();
                }
                catch (InvalidOperationException)
                {
                    return true;
                }
                catch (Win32Exception)
                {
                    return false;
                }
            }

            try
            {
                return proc.WaitForExit(5000);
            }
            catch (InvalidOperationException)
            {
                return true;
            }
        }
    }

    public bool IsProcessStillAlive(int pid)
    {
        try
        {
            using var proc = Process.GetProcessById(pid);
            return !proc.HasExited;
        }
        catch (ArgumentException)
        {
            return false;
        }
        catch (InvalidOperationException)
        {
            return false;
        }
    }

    /// <summary>Czysta funkcja porownania sciezek - wydzielona, zeby dalo sie ja
    /// przetestowac bez realnych procesow.</summary>
    public static bool IsOwnedNodeProcess(string mainModulePath, string expectedNodeExeFullPath)
    {
        string normalizedActual;
        string normalizedExpected;
        try
        {
            normalizedActual = Path.GetFullPath(mainModulePath);
            normalizedExpected = Path.GetFullPath(expectedNodeExeFullPath);
        }
        catch
        {
            return false;
        }

        return string.Equals(normalizedActual, normalizedExpected, StringComparison.OrdinalIgnoreCase);
    }
}
