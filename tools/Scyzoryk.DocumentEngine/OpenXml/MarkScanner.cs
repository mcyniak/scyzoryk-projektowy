using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using DocumentFormat.OpenXml;
using DocumentFormat.OpenXml.Packaging;
using DocumentFormat.OpenXml.Wordprocessing;

namespace Scyzoryk.DocumentEngine.OpenXml;

// Zastepuje Find-ScyzorykMarkedCandidates (lib/wordSmartTemplate.ps1, Word COM)
// bezposrednim przejsciem po drzewie Open XML - bez Find, bez StoryRanges, bez
// Shapes collection. Kazdy mechanizm dziala na WLASCIWYM poziomie schematu OOXML:
//   highlight        -> w:rPr/w:highlight (poziom run)
//   shading-run      -> w:rPr/w:shd       (poziom run)
//   shading-paragraph-> w:pPr/w:shd       (poziom akapitu)
//   shading-cell     -> w:tcPr/w:shd      (poziom komorki tabeli)
// Textboxy (VML i DrawingML) NIE wymagaja osobnej sciezki - <w:txbxContent>
// zawiera zwykle <w:p>, ktore Descendants<Paragraph>() na korzeniu czesci i tak
// odwiedza (patrz PackageWalker) - jedyna roznica to ContainerKind = "textbox".
public static class MarkScanner
{
    public sealed record ScanOptions(HashSet<string> SelectedHighlightKeys, HashSet<string> SelectedShadingHexes);

    public sealed record ScanDiagnostics
    {
        public int PartsScanned;
        public int HighlightRangesFound;
        public int RunShadingRangesFound;
        public int ParagraphShadingRangesFound;
        public int CellShadingRangesFound;
    }

    public static List<MarkRegion> ScanDocument(WordprocessingDocument doc, ScanOptions options, ScanDiagnostics diagnostics)
    {
        var regions = new List<MarkRegion>();
        var counters = new Dictionary<string, int>();

        foreach (var part in PackageWalker.EnumerateParts(doc))
        {
            diagnostics.PartsScanned++;
            ScanPart(part.PartUri, part.Root, options, counters, regions, diagnostics);
        }

        return regions;
    }

    private static void ScanPart(string partUri, OpenXmlElement root, ScanOptions options, Dictionary<string, int> counters, List<MarkRegion> regions, ScanDiagnostics diagnostics)
    {
        var paragraphs = root.Descendants<Paragraph>().ToList();

        foreach (var paragraph in paragraphs)
        {
            var containerKind = ClassifyContainer(paragraph);

            if (options.SelectedHighlightKeys.Count > 0)
                ScanHighlightInParagraph(paragraph, partUri, containerKind, options, counters, regions, diagnostics);

            if (options.SelectedShadingHexes.Count > 0)
                ScanRunShadingInParagraph(paragraph, partUri, containerKind, options, counters, regions, diagnostics);

            if (options.SelectedShadingHexes.Count > 0)
                ScanParagraphShading(paragraph, partUri, containerKind, options, counters, regions, diagnostics);
        }

        if (options.SelectedShadingHexes.Count > 0)
        {
            foreach (var cell in root.Descendants<TableCell>())
                ScanCellShading(cell, partUri, options, counters, regions, diagnostics);
        }
    }

    private static string ClassifyContainer(Paragraph paragraph)
    {
        if (paragraph.Ancestors<TableCell>().Any()) return "tableCell";
        if (paragraph.Ancestors<TextBoxContent>().Any()) return "textbox";
        return "paragraph";
    }

    // --- Mechanizm A: highlight (run-level) ---------------------------------
    private static void ScanHighlightInParagraph(Paragraph paragraph, string partUri, string containerKind, ScanOptions options, Dictionary<string, int> counters, List<MarkRegion> regions, ScanDiagnostics diagnostics)
    {
        var runs = paragraph.Elements<Run>().ToList();
        int i = 0;
        while (i < runs.Count)
        {
            var key = GetHighlightKey(runs[i]);
            if (key is null) { i++; continue; }

            int j = i;
            var group = new List<Run>();
            while (j < runs.Count && GetHighlightKey(runs[j]) == key)
            {
                group.Add(runs[j]);
                j++;
            }

            var text = ConcatText(group);
            if (!string.IsNullOrEmpty(text) && options.SelectedHighlightKeys.Contains(key))
            {
                var paletteKey = $"highlight:{key}";
                var ordinal = NextOrdinal(counters, paletteKey);
                regions.Add(BuildRegion(partUri, containerKind, "highlight", paletteKey, key,
                    ColorMaps.HighlightKeyToHex[key], ordinal, text, paragraph, group,
                    BuildStructuralPath(paragraph, "r", group)));
                diagnostics.HighlightRangesFound++;
            }
            i = j;
        }
    }

