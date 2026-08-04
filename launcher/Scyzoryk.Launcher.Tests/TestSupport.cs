namespace Scyzoryk.Launcher.Tests;

internal static class TestTimings
{
    /// <summary>Te sam ksztalt co LauncherTimings.Production, ale w milisekundach -
    /// zeby testy scenariuszy timeout/oczekiwania nie trwaly naprawde minutami.</summary>
    public static LauncherTimings Fast { get; } = new(
        ProbeAttempts: 2,
        ProbeAttemptTimeout: TimeSpan.FromMilliseconds(20),
        ProbeDelayBetween: TimeSpan.FromMilliseconds(5),
        OwnerAcquireTimeout: TimeSpan.FromMilliseconds(200),
        BaseStartupTimeout: TimeSpan.FromMilliseconds(200),
        ExtendedStartupTimeout: TimeSpan.FromMilliseconds(100),
        WaiterTopUpTimeout: TimeSpan.FromMilliseconds(100),
        HealthCommandTimeout: TimeSpan.FromMilliseconds(50));
}

/// <summary>Tworzy tymczasowy katalog udajacy instalacje Scyzoryka (z lub bez
/// node-runtime\node.exe / server.js) i usuwa go po tescie.</summary>
internal sealed class TempInstallDir : IDisposable
{
    public string Path { get; }
    public InstallPaths Paths { get; }

    public TempInstallDir(bool includeNodeExe = true, bool includeServerJs = true)
    {
        Path = System.IO.Path.Combine(System.IO.Path.GetTempPath(), "scyzoryk-launcher-tests-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(Path);

        var nodeRuntimeDir = System.IO.Path.Combine(Path, "node-runtime");
        Directory.CreateDirectory(nodeRuntimeDir);

        if (includeNodeExe)
        {
            File.WriteAllText(System.IO.Path.Combine(nodeRuntimeDir, "node.exe"), string.Empty);
        }

        if (includeServerJs)
        {
            File.WriteAllText(System.IO.Path.Combine(Path, "server.js"), string.Empty);
        }

        Paths = InstallPaths.FromInstallDir(Path);
    }

    public void Dispose()
    {
        try
        {
            Directory.Delete(Path, recursive: true);
        }
        catch
        {
            // Najlepszy mozliwy wysilek - nie psuje wyniku testu.
        }
    }
}
