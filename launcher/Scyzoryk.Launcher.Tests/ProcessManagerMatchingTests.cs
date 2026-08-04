using Xunit;

namespace Scyzoryk.Launcher.Tests;

public sealed class ProcessManagerMatchingTests
{
    [Fact]
    public void SameFullPath_CaseInsensitive_Matches()
    {
        var expected = @"C:\ScyzorykProjektowy\node-runtime\node.exe";
        var actual = @"C:\SCYZORYKPROJEKTOWY\NODE-RUNTIME\NODE.EXE";

        Assert.True(ProcessManager.IsOwnedNodeProcess(actual, expected));
    }

    [Fact]
    public void DifferentPath_DoesNotMatch()
    {
        var expected = @"C:\ScyzorykProjektowy\node-runtime\node.exe";
        var actual = @"C:\Program Files\nodejs\node.exe";

        Assert.False(ProcessManager.IsOwnedNodeProcess(actual, expected));
    }

    [Fact]
    public void RelativeVsAbsolutePath_NormalizedBeforeCompare()
    {
        var baseDir = Path.Combine(Path.GetTempPath(), "scyzoryk-matching-test");
        Directory.CreateDirectory(baseDir);
        try
        {
            var expected = Path.Combine(baseDir, "node-runtime", "node.exe");
            var actualRelative = Path.Combine(baseDir, "node-runtime", "..", "node-runtime", "node.exe");

            Assert.True(ProcessManager.IsOwnedNodeProcess(actualRelative, expected));
        }
        finally
        {
            Directory.Delete(baseDir, recursive: true);
        }
    }

    [Fact]
    public void EmptyExpectedPath_NeverMatches()
    {
        Assert.False(ProcessManager.IsOwnedNodeProcess(@"C:\node-runtime\node.exe", string.Empty));
    }
}
