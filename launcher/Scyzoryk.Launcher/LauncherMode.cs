namespace Scyzoryk.Launcher;

/// <summary>
/// "Dokladnie te 5 trybow" z pierwotnej specyfikacji zostalo rozszerzone
/// 2026-08-06 o RegisterAutostart/UnregisterAutostart - zastepuja ukryte
/// wywolania powershell.exe -ExecutionPolicy Bypass w instalatorze (patrz
/// AutostartManager), ktore byly realnym powodem flagowania pobranego
/// instalatora jako wirus przez Chrome/AV na czesci komputerow. "Unknown"
/// nadal jest bezpiecznym fail-safe: brak jakichkolwiek efektow (bez spawnu,
/// bez przegladarki, bez muteksu, bez zmian w Harmonogramie Zadan), nigdy
/// traktowany jak Normal.
/// </summary>
public enum LauncherMode
{
    Normal,
    Autostart,
    Stop,
    Health,
    ApplyUpdate,
    RegisterAutostart,
    UnregisterAutostart,
    Unknown,
}
