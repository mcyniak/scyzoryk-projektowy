using System.Text;
using System.Text.RegularExpressions;
using DocumentFormat.OpenXml;
using DocumentFormat.OpenXml.Packaging;
using DocumentFormat.OpenXml.Wordprocessing;

namespace Scyzoryk.DocumentEngine.Merge;

// Heurystyki "legacy" dla szablonow BEZ pol korespondencji (tylko w trybie
// zwyklym, nigdy dla Smart Template z Kreatora) - wierne przeniesienie
// Fill-HighlightedTableCells i Fill-NarrativeBlanks z mailmerge-to-pdf.ps1.
// Listy etykiet i slow kluczowych sa skopiowane 1:1 - byly sprawdzane na
// prawdziwych szablonach firmy (patrz komentarze w skrypcie PowerShell).
public static class LegacyFillers
{
    public sealed record FillDebug(string Type, string Label, string Value);

    public static readonly Dictionary<string, string[]> LabelFieldCandidates = new()
    {
        ["id_projektu"] = new[] { "ID projektu", "LP gmina", "LP", "ID" },
        ["id"] = new[] { "ID projektu", "LP gmina", "LP", "ID" },
        ["uczestnik_projektu"] = new[] { "Imie i Nazwisko", "Inwestor", "Beneficjent" },
        ["adres_inwestycji"] = new[] { "Adres inwestycji", "Adres" },
        ["dzialka_ewid_nr"] = new[] { "Numer dzialki", "Numer dzia_ki", "Dzialka", "Dzia_ka", "Nr dzialki" },
        ["nr_dzialki"] = new[] { "Numer dzialki", "Numer dzia_ki", "Dzialka", "Dzia_ka", "Nr dzialki" },
        ["dzia_ka_ewid_nr"] = new[] { "Numer dzialki", "Numer dzia_ki", "Dzialka", "Dzia_ka", "Nr dzialki" },
        ["obreb_ewid_nr"] = new[] { "Numer obrebu", "Obreb", "Nr obrebu" },
        ["nr_obrebu"] = new[] { "Numer obrebu", "Obreb", "Nr obrebu" },
        ["gmina"] = new[] { "Gmina" },
        ["adres_obiektu"] = new[] { "Adres inwestycji", "Adres" },
        ["moc_projektowanej_instalacji"] = new[] { "Moc zestawu uwzgledniajaca moc modu_ow (biuro)", "Moc zestawu uwzgledniajaca moc modulow (biuro)", "Moc PV z gminy" },
    };

    public static readonly (string Keyword, string[] Candidates)[] NarrativeBlankKeywords =
    {
        ("powierzchnia ogrzewana", new[] { "Pow.", "Powierzchnia ogrzewana", "Powierzchnia" }),
        ("budowy", new[] { "Rok budowy" }),
    };

    // ---------------------------------------------------------------- tabele
    private sealed class CellChars
    {
        public List<(ParagraphText Model, int Index)?> Chars { get; } = new(); // null = znak konca akapitu
        public bool AnyHighlighted { get; set; }
        public string PlainText { get; set; } = "";
    }

    private static CellChars ReadCell(TableCell cell)
    {
        var result = new CellChars();
        var sb = new StringBuilder();
        var paragraphs = cell.Descendants<Paragraph>().Where(p => ReferenceEquals(DocumentStories.NearestCell(p), cell) && !IsNestedInInnerTable(p, cell)).ToList();
        for (var pi = 0; pi < paragraphs.Count; pi++)
        {
            var model = ParagraphText.Build(paragraphs[pi]);
            for (var i = 0; i < model.Slots.Count; i++)
            {
                result.Chars.Add((model, i));
                if (model.IsHighlighted(i)) result.AnyHighlighted = true;
            }
            sb.Append(model.Text);
            if (pi < paragraphs.Count - 1) result.Chars.Add(null);
        }
        result.PlainText = sb.ToString();
        return result;
    }

