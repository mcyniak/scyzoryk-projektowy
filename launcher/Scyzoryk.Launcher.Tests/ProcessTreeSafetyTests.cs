using Xunit;

namespace Scyzoryk.Launcher.Tests;

/// <summary>
/// Polowa C#-owa wymogu "normalny start nigdy nie odpala cmd/powershell/wscript/
/// cscript" - druga polowa (rzeczywisty brak takich procesow potomnych na zywej
/// instalacji) jest w scripts\ci\test-installed-scyzoryk.ps1, bo test jednostkowy
/// nie moze dowiesc nieobecnosci procesow na poziomie systemu operacyjnego.
/// </summary>
public sealed class ProcessTreeSafetyTests
{
    private static readonly string[] ForbiddenSubstrings = { "cmd", "powershell", "wscript", "cscript", "shell32" };

    [Fact]
    public void BuildServerStartInfo_NeverGoesThroughAShell()
    {
        var installDir = @"C:\ScyzorykProjektowy";
        var nodeExePath = @"C:\ScyzorykProjektowy\node-runtime\node.exe";

        var startInfo = ProcessManager.BuildServerStartInfo(installDir, nodeExePath);

        Assert.False(startInfo.UseShellExecute);
        Assert.True(startInfo.CreateNoWindow);
        Assert.Equal(nodeExePath, startInfo.FileName);
        Assert.Equal(installDir, startInfo.WorkingDirectory);

        foreach (var forbidden in ForbiddenSubstrings)
        {
            Assert.DoesNotContain(forbidden, startInfo.FileName, StringComparison.OrdinalIgnoreCase);
        }
    }

    [Fact]
    public void BuildServerStartInfo_ArgumentListContainsOnlyServerJs()
    {
        var startInfo = ProcessManager.BuildServerStartInfo(@"C:\ScyzorykProjektowy", @"C:\ScyzorykProjektowy\node-runtime\node.exe");

        Assert.Single(startInfo.ArgumentList);
        Assert.Equal("server.js", startInfo.ArgumentList[0]);
    }

    [Fact]
    public void BuildServerStartInfo_SetsExpectedEnvironmentVariables()
    {
        var installDir = @"C:\ScyzorykProjektowy";
        var nodeExePath = @"C:\ScyzorykProjektowy\node-runtime\node.exe";

        var startInfo = ProcessManager.BuildServerStartInfo(installDir, nodeExePath);

        Assert.Equal("0", startInfo.EnvironmentVariables["PLAYWRIGHT_BROWSERS_PATH"]);
        Assert.StartsWith(@"C:\ScyzorykProjektowy\node-runtime", startInfo.EnvironmentVariables["PATH"]);
    }
}
