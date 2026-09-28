using DocumentFormat.OpenXml.Packaging;

namespace Scyzoryk.DocumentEngine.Merge;

// Replace-AllTextMarkers (mailmerge-to-pdf.ps1):
//  1) reczne zasady z panelu "zamien tekst X na kolumne Y" (opcjonalnie tylko
//     N-te wystapienie w dokumencie),
//  2) automatyczne znaczniki {{Kolumna}}, [[Kolumna]], <<Kolumna>>, «Kolumna».
// Wyszukiwanie bez rozrozniania wielkosci liter (Word: MatchCase = false),
// dziala ponad granicami runow w obrebie akapitu.
public static class TextMarkerReplacer
{
    public sealed record Rule(string Find, string Column, int Occurrence);
    public sealed record MarkerDebug(string Type, string Find, string Column, string Value, string Occurrence, int Changed);

    public static List<MarkerDebug> ReplaceAll(WordprocessingDocument doc, IReadOnlyList<KeyValuePair<string, string>> record, IEnumerable<Rule> rules, bool debugMode)
    {
        var debug = new List<MarkerDebug>();
        var paragraphs = DocumentStories.OrderedParagraphs(doc);

        foreach (var rule in rules)
        {
            if (string.IsNullOrWhiteSpace(rule.Find) || string.IsNullOrWhiteSpace(rule.Column)) continue;
            var value = TextNormalize.GetRecordValue(record, rule.Column);
            var changed = ReplaceEverywhere(paragraphs, rule.Find, value, rule.Occurrence);
            if (debugMode)
                debug.Add(new MarkerDebug("manual", rule.Find, rule.Column, value, rule.Occurrence > 0 ? rule.Occurrence.ToString() : "all", changed));
        }

        if (DocumentMayHaveAutoMarkers(paragraphs))
        {
            foreach (var p in record)
            {
                if (p.Key == "_record") continue;
                foreach (var token in AutomaticMarkersForColumn(p.Key))
                {
                    var changed = ReplaceEverywhere(paragraphs, token, p.Value, 0);
                    if (debugMode && changed > 0) debug.Add(new MarkerDebug("auto", token, p.Key, p.Value, "all", changed));
                }
            }
        }

        return debug;
    }

    public static List<string> AutomaticMarkersForColumn(string columnName)
    {
        var tokens = new List<string>();
        var names = new List<string>();
        void Add(List<string> list, string? v) { if (!string.IsNullOrWhiteSpace(v) && !list.Contains(v)) list.Add(v); }
        Add(names, columnName);
        Add(names, TextNormalize.NormalizeName(columnName));
        foreach (var name in names)
        {
            Add(tokens, "{{" + name + "}}");
            Add(tokens, "[[" + name + "]]");
            Add(tokens, "<<" + name + ">>");
            Add(tokens, "«" + name + "»");
        }
        return tokens;
    }

    private static bool DocumentMayHaveAutoMarkers(List<DocumentStories.StoryParagraph> paragraphs)
    {
        foreach (var sp in paragraphs)
        {
            var t = sp.Paragraph.InnerText;
            if (t.Contains("{{") || t.Contains("[[") || t.Contains("<<") || t.Contains('«')) return true;
        }
        return false;
    }

    // occurrence <= 0: wszystkie wystapienia; > 0: tylko N-te w calym
    // dokumencie (licznik wspolny dla wszystkich akapitow, w kolejnosci
    // DocumentStories.OrderedParagraphs).
    public static int ReplaceEverywhere(List<DocumentStories.StoryParagraph> paragraphs, string find, string replacement, int occurrence)
    {
        if (string.IsNullOrEmpty(find)) return 0;
        var changed = 0;
        var counter = 0;

        foreach (var sp in paragraphs)
        {
            if (sp.Paragraph.Parent is null) continue;
            if (occurrence > 0 && sp.IsFallbackCopy) continue;
            if (!sp.Paragraph.InnerText.Contains(find, StringComparison.OrdinalIgnoreCase) && !MayMatchAcrossSpecials(sp.Paragraph, find)) continue;

            var model = ParagraphText.Build(sp.Paragraph);
            var pos = 0;
            var any = false;
            while (pos <= model.Text.Length)
            {
                var idx = model.Text.IndexOf(find, pos, StringComparison.OrdinalIgnoreCase);
                if (idx < 0) break;
                if (occurrence > 0)
                {
                    counter++;
                    if (counter == occurrence)
                    {
                        model.ReplaceRange(idx, find.Length, replacement);
                        return 1;
                    }
                    pos = idx + find.Length;
                    continue;
                }
                model.ReplaceRange(idx, find.Length, replacement);
                any = true;
                pos = idx + replacement.Length;
            }
            if (any) changed = 1; // Word COM Find.Execute(ReplaceAll) zwracal 1 niezaleznie od liczby trafien
        }

        return occurrence > 0 ? 0 : changed;
    }

    // InnerText nie zawiera tabulatorow/miekkich enterow - jesli szukany tekst
    // je zawiera, zwykly pre-filtr po InnerText by go przegapil.
    private static bool MayMatchAcrossSpecials(DocumentFormat.OpenXml.Wordprocessing.Paragraph p, string find) =>
        find.IndexOfAny(new[] { '\t', '\v' }) >= 0;
}
