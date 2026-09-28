using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;

namespace Scyzoryk.DocumentEngine.Merge;

// Wierne odpowiedniki funkcji z apps/dokumenty-seryjne/scripts/mailmerge-to-pdf.ps1
// (Normalize-Name, Normalize-Address, Get-RecordValue, Safe-FileName,
// Join-PrefixAndAddress, Unique-Path, Get-NaturalSortKey). Dopasowanie kolumn
// Excela do pol dokumentu MUSI dzialac identycznie jak w starej sciezce Word COM,
// bo od tego zalezy, czy te same szablony klientow wypelniaja sie tak samo -
// kazda zmiana tutaj to zmiana zachowania na zywych dokumentach.
public static class TextNormalize
{
    private static readonly Regex NonAlnumUnderscore = new("[^a-z0-9]+", RegexOptions.Compiled);
    private static readonly Regex Whitespace = new(@"\s+", RegexOptions.Compiled);

    // Normalize-Name: bez diakrytykow, lower, wszystko poza [a-z0-9] -> "_",
    // obciete "_" z brzegow. "l" (U+0142) zamieniane recznie PRZED FormD, bo nie
    // rozklada sie na litere + znak laczacy jak pozostale polskie litery.
    public static string NormalizeName(string? text)
    {
        if (text is null) return "";
        var s = StripDiacritics(text).ToLowerInvariant();
        s = NonAlnumUnderscore.Replace(s, "_");
        return s.Trim('_');
    }

    // Normalize-Address: jak wyzej, ale separatorem jest spacja (uzywane do
    // dopasowania folderu zdjec do adresu i do nazwy pola galerii).
    public static string NormalizeAddress(string? text)
    {
        if (text is null) return "";
        var s = StripDiacritics(text).ToLowerInvariant();
        s = NonAlnumUnderscore.Replace(s, " ");
        return s.Trim();
    }

    public static string StripDiacritics(string text)
    {
        var s = text.Replace('ł', 'l').Replace('Ł', 'L');
        try
        {
            s = s.Normalize(NormalizationForm.FormD);
            var sb = new StringBuilder(s.Length);
            foreach (var ch in s)
            {
                if (CharUnicodeInfo.GetUnicodeCategory(ch) != UnicodeCategory.NonSpacingMark) sb.Append(ch);
            }
            return sb.ToString();
        }
        catch
        {
            // Ten sam "catch {}" co w PowerShell - w najgorszym razie porownanie
            // idzie po tekscie z diakrytykami, nie przerywamy generowania.
            return s;
        }
    }

    // Get-RecordValue: 1) dokladna nazwa, 2) nazwa po NormalizeName,
    // 3) najdluzszy wspolny prefiks (Word obcina nazwy pol MERGEFIELD do ~40
    // znakow, wiec "Moc zestawu uwzgledniajaca moc..." z Excela musi trafic
    // w obcieta nazwe pola).
    public static string GetRecordValue(IReadOnlyList<KeyValuePair<string, string>> record, string? fieldName)
    {
        if (record is null || string.IsNullOrWhiteSpace(fieldName)) return "";

        foreach (var p in record)
        {
            if (p.Key == fieldName) return p.Value;
        }

        var fieldNorm = NormalizeName(fieldName);
        foreach (var p in record)
        {
            if (NormalizeName(p.Key) == fieldNorm) return p.Value;
        }

        string? best = null;
        var bestLen = 0;
        foreach (var p in record)
        {
            var colNorm = NormalizeName(p.Key);
            if (string.IsNullOrWhiteSpace(colNorm)) continue;
            if (colNorm.StartsWith(fieldNorm, StringComparison.Ordinal) || fieldNorm.StartsWith(colNorm, StringComparison.Ordinal))
            {
                var score = Math.Min(colNorm.Length, fieldNorm.Length);
                if (score > bestLen) { best = p.Value; bestLen = score; }
            }
        }
        return best ?? "";
    }

    public static string SafeFileName(string? name)
    {
        if (string.IsNullOrWhiteSpace(name)) name = "bez_adresu";
        foreach (var ch in Path.GetInvalidFileNameChars().Concat(WindowsInvalidFileNameChars))
        {
            name = name.Replace(ch.ToString(), "_");
        }
        name = Whitespace.Replace(name, " ").Trim();
        name = name.Trim('.', ' ');
        if (name.Length > 120) name = name[..120].Trim();
        if (string.IsNullOrWhiteSpace(name)) name = "bez_adresu";
        return name;
    }

    // Na Windows Path.GetInvalidFileNameChars() juz je zawiera; dopisane jawnie,
    // zeby testy uruchamiane gdziekolwiek dawaly te same nazwy plikow co
    // produkcja (PowerShell zawsze dzialal na Windows).
    private static readonly char[] WindowsInvalidFileNameChars = { '"', '<', '>', '|', ':', '*', '?', '\\', '/' };

    public static string JoinPrefixAndAddress(string? prefix, string? address)
    {
        var p = prefix ?? "";
        var a = address ?? "";
        if (string.IsNullOrWhiteSpace(p)) return a;
        p = Whitespace.Replace(p, " ").Trim();
        if (string.IsNullOrWhiteSpace(p)) return a;
        if (p.EndsWith('_')) return (p + a).Trim();
        if (p.EndsWith('-') || p.EndsWith('.')) return (p + " " + a).Trim();
        return (p + " - " + a).Trim();
    }

    public static string UniquePath(string dir, string baseName, string ext)
    {
        var candidate = Path.Combine(dir, baseName + ext);
        var i = 2;
        while (File.Exists(candidate))
        {
            candidate = Path.Combine(dir, baseName + "_" + i + ext);
            i++;
        }
        return candidate;
    }

    // Get-NaturalSortKey: cyfry padowane do 8 znakow.
    public static string NaturalSortKey(string? name)
    {
        var lower = (name ?? "").ToLowerInvariant();
        return Regex.Replace(lower, @"\d+", m => m.Value.PadLeft(8, '0'));
    }
}
