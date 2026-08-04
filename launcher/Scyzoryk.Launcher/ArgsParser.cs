namespace Scyzoryk.Launcher;

/// <summary>
/// Parsuje argumenty wiersza polecen. Analizowany jest WYLACZNIE args[0], jako
/// dokladny, rozroznialny wielkosc liter tekst - nigdy nie jest przekazywany
/// dalej do jakiegokolwiek procesu/shella (zero ryzyka wykonania dowolnej
/// komendy z argumentu uzytkownika).
/// </summary>
public static class ArgsParser
{
    public static LauncherMode Parse(string[] args)
    {
        if (args.Length == 0) return LauncherMode.Normal;

        return args[0] switch
        {
            "--autostart" => LauncherMode.Autostart,
            "--stop" => LauncherMode.Stop,
            "--health" => LauncherMode.Health,
            _ => LauncherMode.Unknown,
        };
    }
}
