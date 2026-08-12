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
    public void ApplyUpdate_WithInstallerPathVersionAndInstallDir_Recognized()
    {
        var parsed = ArgsParser.Parse(new[] { "--apply-update", "C:\\fake\\Setup-1.2.3.exe", "1.2.3", "C:\\fake\\install" });

        Assert.Equal(LauncherMode.ApplyUpdate, parsed.Mode);
        Assert.Equal("C:\\fake\\Setup-1.2.3.exe", parsed.InstallerPath);
        Assert.Equal("1.2.3", parsed.ExpectedVersion);
        Assert.Equal("C:\\fake\\install", parsed.RealInstallDir);
    }

    [Fact]
    public void ApplyUpdate_MissingArguments_Unknown()
    {
        // Incydent na zywo (2026-08-06): trzeci argument (prawdziwy katalog
        // instalacji) jest TERAZ wymagany - bez niego --apply-update wracal do
        // liczenia InstallDir z wlasnego (zlego dla tej kopii) polozenia.
        Assert.Equal(LauncherMode.Unknown, ArgsParser.Parse(new[] { "--apply-update" }).Mode);
        Assert.Equal(LauncherMode.Unknown, ArgsParser.Parse(new[] { "--apply-update", "C:\\fake\\Setup-1.2.3.exe" }).Mode);
        Assert.Equal(LauncherMode.Unknown, ArgsParser.Parse(new[] { "--apply-update", "C:\\fake\\Setup-1.2.3.exe", "1.2.3" }).Mode);
    }

    [Fact]
    public void ApplyUpdate_BlankArguments_Unknown()
    {
        Assert.Equal(LauncherMode.Unknown, ArgsParser.Parse(new[] { "--apply-update", "  ", "1.2.3", "C:\\fake\\install" }).Mode);
        Assert.Equal(LauncherMode.Unknown, ArgsParser.Parse(new[] { "--apply-update", "C:\\fake\\Setup-1.2.3.exe", "  ", "C:\\fake\\install" }).Mode);
        Assert.Equal(LauncherMode.Unknown, ArgsParser.Parse(new[] { "--apply-update", "C:\\fake\\Setup-1.2.3.exe", "1.2.3", "  " }).Mode);
    }

    // Audyt 2026-08-12: 5. argument (PID procesu-nadzorcy, ktory spawnuje ta
    // aktualizacje - patrz lib/updateService.js) jest OPCJONALNY, zeby wywolanie
    // bez niego (np. stary, jeszcze nie zaktualizowany Scyzoryk.exe wykonujacy
    // pierwsza aktualizacje po tej poprawce) dalej dzialalo bez zmian.
    [Fact]
    public void ApplyUpdate_WithParentPid_Recognized()
    {
        var parsed = ArgsParser.Parse(new[] { "--apply-update", "C:\\fake\\Setup-1.2.3.exe", "1.2.3", "C:\\fake\\install", "4242" });

        Assert.Equal(LauncherMode.ApplyUpdate, parsed.Mode);
        Assert.Equal("4242", parsed.ParentPid);
    }

    [Fact]
    public void ApplyUpdate_WithoutParentPid_BackwardCompatible_NullParentPid()
    {
        var parsed = ArgsParser.Parse(new[] { "--apply-update", "C:\\fake\\Setup-1.2.3.exe", "1.2.3", "C:\\fake\\install" });

        Assert.Equal(LauncherMode.ApplyUpdate, parsed.Mode);
        Assert.Null(parsed.ParentPid);
    }

    [Fact]
    public void ApplyUpdate_BlankParentPid_TreatedAsNull()
    {
        var parsed = ArgsParser.Parse(new[] { "--apply-update", "C:\\fake\\Setup-1.2.3.exe", "1.2.3", "C:\\fake\\install", "  " });

        Assert.Equal(LauncherMode.ApplyUpdate, parsed.Mode);
        Assert.Null(parsed.ParentPid);
    }
}
