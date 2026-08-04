using Xunit;

namespace Scyzoryk.Launcher.Tests;

public sealed class ArgsParserTests
{
    [Fact]
    public void NoArgs_Normal()
    {
        Assert.Equal(LauncherMode.Normal, ArgsParser.Parse(Array.Empty<string>()));
    }

    [Fact]
    public void DashDashAutostart_Autostart()
    {
        Assert.Equal(LauncherMode.Autostart, ArgsParser.Parse(new[] { "--autostart" }));
    }

    [Fact]
    public void DashDashStop_Stop()
    {
        Assert.Equal(LauncherMode.Stop, ArgsParser.Parse(new[] { "--stop" }));
    }

    [Fact]
    public void DashDashHealth_Health()
    {
        Assert.Equal(LauncherMode.Health, ArgsParser.Parse(new[] { "--health" }));
    }

    [Fact]
    public void UnknownFlag_Unknown()
    {
        Assert.Equal(LauncherMode.Unknown, ArgsParser.Parse(new[] { "--totally-made-up" }));
    }

    [Fact]
    public void RecognizedFlag_WithTrailingGarbage_StillRecognized()
    {
        // Tylko args[0] jest analizowany - dodatkowe, niespodziewane argumenty za
        // rozpoznana flaga nie zmieniaja trybu (i nigdy nie sa przekazywane dalej
        // do jakiegokolwiek procesu/powloki).
        Assert.Equal(LauncherMode.Autostart, ArgsParser.Parse(new[] { "--autostart", "cokolwiek", "innego" }));
    }

    [Fact]
    public void CaseSensitive_DifferentCasingIsUnknown()
    {
        Assert.Equal(LauncherMode.Unknown, ArgsParser.Parse(new[] { "--Autostart" }));
    }
}
