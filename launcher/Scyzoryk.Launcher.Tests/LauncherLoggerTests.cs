using Xunit;

namespace Scyzoryk.Launcher.Tests;

public sealed class LauncherLoggerTests
{
    private static string TempLogPath() => Path.Combine(Path.GetTempPath(), "scyzoryk-launcher-log-tests-" + Guid.NewGuid().ToString("N") + ".log");

    [Fact]
    public void WriteLogEntry_ContainsTimestampVersionModeInstallDir()
    {
        var logPath = TempLogPath();
        try
        {
            var logger = new LauncherLogger(logPath, "1.2.3");
            logger.Log(LogLevel.Info, "Start launchera.", new Dictionary<string, string>
            {
                ["mode"] = "Normal",
                ["installDir"] = @"C:\ScyzorykProjektowy",
            });

            var content = File.ReadAllText(logPath);

            Assert.Contains("1.2.3", content);
            Assert.Contains("Start launchera.", content);
            Assert.Contains("mode=Normal", content);
            Assert.Contains(@"installDir=C:\ScyzorykProjektowy", content);
            Assert.Contains("INFO", content);
        }
        finally
        {
            TryDelete(logPath);
        }
    }

    [Fact]
    public void LogFileExceedsCap_RotatesBeforeAppending()
    {
        var logPath = TempLogPath();
        try
        {
            // Wypelniamy plik ponad limit rotacji (4MB) niezaleznie od loggera, zeby
            // wymusic rotacje przy nastepnym zapisie.
            File.WriteAllText(logPath, new string('x', 5 * 1024 * 1024));

            var logger = new LauncherLogger(logPath, "1.0.0");
            logger.Log(LogLevel.Info, "Wpis po rotacji.");

            Assert.True(File.Exists(logPath + ".1"));
            var rotatedSize = new FileInfo(logPath + ".1").Length;
            Assert.True(rotatedSize > 4 * 1024 * 1024);

            var content = File.ReadAllText(logPath);
            Assert.Contains("Wpis po rotacji.", content);
            Assert.True(content.Length < 1024, "po rotacji nowy plik powinien zawierac tylko najnowszy wpis");
        }
        finally
        {
            TryDelete(logPath);
            TryDelete(logPath + ".1");
        }
    }

    [Fact]
    public void WriteFailure_NeverThrowsToCaller()
    {
        // Sciezka wskazujaca na nieistniejacy dysk/katalog, ktorego nie da sie
        // utworzyc - symuluje zablokowany/niedostepny cel zapisu.
        var impossiblePath = Path.Combine("Z:\\nonexistent-drive-scyzoryk-test", "launcher.log");
        var logger = new LauncherLogger(impossiblePath, "1.0.0");

        var exception = Record.Exception(() => logger.Log(LogLevel.Error, "To nie powinno wybuchnac."));

        Assert.Null(exception);
    }

    private static void TryDelete(string path)
    {
        try { File.Delete(path); } catch { /* best effort */ }
    }
}
