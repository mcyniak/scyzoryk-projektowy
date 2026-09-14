using DocumentFormat.OpenXml;
using DocumentFormat.OpenXml.Packaging;
using DocumentFormat.OpenXml.Wordprocessing;

namespace Scyzoryk.DocumentEngine.OpenXml;

// ETAP 1 specyfikacji Kreatora: inwentaryzacja WSZYSTKICH kolorow/rodzajow
// oznaczen uzytych w dokumencie, zanim uzytkownik wybierze ktore sa "robocze"
// (kolor sam w sobie nie ma znaczenia biznesowego). Zastepuje regexowy skan
// XML z apps/kreator-wzorow/scripts/scan-template.ps1#Get-MarkingPaletteFromXml -
// ten sam koncepcyjnie krok, ale przez prawdziwe drzewo Open XML (SDK sam
// dba o poprawnosc parsowania, wielkosc liter atrybutow itd.), wiec dziala
// identycznie na kazdym mechanizmie co MarkScanner uzywa pozniej dla candidates.
public static class PaletteScanner
{
    public sealed record PaletteEntry
    {
        public string Key { get; init; } = "";
        public string Kind { get; init; } = ""; // highlight | shading
        public string RawValue { get; init; } = "";
        public string DisplayColor { get; init; } = "";
        public int Count { get; set; }
        public List<string> Examples { get; } = new();
    }

    public static List<PaletteEntry> ScanPalette(WordprocessingDocument doc)
    {
        var palette = new Dictionary<string, PaletteEntry>();

        foreach (var part in PackageWalker.EnumerateParts(doc))
        {
            foreach (var paragraph in part.Root.Descendants<Paragraph>())
            {
                foreach (var run in paragraph.Elements<Run>())
                {
                    var text = string.Concat(run.Elements<Text>().Select(t => t.Text));
                    if (string.IsNullOrEmpty(text)) continue;

                    var highlightRaw = run.RunProperties?.GetFirstChild<Highlight>()?.Val;
                    if (highlightRaw is { HasValue: true } && !string.Equals(highlightRaw.InnerText, "none", StringComparison.OrdinalIgnoreCase))
                    {
                        var key = ColorMaps.ConvertOoxmlHighlightToKey(highlightRaw.InnerText);
                        if (key is not null)
                            AddOccurrence(palette, $"highlight:{key}", "highlight", key, ColorMaps.HighlightKeyToHex[key], text);
                    }

                    var runFill = run.RunProperties?.GetFirstChild<Shading>()?.Fill?.Value;
                    if (ColorMaps.IsVisibleShadingFill(runFill))
                    {
                        var hex = runFill!.ToUpperInvariant();
                        AddOccurrence(palette, $"shading:{hex}", "shading", hex, $"#{hex}", text);
                    }
                }

                var paraFill = paragraph.ParagraphProperties?.GetFirstChild<Shading>()?.Fill?.Value;
                if (ColorMaps.IsVisibleShadingFill(paraFill))
                {
                    var hex = paraFill!.ToUpperInvariant();
                    var text = string.Concat(paragraph.Elements<Run>().SelectMany(r => r.Elements<Text>()).Select(t => t.Text));
                    if (!string.IsNullOrEmpty(text))
                        AddOccurrence(palette, $"shading:{hex}", "shading", hex, $"#{hex}", text);
                }
            }

            foreach (var cell in part.Root.Descendants<TableCell>())
            {
                var cellFill = cell.TableCellProperties?.GetFirstChild<Shading>()?.Fill?.Value;
                if (!ColorMaps.IsVisibleShadingFill(cellFill)) continue;
                var hex = cellFill!.ToUpperInvariant();
                var text = string.Concat(cell.Descendants<Text>().Select(t => t.Text));
                if (!string.IsNullOrEmpty(text))
                    AddOccurrence(palette, $"shading:{hex}", "shading", hex, $"#{hex}", text);
            }
        }

        return palette.Values
            .OrderBy(p => p.Kind)
            .ThenByDescending(p => p.Count)
            .ToList();
    }

    private static void AddOccurrence(Dictionary<string, PaletteEntry> palette, string key, string kind, string rawValue, string displayColor, string exampleText)
    {
        if (!palette.TryGetValue(key, out var entry))
        {
            entry = new PaletteEntry { Key = key, Kind = kind, RawValue = rawValue, DisplayColor = displayColor };
            palette[key] = entry;
        }
        entry.Count++;
        if (entry.Examples.Count < 3)
        {
            var trimmed = MarkScanner.NormalizeText(exampleText);
            if (!string.IsNullOrEmpty(trimmed)) entry.Examples.Add(trimmed);
        }
    }
}
