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
        var paths = InstallPaths.FromBaseDirectory();
        var version = Assembly.GetExecutingAssembly().GetName().Version?.ToString() ?? "0.0.0.0";
        var logger = new LauncherLogger(paths.LogFilePath, version);

        try
        {
            var parsedArgs = ArgsParser.Parse(args);
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
                new UpdateApplier(processManager, health, paths, logger));

            return app.RunAsync(parsedArgs).GetAwaiter().GetResult();
        }
        catch (Exception ex)
        {
            logger.Log(LogLevel.Error, "Nieobslugiwany wyjatek launchera.", new Dictionary<string, string>
            {
                ["exception"] = ex.ToString(),
            });

            MessageBox.Show(
                $"Scyzoryk Projektowy nie mogl sie uruchomic z powodu nieoczekiwanego bledu.\nSzczegoly: {paths.LogFilePath}",
                "Scyzoryk Projektowy",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error);

            return ExitCodes.UnhandledException;
        }
    }
}