    private static string? GetHighlightKey(Run run)
    {
        var val = run.RunProperties?.GetFirstChild<Highlight>()?.Val;
        if (val is null || !val.HasValue) return null;
        var raw = val.InnerText;
        if (string.Equals(raw, "none", StringComparison.OrdinalIgnoreCase)) return null;
        return ColorMaps.ConvertOoxmlHighlightToKey(raw);
    }

    // --- Mechanizm B: run/font shading ---------------------------------------
    private static void ScanRunShadingInParagraph(Paragraph paragraph, string partUri, string containerKind, ScanOptions options, Dictionary<string, int> counters, List<MarkRegion> regions, ScanDiagnostics diagnostics)
    {
        var runs = paragraph.Elements<Run>().ToList();
        int i = 0;
        while (i < runs.Count)
        {
            var hex = GetRunShadingHex(runs[i]);
            if (hex is null) { i++; continue; }

            int j = i;
            var group = new List<Run>();
            while (j < runs.Count && string.Equals(GetRunShadingHex(runs[j]), hex, StringComparison.OrdinalIgnoreCase))
            {
                group.Add(runs[j]);
                j++;
            }

            var text = ConcatText(group);
            if (!string.IsNullOrEmpty(text) && options.SelectedShadingHexes.Contains(hex.ToUpperInvariant()))
            {
                var paletteKey = $"shading:{hex.ToUpperInvariant()}";
                var ordinal = NextOrdinal(counters, paletteKey);
                regions.Add(BuildRegion(partUri, containerKind, "shading-run", paletteKey, hex.ToUpperInvariant(),
                    $"#{hex.ToUpperInvariant()}", ordinal, text, paragraph, group,
                    BuildStructuralPath(paragraph, "r", group)));
                diagnostics.RunShadingRangesFound++;
            }
            i = j;
        }
    }

    private static string? GetRunShadingHex(Run run)
    {
        var fill = run.RunProperties?.GetFirstChild<Shading>()?.Fill?.Value;
        return ColorMaps.IsVisibleShadingFill(fill) ? fill : null;
    }

    // --- Mechanizm C: paragraph shading ---------------------------------------
    private static void ScanParagraphShading(Paragraph paragraph, string partUri, string containerKind, ScanOptions options, Dictionary<string, int> counters, List<MarkRegion> regions, ScanDiagnostics diagnostics)
    {
        var fill = paragraph.ParagraphProperties?.GetFirstChild<Shading>()?.Fill?.Value;
        if (!ColorMaps.IsVisibleShadingFill(fill)) return;
        var hex = fill!.ToUpperInvariant();
        if (!options.SelectedShadingHexes.Contains(hex)) return;

        var group = paragraph.Elements<Run>().ToList();
        var text = ConcatText(group);
        if (string.IsNullOrEmpty(text)) return;

        var paletteKey = $"shading:{hex}";
        var ordinal = NextOrdinal(counters, paletteKey);
        regions.Add(BuildRegion(partUri, containerKind, "shading-paragraph", paletteKey, hex, $"#{hex}",
            ordinal, text, paragraph, group, BuildStructuralPath(paragraph, "p-shading", group)));
        diagnostics.ParagraphShadingRangesFound++;
    }

    // --- Mechanizm D: table-cell shading ---------------------------------------
    private static void ScanCellShading(TableCell cell, string partUri, ScanOptions options, Dictionary<string, int> counters, List<MarkRegion> regions, ScanDiagnostics diagnostics)
    {
        var fill = cell.TableCellProperties?.GetFirstChild<Shading>()?.Fill?.Value;
        if (!ColorMaps.IsVisibleShadingFill(fill)) return;
        var hex = fill!.ToUpperInvariant();
        if (!options.SelectedShadingHexes.Contains(hex)) return;

        // Wszystkie runy tekstowe w komorce (moze byc kilka akapitow) -
        // dla typowego przypadku Kreatora (etykieta/wartosc w jednej komorce)
        // to jeden akapit; wielo-akapitowe komorki tez sa obslugiwane (tresc =
        // suma wszystkich runow), ale build zastapi je JEDNYM runem w
        // PIERWSZYM akapicie komorki (patrz TextReplacer).
        var group = cell.Descendants<Run>().ToList();
        var text = ConcatText(group);
        if (string.IsNullOrEmpty(text)) return;

        var paletteKey = $"shading:{hex}";
        var ordinal = NextOrdinal(counters, paletteKey);
        var region = BuildRegion(partUri, "tableCell", "shading-cell", paletteKey, hex, $"#{hex}",
            ordinal, text, cell, group, BuildStructuralPath(cell));
        regions.Add(region);
        diagnostics.CellShadingRangesFound++;
    }

