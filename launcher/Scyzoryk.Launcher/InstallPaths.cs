using System.Security.Cryptography;
using System.Text;

namespace Scyzoryk.Launcher;

/// <summary>
/// Wszystkie sciezki i adresy, ktore launcher wyprowadza z wlasnego polozenia
/// (AppContext.BaseDirectory) - nigdy ze sciezki wpisanej na twardo (np.
/// C:\Users\...\ScyzorykProjektowy), zeby dzialalo identycznie w kazdej instalacji.
/// </summary>
public sealed class InstallPaths
{
    public string InstallDir { get; }
    public string NodeExePath { get; }
    public string ServerJsPath { get; }
    public string ScyzorykExePath { get; }
    public string Host { get; }
    public int Port { get; }
    public string PanelUrl { get; }
    public string HealthUrl { get; }
    public string LogFilePath { get; }
    public string MutexName { get; }
    public string TrayMutexName { get; }
    public string UpdateRoot { get; }
    public string DataRoot { get; }

    /// <summary>
    /// Audyt 2026-08-17 (zlapane live na produkcji): StopResidentTrayProcesses
    /// (skan Process.GetProcessesByName + porownanie MainModule) potrafi tak samo
    /// niedeterministycznie pominac rezydentna ikone w zasobniku, jak wczesniej
    /// (audyt 2026-08-12) pomijal glownego nadzorce server.js - instalator wtedy
    /// nie moze nadpisac WLASNIE dzialajacego Scyzoryk.exe (DeleteFile: plik w
    /// uzyciu, kod 5), aktualizacja pada w kolko tym samym sposobem. Dla
    /// nadzorcy server.js PID jest znany z calkowita pewnoscia (Node przekazuje
    /// wlasny process.pid) - dla rezydentnej ikony NIE MA takiego pewnego zrodla
    /// po stronie Node, wiec NotifyIconTrayHost sam zapisuje tu wlasny PID w
    /// momencie przejecia ikony (i usuwa przy zamknieciu) - lib/updateService.js
    /// odczytuje ten plik tuz przed spawnowaniem aktualizatora i przekazuje PID
    /// dalej jako jawny argument. W przeciwienstwie do PID nadzorcy server.js, ten
    /// PID NIE jest ufany bezwarunkowo (plik moze byc nieaktualny, PID moze zostac
    /// ponownie uzyty przez zupelnie inny proces) - UpdateApplier.EnsureResidentTrayStopped
    /// weryfikuje nazwe+sciezke przed zabiciem (patrz ProcessManager.KillProcessByIdIfPathMatches).
    /// </summary>
    public string ResidentTrayPidFilePath { get; }

    private InstallPaths(
        string installDir, string nodeExePath, string serverJsPath, string scyzorykExePath,
        string host, int port, string panelUrl, string healthUrl,
        string logFilePath, string mutexName, string trayMutexName, string updateRoot, string dataRoot,
        string residentTrayPidFilePath)
    {
        InstallDir = installDir;
        NodeExePath = nodeExePath;
        ServerJsPath = serverJsPath;
        ScyzorykExePath = scyzorykExePath;
        Host = host;
        Port = port;
        PanelUrl = panelUrl;
        HealthUrl = healthUrl;
        LogFilePath = logFilePath;
        MutexName = mutexName;
        TrayMutexName = trayMutexName;
        UpdateRoot = updateRoot;
        DataRoot = dataRoot;
        ResidentTrayPidFilePath = residentTrayPidFilePath;
    }

    /// <summary>
    /// Buduje InstallPaths z rzeczywistego polozenia launchera. Host/port sa
    /// czytane z tych samych zmiennych srodowiskowych co server.js (PORT,
    /// SCYZORYK_HOST - patrz server.js), zeby launcher nigdy nie "zgadywal"
    /// innego adresu niz ten, na ktorym faktycznie wystartuje wlasnie spawnowany
    /// serwer.
    /// </summary>
    public static InstallPaths FromBaseDirectory()
    {
        var installDir = AppContext.BaseDirectory.TrimEnd('\\', '/');
        return FromInstallDir(installDir);
    }

