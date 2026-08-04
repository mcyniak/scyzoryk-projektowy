namespace Scyzoryk.Launcher;

/// <summary>
/// Dokladnie te 4 tryby wymagane w specyfikacji - zadnych dodatkowych. "Unknown"
/// jest bezpiecznym fail-safe: brak jakichkolwiek efektow (bez spawnu, bez
/// przegladarki, bez muteksu), nigdy nie traktowany jak Normal.
/// </summary>
public enum LauncherMode
{
    Normal,
    Autostart,
    Stop,
    Health,
    Unknown,
}