    // --- pomocnicze -------------------------------------------------------------
    private static int NextOrdinal(Dictionary<string, int> counters, string paletteKey)
    {
        counters.TryGetValue(paletteKey, out var current);
        current++;
        counters[paletteKey] = current;
        return current;
    }

    private static string ConcatText(IEnumerable<Run> runs)
        => string.Concat(runs.SelectMany(r => r.Elements<Text>()).Select(t => t.Text));

    private static MarkRegion BuildRegion(string partUri, string containerKind, string markKind, string paletteKey,
        string rawColor, string displayColor, int ordinal, string text, OpenXmlElement container, List<Run> contentRuns,
        string structuralPath)
    {
        var (before, after) = GetSurroundingContext(container);
        var region = new MarkRegion
        {
            PartUri = partUri,
            ContainerKind = containerKind,
            MarkKind = markKind,
            PaletteKey = paletteKey,
            RawColor = rawColor,
            DisplayColor = displayColor,
            Ordinal = ordinal,
            Text = text,
            Before = before,
            After = after,
            Container = container,
            ContentRuns = contentRuns,
            StructuralPath = structuralPath,
        };
        region.Fingerprint = ComputeFingerprint(region);
        return region;
    }

    // Kontekst do fingerprintu - tekst poprzedniego/nastepnego akapitu (albo
    // wiersza tabeli dla komorek), obcinany do 80 znakow. To jest DODATKOWA
    // weryfikacja tresci przy buildzie (patrz build-template), nie jedyne
    // zrodlo tozsamosci - nie musi byc idealnie precyzyjny co do znaku.
    private static (string Before, string After) GetSurroundingContext(OpenXmlElement container)
    {
        OpenXmlElement anchor = container;
        if (container is TableCell cell)
        {
            OpenXmlElement? row = cell.Ancestors<TableRow>().FirstOrDefault();
            anchor = row ?? cell;
        }
        var before = TruncateEnd(NormalizeText(GetTextOfPreviousSibling(anchor)), 80);
        var after = TruncateStart(NormalizeText(GetTextOfNextSibling(anchor)), 80);
        return (before, after);
    }

    private static string GetTextOfPreviousSibling(OpenXmlElement element)
    {
        var prev = element.PreviousSibling();
        return prev is null ? "" : string.Concat(prev.Descendants<Text>().Select(t => t.Text));
    }

    private static string GetTextOfNextSibling(OpenXmlElement element)
    {
        var next = element.NextSibling();
        return next is null ? "" : string.Concat(next.Descendants<Text>().Select(t => t.Text));
    }

    private static string TruncateEnd(string s, int max) => s.Length <= max ? s : s[^max..];
    private static string TruncateStart(string s, int max) => s.Length <= max ? s : s[..max];

    public static string NormalizeText(string? text)
    {
        if (string.IsNullOrEmpty(text)) return "";
        var t = Regex.Replace(text, @"\s+", " ");
        return t.Trim();
    }

    public static string ComputeFingerprint(MarkRegion region)
    {
        var source = string.Join("|",
            region.PartUri, region.PaletteKey, region.MarkKind, region.Text,
            NormalizeText(region.Before), NormalizeText(region.After), region.ContainerKind);
        var bytes = SHA256.HashData(Encoding.UTF8.GetBytes(source));
        return Convert.ToHexString(bytes).ToLowerInvariant();
    }

    // Sciezka wylacznie informacyjna/diagnostyczna (nie jest uzywana do
    // ponownej lokalizacji - to robi ponowny skan + dopasowanie po
    // (PartUri, PaletteKey, Ordinal) + weryfikacja Fingerprint, patrz
    // Commands/BuildTemplateCommand).
    private static string BuildStructuralPath(Paragraph paragraph, string kind, List<Run> group)
    {
        var pIndex = paragraph.Ancestors().OfType<OpenXmlPartRootElement>().FirstOrDefault() is { } rootEl
            ? rootEl.Descendants<Paragraph>().ToList().IndexOf(paragraph)
            : -1;
        var runIndex = paragraph.Elements<Run>().ToList().IndexOf(group[0]);
        return $"p[{pIndex}]/{kind}[{runIndex}..{runIndex + group.Count - 1}]";
    }

    private static string BuildStructuralPath(TableCell cell)
    {
        var table = cell.Ancestors<Table>().First();
        var rows = table.Elements<TableRow>().ToList();
        var row = cell.Ancestors<TableRow>().First();
        var rowIndex = rows.IndexOf(row);
        var cellIndex = row.Elements<TableCell>().ToList().IndexOf(cell);
        return $"table/row[{rowIndex}]/cell[{cellIndex}]";
    }
}
