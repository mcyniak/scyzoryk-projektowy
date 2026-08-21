using System.Reflection;
using System.Windows.Forms;

namespace Scyzoryk.Launcher;

/// <summary>
/// Punkt wejscia - tylko okablowanie. Caly nieobslugiwany wyjatek jest zlapany tutaj
/// jako ostatnia siatka bezpieczenstwa: logujemy pelny szczegol do launcher.log, ale
/// uzytkownikowi pokazujemy jeden, krotki, zrozumialy komunikat (nigdy surowy stack
/// trace) - to jest JEDYNY MessageBox poza tym, ktory LauncherApp moze pokazac dla
/// udokumentowanych scenariuszy bledu startu.
/// </summary>
public static class Program
{
    [STAThread]
    public static int Main(string[] args)
    {
        var initialPaths = InstallPaths.FromBaseDirectory();
        var version = Assembly.GetExecutingAssembly().GetName().Version?.ToString() ?? "0.0.0.0";
        var logger = new LauncherLogger(initialPaths.LogFilePath, version);

        try
        {
            var parsedArgs = ArgsParser.Parse(args);

            // Incydent na zywo (2026-08-06): dla --apply-update ten proces to
            // KOPIA Scyzoryk.exe uruchomiona z katalogu aktualizacji, nie z
            // prawdziwego katalogu instalacji - FromBaseDirectory() dla tej
            // kopii wskazywalby na katalog aktualizacji (node.exe/server.js
            // szukane w zlym miejscu). Prawdziwy katalog instalacji przychodzi
            // teraz jawnie jako argument (patrz ArgsParser) - LogFilePath nie
            // zalezy od installDir, wiec initialPaths.LogFilePath uzyty wyzej
            // pozostaje poprawny niezaleznie od trybu.
            var paths = parsedArgs.Mode == LauncherMode.ApplyUpdate && !string.IsNullOrWhiteSpace(parsedArgs.RealInstallDir)
                ? InstallPaths.FromInstallDir(parsedArgs.RealInstallDir!)
                : initialPaths;

            var health = new HealthChecker();
            var processManager = new ProcessManager();

            using var gate = new SingleInstanceGate(paths.MutexName);
            var app = new LauncherApp(
                paths,
                health,
                processManager,
                new BrowserLauncher(logger),
                gate,
                logger,
                new MessageBoxFatalErrorPresenter(),
                new UpdateApplier(processManager, health, paths, logger),
                new AutostartManager(),
                tray: new NotifyIconTrayHost(paths.TrayMutexName, paths.ResidentTrayPidFilePath, logger),
                startupProgress: new WinFormsStartupProgressPresenter());

            return app.RunAsync(parsedArgs).GetAwaiter().GetResult();
        }
        catch (Exception ex)
        {
            logger.Log(LogLevel.Error, "Nieobslugiwany wyjatek launchera.", new Dictionary<string, string>
            {
                ["exception"] = ex.ToString(),
            });

            MessageBox.Show(
                $"Scyzoryk Projektowy nie mogl sie uruchomic z powodu nieoczekiwanego bledu.\nSzczegoly: {initialPaths.LogFilePath}",
                "Scyzoryk Projektowy",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error);

            return ExitCodes.UnhandledException;
        }
    }
}
