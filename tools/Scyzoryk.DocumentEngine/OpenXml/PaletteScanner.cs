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
        // Ile wystapien lezy w wierszu naglowka tabeli (pierwszy wiersz tabeli
        // z co najmniej dwoma wierszami albo wiersz z w:tblHeader). Kolor, ktory
        // wystepuje WYLACZNIE w naglowkach, to prawie zawsze dekoracja (szare/
        // niebieskie tlo "Pozycja | Wartosc"), nie pole robocze - UI Kreatora
        // nie zaznacza go domyslnie (Suggested=false).
        public int HeaderRowCount { get; set; }
        public bool Suggested => !(HeaderRowCount > 0 && HeaderRowCount == Count);
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
                            AddOccurrence(palette, $"highlight:{key}", "highlight", key, ColorMaps.HighlightKeyToHex[key], text, IsInHeaderRow(run));
                    }

                    var runFill = run.RunProperties?.GetFirstChild<Shading>()?.Fill?.Value;
                    if (ColorMaps.IsVisibleShadingFill(runFill))
                    {
                        var hex = runFill!.ToUpperInvariant();
                        AddOccurrence(palette, $"shading:{hex}", "shading", hex, $"#{hex}", text, IsInHeaderRow(run));
                    }
                }

                var paraFill = paragraph.ParagraphProperties?.GetFirstChild<Shading>()?.Fill?.Value;
                if (ColorMaps.IsVisibleShadingFill(paraFill))
                {
                    var hex = paraFill!.ToUpperInvariant();
                    var text = string.Concat(paragraph.Elements<Run>().SelectMany(r => r.Elements<Text>()).Select(t => t.Text));
                    if (!string.IsNullOrEmpty(text))
                        AddOccurrence(palette, $"shading:{hex}", "shading", hex, $"#{hex}", text, IsInHeaderRow(paragraph));
                }
            }

            foreach (var cell in part.Root.Descendants<TableCell>())
            {
                var cellFill = cell.TableCellProperties?.GetFirstChild<Shading>()?.Fill?.Value;
                if (!ColorMaps.IsVisibleShadingFill(cellFill)) continue;
                var hex = cellFill!.ToUpperInvariant();
                var text = string.Concat(cell.Descendants<Text>().Select(t => t.Text));
                if (!string.IsNullOrEmpty(text))
                    AddOccurrence(palette, $"shading:{hex}", "shading", hex, $"#{hex}", text, IsInHeaderRow(cell));
            }
        }

        return palette.Values
            .OrderBy(p => p.Kind)
            .ThenByDescending(p => p.Count)
            .ToList();
    }

    public static bool IsInHeaderRow(OpenXmlElement element)
    {
        var row = element.Ancestors<TableRow>().FirstOrDefault();
        if (row is null) return false;
        if (row.TableRowProperties?.GetFirstChild<TableHeader>() is not null) return true;
        if (row.Parent is not Table table) return false;
        var rows = table.Elements<TableRow>().ToList();
        return rows.Count >= 2 && ReferenceEquals(rows[0], row);
    }

    private static void AddOccurrence(Dictionary<string, PaletteEntry> palette, string key, string kind, string rawValue, string displayColor, string exampleText, bool inHeaderRow)
    {
        if (!palette.TryGetValue(key, out var entry))
        {
            entry = new PaletteEntry { Key = key, Kind = kind, RawValue = rawValue, DisplayColor = displayColor };
            palette[key] = entry;
        }
        entry.Count++;
        if (inHeaderRow) entry.HeaderRowCount++;
        if (entry.Examples.Count < 3)
        {
            var trimmed = MarkScanner.NormalizeText(exampleText);
            if (!string.IsNullOrEmpty(trimmed)) entry.Examples.Add(trimmed);
        }
    }
}
