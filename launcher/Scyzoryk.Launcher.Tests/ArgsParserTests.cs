using Xunit;

namespace Scyzoryk.Launcher.Tests;

public sealed class ArgsParserTests
{
    [Fact]
    public void NoArgs_Normal()
    {
        Assert.Equal(LauncherMode.Normal, ArgsParser.Parse(Array.Empty<string>()).Mode);
    }

    [Fact]
    public void DashDashAutostart_Autostart()
    {
        Assert.Equal(LauncherMode.Autostart, ArgsParser.Parse(new[] { "--autostart" }).Mode);
    }

    [Fact]
    public void DashDashStop_Stop()
    {
        Assert.Equal(LauncherMode.Stop, ArgsParser.Parse(new[] { "--stop" }).Mode);
    }

    [Fact]
    public void DashDashHealth_Health()
    {
        Assert.Equal(LauncherMode.Health, ArgsParser.Parse(new[] { "--health" }).Mode);
    }

    [Fact]
    public void DashDashRegisterAutostart_RegisterAutostart()
    {
        Assert.Equal(LauncherMode.RegisterAutostart, ArgsParser.Parse(new[] { "--register-autostart" }).Mode);
    }

    [Fact]
    public void DashDashUnregisterAutostart_UnregisterAutostart()
    {
        Assert.Equal(LauncherMode.UnregisterAutostart, ArgsParser.Parse(new[] { "--unregister-autostart" }).Mode);
    }

    [Fact]
    public void UnknownFlag_Unknown()
    {
        Assert.Equal(LauncherMode.Unknown, ArgsParser.Parse(new[] { "--totally-made-up" }).Mode);
    }

    [Fact]
    public void RecognizedFlag_WithTrailingGarbage_StillRecognized()
    {
        // Tylko args[0] jest analizowany dla trybow bez wlasnych argumentow -
        // dodatkowe, niespodziewane argumenty za rozpoznana flaga nie zmieniaja
        // trybu (i nigdy nie sa przekazywane dalej do jakiegokolwiek procesu/powloki).
        Assert.Equal(LauncherMode.Autostart, ArgsParser.Parse(new[] { "--autostart", "cokolwiek", "innego" }).Mode);
    }

    [Fact]
    public void CaseSensitive_DifferentCasingIsUnknown()
    {
        Assert.Equal(LauncherMode.Unknown, ArgsParser.Parse(new[] { "--Autostart" }).Mode);
    }

    [Fact]
    public void ApplyUpdate_WithInstallerPathAndVersion_Recognized()
    {
        var parsed = ArgsParser.Parse(new[] { "--apply-update", "C:\\fake\\Setup-1.2.3.exe", "1.2.3" });

        Assert.Equal(LauncherMode.ApplyUpdate, parsed.Mode);
        Assert.Equal("C:\\fake\\Setup-1.2.3.exe", parsed.InstallerPath);
        Assert.Equal("1.2.3", parsed.ExpectedVersion);
    }

    [Fact]
    public void ApplyUpdate_MissingArguments_Unknown()
    {
        Assert.Equal(LauncherMode.Unknown, ArgsParser.Parse(new[] { "--apply-update" }).Mode);
        Assert.Equal(LauncherMode.Unknown, ArgsParser.Parse(new[] { "--apply-update", "C:\\fake\\Setup-1.2.3.exe" }).Mode);
    }

    [Fact]
    public void ApplyUpdate_BlankArguments_Unknown()
    {
        Assert.Equal(LauncherMode.Unknown, ArgsParser.Parse(new[] { "--apply-update", "  ", "1.2.3" }).Mode);
        Assert.Equal(LauncherMode.Unknown, ArgsParser.Parse(new[] { "--apply-update", "C:\\fake\\Setup-1.2.3.exe", "  " }).Mode);
    }
}