    private static bool IsNestedInInnerTable(Paragraph p, TableCell cell)
    {
        for (var e = p.Parent; e is not null && !ReferenceEquals(e, cell); e = e.Parent)
        {
            if (e is Table) return true;
        }
        return false;
    }

    // Word COM $table.Range.Cells: plaska lista komorek w kolejnosci czytania;
    // komorka scalona pionowo wystepuje RAZ (kontynuacje w:vMerge sa pomijane).
    private static List<TableCell> FlatCells(Table table)
    {
        var cells = new List<TableCell>();
        foreach (var row in table.Descendants<TableRow>().Where(r => ReferenceEquals(r.Ancestors<Table>().FirstOrDefault(), table)))
        {
            foreach (var cell in row.Descendants<TableCell>().Where(c => ReferenceEquals(c.Ancestors<TableRow>().FirstOrDefault(), row)))
            {
                var vm = cell.TableCellProperties?.VerticalMerge;
                if (vm is not null && (vm.Val is null || vm.Val.Value != MergedCellValues.Restart)) continue;
                cells.Add(cell);
            }
        }
        return cells;
    }

    public static int FillHighlightedTableCells(WordprocessingDocument doc, IReadOnlyList<KeyValuePair<string, string>> record, List<FillDebug> debug)
    {
        var body = doc.MainDocumentPart?.Document?.Body;
        if (body is null) return 0;
        var tables = body.Descendants<Table>().Where(t => !t.Ancestors<Table>().Any() && !DocumentStories.IsInTextBox(t)).ToList();

        var targets = new List<(ParagraphText Model, int Start, int End, string Value, string Label)>();
        foreach (var table in tables)
        {
            var cells = FlatCells(table);
            var read = cells.Select(ReadCell).ToList();
            for (var i = 0; i < cells.Count; i++)
            {
                if (!read[i].AnyHighlighted) continue;
                if (i == 0) continue;
                if (read[i - 1].AnyHighlighted) continue;

                var labelText = Regex.Replace(read[i - 1].PlainText, "[\r\a\t\f]", "").Trim().TrimEnd(':').Trim();
                if (string.IsNullOrWhiteSpace(labelText)) continue;
                var labelKey = TextNormalize.NormalizeName(labelText);
                if (!LabelFieldCandidates.TryGetValue(labelKey, out var candidates)) continue;

                var value = "";
                foreach (var c in candidates)
                {
                    value = TextNormalize.GetRecordValue(record, c);
                    if (!string.IsNullOrWhiteSpace(value)) break;
                }
                if (string.IsNullOrWhiteSpace(value)) continue;

                var sub = LongestHighlightedBlock(read[i]);
                if (sub is null) continue;
                targets.Add((sub.Value.Model, sub.Value.Start, sub.Value.End, value, labelText));
            }
        }

        var filled = 0;
        foreach (var target in targets)
        {
            var model = target.Model;
            model.Rebuild();
            var length = target.End - target.Start;
            if (target.End > model.Slots.Count) continue;
            // 1) zdejmij podswietlenie z CALEGO oryginalnego bloku,
            foreach (var run in model.RunsInRange(target.Start, length)) RunFormatting.ClearHighlight(run);
            // 2) "XYZ, 97-360 Kamiensk": podmieniamy tylko czesc przed pierwszym
            //    przecinkiem, reszta (staly tekst) zostaje.
            var original = model.Text.Substring(target.Start, length);
            var commaIdx = original.IndexOf(',');
            var replaceLen = commaIdx > 0 ? commaIdx : length;
            model.ReplaceRange(target.Start, replaceLen, target.Value);
            filled++;
            debug.Add(new FillDebug("table-label", target.Label, target.Value));
        }
        return filled;
    }

