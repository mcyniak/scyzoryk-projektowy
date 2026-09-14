namespace Scyzoryk.DocumentEngine.OpenXml;

// Te same tabele co lib/wordSmartTemplate.ps1#ScyzorykHighlightMap /
// ScyzorykOoxmlHighlightToKey (audyt "0 kandydatow" 2026-09-10) - trzymane
// jako jedno zrodlo prawdy koncepcyjnie, tu przepisane 1:1 do C#, bo migracja
// na Open XML usuwa potrzebe posrednictwa przez WdColorIndex (Word COM) -
// OOXML w:highlight w:val="..." JEST juz nasza nazwa koloru, tylko wciaz z
// tym samym niejednoznacznym mapowaniem "green"/"darkGreen" -> jeden wpis
// palety, ktore Word sam stosuje przy zapisie/odczycie.
public static class ColorMaps
{
    public sealed record HighlightInfo(string Key, string Hex);

    // Klucz wewnetrzny -> hex do wyswietlenia w UI (ten sam zestaw 16 kolorow
    // co WdColorIndex, bo to jest to, co Word rzeczywiscie umie zapisac jako
    // w:highlight).
    public static readonly IReadOnlyDictionary<string, string> HighlightKeyToHex = new Dictionary<string, string>
    {
        ["black"] = "#000000",
        ["blue"] = "#0000FF",
        ["cyan"] = "#00FFFF",
        ["brightgreen"] = "#00FF00",
        ["pink"] = "#FF00FF",
        ["red"] = "#FF0000",
        ["yellow"] = "#FFFF00",
        ["white"] = "#FFFFFF",
        ["darkblue"] = "#00008B",
        ["teal"] = "#008080",
        ["green"] = "#008000",
        ["violet"] = "#800080",
        ["darkred"] = "#8B0000",
        ["darkyellow"] = "#808000",
        ["gray50"] = "#808080",
        ["gray25"] = "#C0C0C0",
    };

    // OOXML w:highlight w:val="..." -> klucz wewnetrzny. Word zapisuje
    // "darkGreen" dla ciemnej zieleni ("green" w naszej palecie) i "green" dla
    // jasnej zieleni ("brightgreen") - to samo niejednoznaczne mapowanie, co
    // wczesniej trzeba bylo obchodzic przez WdColorIndex w Word COM.
    public static readonly IReadOnlyDictionary<string, string> OoxmlHighlightToKey = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
    {
        ["black"] = "black",
        ["blue"] = "blue",
        ["cyan"] = "cyan",
        ["darkBlue"] = "darkblue",
        ["darkCyan"] = "teal",
        ["darkGray"] = "gray50",
        ["darkGreen"] = "green",
        ["darkMagenta"] = "violet",
        ["darkRed"] = "darkred",
        ["darkYellow"] = "darkyellow",
        ["green"] = "brightgreen",
        ["lightGray"] = "gray25",
        ["magenta"] = "pink",
        ["red"] = "red",
        ["white"] = "white",
        ["yellow"] = "yellow",
    };

    public static string? ConvertOoxmlHighlightToKey(string? ooxmlValue)
    {
        if (string.IsNullOrEmpty(ooxmlValue)) return null;
        return OoxmlHighlightToKey.TryGetValue(ooxmlValue, out var key) ? key : null;
    }

    // Shading fill "none"/"auto"/bialy = brak widocznego oznaczenia (tlo
    // domyslne), nie jest to robocze oznaczenie - ten sam wyjatek co paleta
    // XML w scan-template.ps1 (Get-MarkingPaletteFromXml).
    public static bool IsVisibleShadingFill(string? fill)
    {
        if (string.IsNullOrEmpty(fill)) return false;
        if (string.Equals(fill, "auto", StringComparison.OrdinalIgnoreCase)) return false;
        if (string.Equals(fill, "FFFFFF", StringComparison.OrdinalIgnoreCase)) return false;
        return true;
    }
}
