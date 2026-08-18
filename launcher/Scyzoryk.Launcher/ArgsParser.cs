namespace Scyzoryk.Launcher;

/// <summary>
/// Wynik parsowania - dla wiekszosci trybow InstallerPath/ExpectedVersion/
/// RealInstallDir sa puste (nieuzywane). Wypelnione wylacznie dla ApplyUpdate.
/// </summary>
public sealed record ParsedArgs(LauncherMode Mode, string? InstallerPath = null, string? ExpectedVersion = null, string? RealInstallDir = null, string? ParentPid = null, string? ResidentTrayPid = null);

/// <summary>
/// Parsuje argumenty wiersza polecen. Kazdy argument jest analizowany jako
/// dokladny, rozroznialny wielkosc liter tekst albo (dla --apply-update) jako
/// zwykly string uzywany pozniej wylacznie w ProcessStartInfo.ArgumentList /
/// porownaniach napisow - nigdy nie jest przekazywany dalej do zadnego
/// procesu/shella jako fragment sklejanej komendy (zero ryzyka wykonania
/// dowolnej komendy z argumentu uzytkownika).
/// </summary>
public static class ArgsParser
{
    public static ParsedArgs Parse(string[] args)
    {
        if (args.Length == 0) return new ParsedArgs(LauncherMode.Normal);

        switch (args[0])
        {
            case "--autostart": return new ParsedArgs(LauncherMode.Autostart);
            case "--stop": return new ParsedArgs(LauncherMode.Stop);
            case "--health": return new ParsedArgs(LauncherMode.Health);
            case "--register-autostart": return new ParsedArgs(LauncherMode.RegisterAutostart);
            case "--unregister-autostart": return new ParsedArgs(LauncherMode.UnregisterAutostart);
            case "--apply-update":
                // Wymaga dokladnie trzech dodatkowych argumentow (sciezka
                // instalatora, oczekiwana wersja, PRAWDZIWY katalog instalacji)
                // - bez ktoregokolwiek z nich, ten sam bezpieczny fail-safe co
                // dla jakiegokolwiek innego nierozpoznanego wywolania.
                //
                // Incydent na zywo (2026-08-06): ten proces to KOPIA Scyzoryk.exe
                // uruchomiona z katalogu aktualizacji (patrz LauncherApp.cs#
                // ApplyPendingUpdateIfAnyAsync, ktora go spawnuje przy zimnym
                // starcie na podstawie Updates\pending-update.json), wiec
                // InstallPaths.FromBaseDirectory() dla NIEGO wskazywalby na zly
                // katalog - node.exe nigdy nie zostawal zatrzymany (StopOwnedProcesses
                // szukal go pod zla sciezka), a restart probowal odpalic
                // nieistniejacy plik. Prawdziwy katalog instalacji trzeba dostac
                // jawnie, nie da sie go wywnioskowac z wlasnego polozenia.
                if (args.Length >= 4
                    && !string.IsNullOrWhiteSpace(args[1])
                    && !string.IsNullOrWhiteSpace(args[2])
                    && !string.IsNullOrWhiteSpace(args[3]))
                {
                    // 5. argument (PID procesu-nadzorcy, ktory spawnuje ta aktualizacje) jest
                    // OPCJONALNY - wstecznie kompatybilne ze starszymi wywolaniami bez niego.
                    // Patrz KillProcessById w ProcessManager.cs po co jest uzywany.
                    var parentPid = args.Length >= 5 && !string.IsNullOrWhiteSpace(args[4]) ? args[4] : null;
                    // 6. argument (PID rezydentnej ikony w zasobniku, odczytany przez
                    // lib/updateService.js z InstallPaths.ResidentTrayPidFilePath) jest
                    // rowniez OPCJONALNY z tego samego powodu - patrz
                    // UpdateApplier.EnsureResidentTrayStopped, audyt 2026-08-17.
                    var residentTrayPid = args.Length >= 6 && !string.IsNullOrWhiteSpace(args[5]) ? args[5] : null;
                    return new ParsedArgs(LauncherMode.ApplyUpdate, args[1], args[2], args[3], parentPid, residentTrayPid);
                }
                return new ParsedArgs(LauncherMode.Unknown);
            default:
                return new ParsedArgs(LauncherMode.Unknown);
        }
    }
}
