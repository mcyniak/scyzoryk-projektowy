using Xunit;

namespace Scyzoryk.Launcher.Tests;

public sealed class AutostartManagerTests
{
    [Fact]
    public void BuildTaskDefinitionXml_ContainsExpectedActionAndArguments()
    {
        var xml = AutostartManager.BuildTaskDefinitionXml(@"C:\fake\Scyzoryk.exe", @"KOMPUTER\uzytkownik");

        Assert.Contains(@"<Command>C:\fake\Scyzoryk.exe</Command>", xml);
        Assert.Contains("<Arguments>--autostart</Arguments>", xml);
        Assert.Contains(@"<UserId>KOMPUTER\uzytkownik</UserId>", xml);
    }

    [Fact]
    public void BuildTaskDefinitionXml_NeverStartsElevated()
    {
        // RunLevel LeastPrivilege = odpowiednik "-RunLevel Limited" ze starego
        // skryptu PS - autostart NIGDY nie moze podnosic uprawnien.
        var xml = AutostartManager.BuildTaskDefinitionXml(@"C:\fake\Scyzoryk.exe", "uzytkownik");

        Assert.Contains("<RunLevel>LeastPrivilege</RunLevel>", xml);
        Assert.DoesNotContain("HighestAvailable", xml);
    }

    [Fact]
    public void BuildTaskDefinitionXml_AllowsRunningOnBatteryAndWhenMissed()
    {
        // Odpowiednik "-AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
        // -StartWhenAvailable" ze starego skryptu PS - lekki, lokalny serwer
        // nie powinien zalezec od zasilania sieciowego.
        var xml = AutostartManager.BuildTaskDefinitionXml(@"C:\fake\Scyzoryk.exe", "uzytkownik");

        Assert.Contains("<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>", xml);
        Assert.Contains("<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>", xml);
        Assert.Contains("<StartWhenAvailable>true</StartWhenAvailable>", xml);
    }

    [Fact]
    public void BuildTaskDefinitionXml_EscapesSpecialCharactersInPaths()
    {
        // Sciezka z "&" nie moze zlamac struktury XML - musi zostac
        // zescapowana do encji "&amp;", nigdy wstawiona surowo.
        var xml = AutostartManager.BuildTaskDefinitionXml(@"C:\Program & Files\Scyzoryk.exe", "uzytkownik");

        Assert.Contains(@"<Command>C:\Program &amp; Files\Scyzoryk.exe</Command>", xml);
    }

    [Fact]
    public void TaskName_MatchesNameUsedByInstallerAndOldPowerShellScript()
    {
        // Musi zostac dokladnie ta sama nazwa, ktorej uzywal
        // scripts\install-autostart.ps1/uninstall-autostart.ps1 i ktorej
        // szuka scripts\ci\test-installed-scyzoryk.ps1 - inaczej stary,
        // osierocony wpis w Harmonogramie nigdy nie zostanie zastapiony/usuniety.
        Assert.Equal("Scyzoryk Projektowy - autostart", AutostartManager.TaskName);
    }
}
