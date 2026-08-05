using Xunit;

namespace Scyzoryk.Launcher.Tests;

public sealed class InstallPathsTests
{
    [Fact]
    public void MutexNameDerivation_DifferentInstallPaths_ProduceDifferentNames()
    {
        var a = InstallPaths.FromInstallDir(@"C:\ScyzorykProjektowy");
        var b = InstallPaths.FromInstallDir(@"C:\Users\test\AppData\Local\Programs\ScyzorykProjektowy");

        Assert.NotEqual(a.MutexName, b.MutexName);
    }

    [Fact]
    public void MutexNameDerivation_PathCasingDoesNotChangeName()
    {
        var lower = InstallPaths.FromInstallDir(@"c:\scyzorykprojektowy");
        var upper = InstallPaths.FromInstallDir(@"C:\SCYZORYKPROJEKTOWY");

        Assert.Equal(lower.MutexName, upper.MutexName);
    }

    [Fact]
    public void MutexNameDerivation_StartsWithLocalPrefix()
    {
        var paths = InstallPaths.FromInstallDir(@"C:\ScyzorykProjektowy");

        Assert.StartsWith("Local\\ScyzorykLauncher_", paths.MutexName);
    }

    [Fact]
    public void PortAndHost_DefaultTo127001And3000_WhenEnvVarsUnset()
    {
        var previousPort = Environment.GetEnvironmentVariable("PORT");
        var previousHost = Environment.GetEnvironmentVariable("SCYZORYK_HOST");
        try
        {
            Environment.SetEnvironmentVariable("PORT", null);
            Environment.SetEnvironmentVariable("SCYZORYK_HOST", null);

            var paths = InstallPaths.FromInstallDir(@"C:\ScyzorykProjektowy");

            Assert.Equal("127.0.0.1", paths.Host);
            Assert.Equal(3000, paths.Port);
            Assert.Equal("http://scyzoryk.localhost:3000", paths.PanelUrl);
            Assert.Equal("http://127.0.0.1:3000/api/health", paths.HealthUrl);
        }
        finally
        {
            Environment.SetEnvironmentVariable("PORT", previousPort);
            Environment.SetEnvironmentVariable("SCYZORYK_HOST", previousHost);
        }
    }

    [Fact]
    public void PortAndHost_HonorEnvironmentVariables_LikeServerJs()
    {
        var previousPort = Environment.GetEnvironmentVariable("PORT");
        var previousHost = Environment.GetEnvironmentVariable("SCYZORYK_HOST");
        try
        {
            Environment.SetEnvironmentVariable("PORT", "4123");
            Environment.SetEnvironmentVariable("SCYZORYK_HOST", "127.0.0.1");

            var paths = InstallPaths.FromInstallDir(@"C:\ScyzorykProjektowy");

            Assert.Equal(4123, paths.Port);
            Assert.Equal("http://scyzoryk.localhost:4123", paths.PanelUrl);
            Assert.Equal("http://127.0.0.1:4123/api/health", paths.HealthUrl);
        }
        finally
        {
            Environment.SetEnvironmentVariable("PORT", previousPort);
            Environment.SetEnvironmentVariable("SCYZORYK_HOST", previousHost);
        }
    }

    [Fact]
    public void PanelUrl_AlwaysUsesScyzorykLocalhost_RegardlessOfHostOverride()
    {
        // PanelUrl (adres otwierany w przegladarce) jest celowo NIEZALEZNY od
        // SCYZORYK_HOST - domena .localhost dziala bez wzgledu na to, jaki adres
        // IP faktycznie sluchania; HealthUrl (wewnetrzny) nadal honoruje Host.
        var previousHost = Environment.GetEnvironmentVariable("SCYZORYK_HOST");
        try
        {
            Environment.SetEnvironmentVariable("SCYZORYK_HOST", "192.168.1.50");

            var paths = InstallPaths.FromInstallDir(@"C:\ScyzorykProjektowy");

            Assert.Equal("192.168.1.50", paths.Host);
            Assert.StartsWith("http://scyzoryk.localhost:", paths.PanelUrl);
            Assert.StartsWith("http://192.168.1.50:", paths.HealthUrl);
        }
        finally
        {
            Environment.SetEnvironmentVariable("SCYZORYK_HOST", previousHost);
        }
    }

    [Fact]
    public void TryValidate_ReturnsFalse_AndNamesMissingFile_WhenNodeExeMissing()
    {
        using var dir = new TempInstallDir(includeNodeExe: false);

        var valid = dir.Paths.TryValidate(out var friendly, out var fullPath);

        Assert.False(valid);
        Assert.Equal("node-runtime\\node.exe", friendly);
        Assert.Equal(dir.Paths.NodeExePath, fullPath);
    }

    [Fact]
    public void TryValidate_ReturnsTrue_WhenBothFilesPresent()
    {
        using var dir = new TempInstallDir();

        var valid = dir.Paths.TryValidate(out var friendly, out var fullPath);

        Assert.True(valid);
        Assert.Null(friendly);
        Assert.Null(fullPath);
    }
}
