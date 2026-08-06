using System.Diagnostics;
using System.Security;
using System.Security.Principal;
using System.Text;

namespace Scyzoryk.Launcher;

public sealed record AutostartResult(bool Success, string? ErrorMessage)
{
    public static AutostartResult Ok() => new(true, null);
    public static AutostartResult Failed(string errorMessage) => new(false, errorMessage);
}

public interface IAutostartManager
{
    /// <summary>Rejestruje w Harmonogramie Zadan Windows uruchomienie podanego
    /// pliku wykonywalnego z argumentem --autostart przy logowaniu biezacego
    /// uzytkownika, bez podnoszenia uprawnien (RunLevel LeastPrivilege).</summary>
    AutostartResult Register(string exePath);

    /// <summary>Usuwa zadanie zarejestrowane przez Register. Brak istniejacego
    /// zadania NIE jest bledem.</summary>
    AutostartResult Unregister();
}

/// <summary>
/// Audyt 2026-08-06 + realny incydent: instalator (installer\scyzoryk.iss)
/// rejestrowal/wyrejestrowywal autostart przez ukryty
/// "powershell.exe -ExecutionPolicy Bypass -File ...ps1" (Flags: runhidden) -
/// dokladnie ta sama sygnatura "interpreter cicho odpala interpreter z
/// ominieciem polityki wykonania", ktora byla juz raz zlapana przez firmowy
/// EDR w lancuchu aktualizacji (patrz LauncherApp.RunApplyUpdateAsync) i ktora
/// jest znanym, czestym powodem falszywych alarmow "wirus" dla niepodpisanych,
/// nowych plikow w Google Safe Browsing/Windows Defenderze/wiekszosci AV -
/// potwierdzone realnie: pobranie instalatora bylo flagowane na czesci
/// komputerow. Ta klasa zastepuje oba skrypty PS wywolaniem natywnego,
/// podpisanego przez Microsoft schtasks.exe bezposrednio z Scyzoryk.exe, bez
/// jakiegokolwiek posrednika/powloki - installer\scyzoryk.iss woła teraz
/// "{app}\Scyzoryk.exe --register-autostart" / "--unregister-autostart".
/// scripts\install-autostart.ps1/uninstall-autostart.ps1 zostaja jako
/// niezalezne, recznie uruchamiane narzedzia deweloperskie/naprawcze - nie sa
/// juz czescia sciezki instalatora.
/// </summary>
public sealed class AutostartManager : IAutostartManager
{
    public const string TaskName = "Scyzoryk Projektowy - autostart";

    /// <summary>
    /// Buduje definicje zadania w formacie XML Harmonogramu Zadan - to samo,
    /// co robil "Register-ScheduledTask -Trigger (New-ScheduledTaskTrigger
    /// -AtLogOn -User ...) -Principal (... -RunLevel Limited) -Settings
    /// (-AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable)"
    /// w starym skrypcie PS, ale bez potrzeby PowerShella do wykonania - tylko
    /// do WYGENEROWANIA pliku XML, ktory nastepnie czyta natywny schtasks.exe.
    /// Wydzielona jako czysta funkcja, zeby dalo sie ja przetestowac bez
    /// realnego Harmonogramu Zadan.
    /// </summary>
    public static string BuildTaskDefinitionXml(string exePath, string userId)
    {
        var escapedExePath = SecurityElement.Escape(exePath) ?? exePath;
        var escapedUserId = SecurityElement.Escape(userId) ?? userId;

        return
            "<?xml version=\"1.0\" encoding=\"UTF-16\"?>\r\n" +
            "<Task version=\"1.2\" xmlns=\"http://schemas.microsoft.com/windows/2004/02/mit/task\">\r\n" +
            "  <Triggers>\r\n" +
            "    <LogonTrigger>\r\n" +
            "      <Enabled>true</Enabled>\r\n" +
            $"      <UserId>{escapedUserId}</UserId>\r\n" +
            "    </LogonTrigger>\r\n" +
            "  </Triggers>\r\n" +
            "  <Principals>\r\n" +
            "    <Principal id=\"Author\">\r\n" +
            $"      <UserId>{escapedUserId}</UserId>\r\n" +
            "      <LogonType>InteractiveToken</LogonType>\r\n" +
            "      <RunLevel>LeastPrivilege</RunLevel>\r\n" +
            "    </Principal>\r\n" +
            "  </Principals>\r\n" +
            "  <Settings>\r\n" +
            "    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>\r\n" +
            "    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>\r\n" +
            "    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>\r\n" +
            "    <StartWhenAvailable>true</StartWhenAvailable>\r\n" +
            "    <Enabled>true</Enabled>\r\n" +
            "  </Settings>\r\n" +
            "  <Actions Context=\"Author\">\r\n" +
            "    <Exec>\r\n" +
            $"      <Command>{escapedExePath}</Command>\r\n" +
            "      <Arguments>--autostart</Arguments>\r\n" +
            "    </Exec>\r\n" +
            "  </Actions>\r\n" +
            "</Task>\r\n";
    }