    public static InstallPaths FromInstallDir(string installDir)
    {
        installDir = installDir.TrimEnd('\\', '/');
        var nodeExePath = Path.Combine(installDir, "node-runtime", "node.exe");
        var serverJsPath = Path.Combine(installDir, "server.js");
        var scyzorykExePath = Path.Combine(installDir, "Scyzoryk.exe");

        var host = Environment.GetEnvironmentVariable("SCYZORYK_HOST");
        if (string.IsNullOrWhiteSpace(host)) host = "127.0.0.1";

        var portRaw = Environment.GetEnvironmentVariable("PORT");
        var port = 3000;
        if (!string.IsNullOrWhiteSpace(portRaw) && int.TryParse(portRaw, out var parsedPort) && parsedPort > 0)
        {
            port = parsedPort;
        }

        // PanelUrl (adres otwierany w przegladarce) uzywa stalej etykiety
        // "scyzoryk.localhost" zamiast Host/127.0.0.1 - domena .localhost jest
        // zarezerwowana (RFC 6761) i kazda przegladarka/system Windows rozwiazuje
        // KAZDA nazwe konczaca sie na .localhost bezposrednio do loopbacku, bez
        // zadnego wpisu w pliku hosts, bez DNS, bez uprawnien administratora.
        // HealthUrl celowo zostaje na Host (domyslnie 127.0.0.1) - to wewnetrzny,
        // wlasny health-check launchera, dla ktorego prosty adres IP jest bardziej
        // niezawodny niz poleganie na rozwiazywaniu nazw.
        var panelUrl = $"http://scyzoryk.localhost:{port}";
        var healthUrl = $"http://{host}:{port}/api/health";

        var localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        var logFilePath = Path.Combine(localAppData, "ScyzorykProjektowy", "logs", "launcher.log");

        var mutexName = "Local\\ScyzorykLauncher_" + HashInstallDir(installDir);
        // Osobny muteks od mutexName powyzej - ten arbitruje WYLACZNIE "kto pokazuje
        // ikone w zasobniku" (patrz TrayIconHost), nie "kto odpala node.exe". Trzymany
        // przez cala rezydentna zywotnosc procesu (nie tylko na chwile jak MutexName),
        // wiec musi byc osobnym obiektem - inaczej rezydentny wlasciciel ikony
        // blokowalby tez arbitraz startu serwera dla kazdej pozniejszej proby.
        var trayMutexName = "Local\\ScyzorykTray_" + HashInstallDir(installDir);

        // Te same sciezki co po stronie Node (server.js resolveUpdateRoot(),
        // lib/appPaths.js getDataRoot()) - SCYZORYK_UPDATE_ROOT/SCYZORYK_DATA_ROOT
        // respektowane identycznie (obie juz istnieja po stronie Node - nie sa
        // to nowe zmienne wprowadzone tylko dla launchera), zeby oba swiaty
        // liczyly te same katalogi niezaleznie, i zeby dalo sie to odizolowac
        // w testach bez dotykania prawdziwego %LOCALAPPDATA%.
        var updateRootOverride = Environment.GetEnvironmentVariable("SCYZORYK_UPDATE_ROOT");
        var updateRoot = string.IsNullOrWhiteSpace(updateRootOverride)
            ? Path.Combine(localAppData, "ScyzorykProjektowy", "Updates")
            : Path.GetFullPath(updateRootOverride);
        var dataRootOverride = Environment.GetEnvironmentVariable("SCYZORYK_DATA_ROOT");
        var dataRoot = string.IsNullOrWhiteSpace(dataRootOverride)
            ? Path.Combine(localAppData, "ScyzorykProjektowy", "Data")
            : Path.GetFullPath(dataRootOverride);

        // Ten sam podkatalog "runtime" co juz istniejacy runtime\printing\active.lock
        // (patrz UpdateApplier.IsPrintingActive) - miejsce na efemeryczne znaczniki
        // stanu procesu, nie na trwale dane uzytkownika.
        var residentTrayPidFilePath = Path.Combine(dataRoot, "runtime", "resident-tray.pid");

        return new InstallPaths(installDir, nodeExePath, serverJsPath, scyzorykExePath, host, port, panelUrl, healthUrl, logFilePath, mutexName, trayMutexName, updateRoot, dataRoot, residentTrayPidFilePath);
    }

    /// <summary>
    /// Sprawdza, ze bundlowany Node i server.js faktycznie istnieja, zanim launcher
    /// spróbuje cokolwiek odpalic. Zwraca po jednym brakujacym pliku na raz (kolejnosc:
    /// Node przed server.js) - wystarczy do pokazania jednego, konkretnego bledu.
    /// </summary>
    public bool TryValidate(out string? missingFriendlyName, out string? missingFullPath)
    {
        if (!File.Exists(NodeExePath))
        {
            missingFriendlyName = "node-runtime\\node.exe";
            missingFullPath = NodeExePath;
            return false;
        }

        if (!File.Exists(ServerJsPath))
        {
            missingFriendlyName = "server.js";
            missingFullPath = ServerJsPath;
            return false;
        }

        missingFriendlyName = null;
        missingFullPath = null;
        return true;
    }

    private static string HashInstallDir(string installDir)
    {
        var normalized = Path.GetFullPath(installDir).ToLowerInvariant();
        var bytes = Encoding.UTF8.GetBytes(normalized);
        var hash = SHA256.HashData(bytes);
        // 16 bajtow (32 znaki hex) - wystarczajaco unikalne dla nazwy muteksu, zeby
        // dwie rozne instalacje (np. dev + zainstalowana) na tym samym komputerze
        // nigdy nie trafily w ten sam obiekt.
        return Convert.ToHexString(hash, 0, 16);
    }
}
