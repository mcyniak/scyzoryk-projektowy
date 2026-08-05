namespace Scyzoryk.Launcher;

/// <summary>
/// Wynik parsowania - dla wiekszosci trybow InstallerPath/ExpectedVersion sa
/// puste (nieuzywane). Wypelnione wylacznie dla ApplyUpdate.
/// </summary>
public sealed record ParsedArgs(LauncherMode Mode, string? InstallerPath = null, string? ExpectedVersion = null);

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
            case "--apply-update":
                // Wymaga dokladnie dwoch dodatkowych argumentow (sciezka
                // instalatora, oczekiwana wersja) - bez nich albo z pustym
                // ktorymkolwiek z nich, ten sam bezpieczny fail-safe co dla
                // jakiegokolwiek innego nierozpoznanego wywolania.
                if (args.Length >= 3 && !string.IsNullOrWhiteSpace(args[1]) && !string.IsNullOrWhiteSpace(args[2]))
                {
                    return new ParsedArgs(LauncherMode.ApplyUpdate, args[1], args[2]);
                }
                return new ParsedArgs(LauncherMode.Unknown);
            default:
                return new ParsedArgs(LauncherMode.Unknown);
        }
    }
}