    /// <summary>
    /// Pelna tozsamosc DOMENA\Uzytkownik (albo KOMPUTER\Uzytkownik lokalnie)
    /// zamiast samego Environment.UserName - audyt rozdz. 19, P2: sam login
    /// moze sie zderzyc z kontem domenowym o tej samej nazwie co lokalne.
    /// </summary>
    public static string CurrentUserId()
    {
        try
        {
            var name = WindowsIdentity.GetCurrent().Name;
            return string.IsNullOrWhiteSpace(name) ? Environment.UserName : name;
        }
        catch
        {
            return Environment.UserName;
        }
    }

    public AutostartResult Register(string exePath)
    {
        var xmlPath = Path.Combine(Path.GetTempPath(), $"scyzoryk-autostart-{Guid.NewGuid():N}.xml");
        try
        {
            var xml = BuildTaskDefinitionXml(exePath, CurrentUserId());
            // Harmonogram Zadan oczekuje UTF-16 z BOM dla plikow XML zadan.
            File.WriteAllText(xmlPath, xml, new UnicodeEncoding(bigEndian: false, byteOrderMark: true));

            return RunSchtasks("/Create", "/TN", TaskName, "/XML", xmlPath, "/F");
        }
        catch (Exception ex)
        {
            return AutostartResult.Failed(ex.Message);
        }
        finally
        {
            try { File.Delete(xmlPath); } catch { /* najwyzej zostanie plik w TEMP - nie krytyczne */ }
        }
    }

    public AutostartResult Unregister()
    {
        // Zlapane realnie na polskim Windows: schtasks.exe zwraca komunikat
        // bledu ZLOKALIZOWANY (i do tego czasem zle zdekodowany w konsoli -
        // rozna strona kodowa OEM vs UTF-8), wiec dopasowywanie tresci bledu
        // (np. angielskiego "cannot find") jest kruche i realnie zawodzi.
        // Zamiast tego najpierw pytamy /Query, czy zadanie w ogole istnieje -
        // brak zadania nie jest bledem dla Unregister (to samo zachowanie co
        // "if (Get-ScheduledTask ...) { Unregister-ScheduledTask ... }" w
        // starym skrypcie PS), bez zgadywania po tekscie.
        var query = RunSchtasks("/Query", "/TN", TaskName);
        if (!query.Success)
        {
            return AutostartResult.Ok();
        }

        return RunSchtasks("/Delete", "/TN", TaskName, "/F");
    }

    private static AutostartResult RunSchtasks(params string[] arguments)
    {
        var systemDir = Environment.GetFolderPath(Environment.SpecialFolder.System);
        var startInfo = new ProcessStartInfo
        {
            FileName = Path.Combine(systemDir, "schtasks.exe"),
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        foreach (var arg in arguments) startInfo.ArgumentList.Add(arg);

        try
        {
            using var process = Process.Start(startInfo);
            if (process is null) return AutostartResult.Failed("Process.Start dla schtasks.exe zwrocil null.");

            var stderr = process.StandardError.ReadToEnd();
            var stdout = process.StandardOutput.ReadToEnd();
            process.WaitForExit();

            if (process.ExitCode == 0) return AutostartResult.Ok();

            var message = string.IsNullOrWhiteSpace(stderr) ? stdout : stderr;
            return AutostartResult.Failed(string.IsNullOrWhiteSpace(message)
                ? $"schtasks.exe zakonczyl sie kodem {process.ExitCode}."
                : message.Trim());
        }
        catch (Exception ex)
        {
            return AutostartResult.Failed(ex.Message);
        }
    }
}