    // Get-HighlightedSubRange: najdluzszy spojny blok podswietlonych znakow w
    // komorce (arytmetyka skopiowana 1:1 z PowerShell, lacznie z tym, jak
    // rozstrzygane sa remisy). Znak konca akapitu nigdy nie jest podswietlony,
    // wiec blok nie przekracza granicy akapitu.
    private static (ParagraphText Model, int Start, int End)? LongestHighlightedBlock(CellChars cell)
    {
        var count = cell.Chars.Count;
        int bestStart = -1, bestEnd = -1, curStart = -1;
        bool Hl(int oneBased)
        {
            var c = cell.Chars[oneBased - 1];
            return c is not null && c.Value.Model.IsHighlighted(c.Value.Index);
        }
        for (var i = 1; i <= count; i++)
        {
            if (Hl(i))
            {
                if (curStart == -1) curStart = i;
            }
            else if (curStart != -1)
            {
                if ((i - curStart) > (bestEnd - bestStart)) { bestStart = curStart; bestEnd = i - 1; }
                curStart = -1;
            }
        }
        if (curStart != -1 && (count - curStart + 1) > (bestEnd - bestStart)) { bestStart = curStart; bestEnd = count; }
        if (bestStart == -1) return null;

        var first = cell.Chars[bestStart - 1]!.Value;
        var last = cell.Chars[bestEnd - 1]!.Value;
        return (first.Model, first.Index, last.Index + 1);
    }

    // ------------------------------------------------------- wielokropki w zdaniach
    public static int FillNarrativeBlanks(WordprocessingDocument doc, IReadOnlyList<KeyValuePair<string, string>> record, List<FillDebug> debug)
    {
        var paragraphs = DocumentStories.MainStoryParagraphs(doc);
        // Liniowy tekst glownej historii (akapity rozdzielone \r) - potrzebny do
        // okna "140 znakow przed wielokropkiem".
        var linear = new StringBuilder();
        var segments = new List<(ParagraphText Model, int Start, int End, int LinearStart, int LinearEnd, bool InTable)>();
        foreach (var p in paragraphs)
        {
            var model = ParagraphText.Build(p);
            var baseOffset = linear.Length;
            var inTable = DocumentStories.NearestCell(p) is not null;
            var i = 0;
            while (i < model.Slots.Count)
            {
                if (!model.IsHighlighted(i)) { i++; continue; }
                var j = i;
                while (j < model.Slots.Count && model.IsHighlighted(j)) j++;
                segments.Add((model, i, j, baseOffset + i, baseOffset + j, inTable));
                i = j;
            }
            linear.Append(model.Text).Append('\r');
        }
        var linearText = linear.ToString();

        var targets = new List<(ParagraphText Model, int Start, int End, string Value)>();
        var lastEnd = 0;
        foreach (var seg in segments)
        {
            if (!seg.InTable)
            {
                var windowStart = Math.Max(lastEnd, seg.LinearStart - 140);
                var preceding = windowStart < seg.LinearStart ? linearText[windowStart..seg.LinearStart] : "";
                preceding = Regex.Replace(preceding, "[\r\a\t\f\v]", " ").Trim().ToLowerInvariant();
                foreach (var (keyword, candidates) in NarrativeBlankKeywords)
                {
                    if (!preceding.Contains(keyword, StringComparison.Ordinal)) continue;
                    var value = "";
                    foreach (var c in candidates)
                    {
                        value = TextNormalize.GetRecordValue(record, c);
                        if (!string.IsNullOrWhiteSpace(value)) break;
                    }
                    if (string.IsNullOrWhiteSpace(value)) continue;
                    targets.Add((seg.Model, seg.Start, seg.End, value));
                    debug.Add(new FillDebug("narrative-match", keyword, value));
                    break;
                }
            }
            lastEnd = seg.LinearEnd;
        }

        // Od konca: kilka wielokropkow w jednym akapicie nie przesuwa sobie pozycji.
        var filled = 0;
        foreach (var t in targets.OrderByDescending(t => t.Start))
        {
            foreach (var run in t.Model.RunsInRange(t.Start, t.End - t.Start)) RunFormatting.ClearHighlight(run);
            t.Model.ReplaceRange(t.Start, t.End - t.Start, t.Value);
            filled++;
        }
        return filled;
    }
}
