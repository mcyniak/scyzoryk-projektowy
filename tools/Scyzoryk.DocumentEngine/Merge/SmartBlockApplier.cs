using System.Text.Json;
using DocumentFormat.OpenXml;
using DocumentFormat.OpenXml.Packaging;
using DocumentFormat.OpenXml.Wordprocessing;
using Scyzoryk.DocumentEngine.OpenXml;

namespace Scyzoryk.DocumentEngine.Merge;

// Apply-ScyzorykSmartBlocks (lib/wordSmartTemplate.ps1) bez Worda. Decyzja
// "zostaw / usun" dla kazdego bloku SCYB_xxx jest juz podjeta w Node
// (lib/smartTemplateRules.js#evaluateSmartRecord -> _scyBlocksJson); tutaj
// tylko ja wykonujemy na dokumencie:
//   true  -> tresc zostaje, znika sam znacznik bookmarka,
//   false -> znika caly zakres bookmarka razem z trescia.
// Brakujacy/uszkodzony bookmark NIE przerywa rekordu - trafia na liste
// problemow (rekord dostaje blad, ale PDF powstaje), dokladnie jak dotad.
public static class SmartBlockApplier
{
    public sealed record Issue(string Level, string Message);

    public static List<Issue> Apply(WordprocessingDocument doc, IReadOnlyList<KeyValuePair<string, string>> record)
    {
        var issues = new List<Issue>();
        var raw = record.FirstOrDefault(p => p.Key == "_scyBlocksJson").Value;
        if (string.IsNullOrWhiteSpace(raw)) return issues;

        Dictionary<string, bool> state;
        try
        {
            state = new Dictionary<string, bool>();
            using var json = JsonDocument.Parse(raw);
            foreach (var prop in json.RootElement.EnumerateObject())
            {
                state[prop.Name] = prop.Value.ValueKind switch
                {
                    JsonValueKind.True => true,
                    JsonValueKind.False => false,
                    JsonValueKind.String => bool.TryParse(prop.Value.GetString(), out var b) && b,
                    JsonValueKind.Number => prop.Value.GetDouble() != 0,
                    _ => false,
                };
            }
        }
        catch (Exception ex)
        {
            issues.Add(new Issue("error", $"Nie udalo sie odczytac _scyBlocksJson: {ex.Message}"));
            return issues;
        }

        var parts = PackageWalker.EnumerateParts(doc);
        var entries = new List<(string Name, bool Keep, BookmarkStart Start, OpenXmlElement Root)>();
        foreach (var (name, keep) in state)
        {
            BookmarkStart? found = null;
            OpenXmlElement? root = null;
            foreach (var part in parts)
            {
                found = part.Root.Descendants<BookmarkStart>().FirstOrDefault(b => b.Name?.Value == name);
                if (found is not null) { root = part.Root; break; }
            }
            if (found is null || root is null)
            {
                issues.Add(new Issue("error", $"Brak bookmarka '{name}' wymaganego przez wzor - sprawdz, czy dokument nie zostal recznie zmieniony po zbudowaniu w Kreatorze."));
                continue;
            }
            entries.Add((name, keep, found, root));
        }

        // Od konca dokumentu - jak w PowerShell (tam ze wzgledu na pozycje;
        // tutaj dziala na referencjach, ale kolejnosc zostaje ta sama, zeby
        // zagniezdzone bloki rozstrzygaly sie identycznie).
        var order = new Dictionary<OpenXmlElement, int>();
        foreach (var e in entries)
        {
            if (!order.ContainsKey(e.Root))
            {
                var idx = 0;
                foreach (var d in e.Root.Descendants()) order[d] = idx++;
            }
        }

        foreach (var entry in entries.OrderByDescending(e => order.TryGetValue(e.Start, out var i) ? i : -1))
        {
            try
            {
                if (entry.Start.Parent is null) continue; // usuniety razem z zewnetrznym blokiem
                var id = entry.Start.Id?.Value;
                var end = entry.Root.Descendants<BookmarkEnd>().FirstOrDefault(b => b.Id?.Value == id);
                if (end is null)
                {
                    issues.Add(new Issue("error", $"Nie udalo sie przetworzyc bloku '{entry.Name}': brak konca bookmarka."));
                    continue;
                }

                if (entry.Keep)
                {
                    entry.Start.Remove();
                    end.Remove();
                }
                else
                {
                    DeleteRange(entry.Start, end);
                }
            }
            catch (Exception ex)
            {
                issues.Add(new Issue("error", $"Nie udalo sie przetworzyc bloku '{entry.Name}': {ex.Message}"));
            }
        }

        return issues;
    }

    // Usuwa wszystko miedzy bookmarkStart a bookmarkEnd (wlacznie z nimi).
    // Przypadek typowy (Kreator: BookmarkWriter.WrapInBookmark) - oba znaczniki
    // sa rodzenstwem: usuwamy rodzenstwo pomiedzy nimi. Przypadek ogolny (wzor
    // recznie edytowany w Wordzie, znaczniki w roznych akapitach) - jak Word
    // Range.Delete(): obcinamy koncowke pierwszego akapitu, poczatek ostatniego,
    // wszystko pomiedzy, a ostatni akapit laczymy z pierwszym.
    public static void DeleteRange(BookmarkStart start, BookmarkEnd end)
    {
        if (ReferenceEquals(start.Parent, end.Parent))
        {
            var node = start.NextSibling();
            while (node is not null && !ReferenceEquals(node, end))
            {
                var next = node.NextSibling();
                RemoveKeepingSectionBreak(node);
                node = next;
            }
            start.Remove();
            end.Remove();
            return;
        }

        var common = start.Ancestors().First(a => end.Ancestors().Contains(a));
        var startTop = TopChildUnder(start, common);
        var endTop = TopChildUnder(end, common);

        // 1) w galezi startu: wszystko ZA startem (na kazdym poziomie az do startTop)
        for (OpenXmlElement e = start; !ReferenceEquals(e, startTop); e = e.Parent!)
        {
            var sib = e.NextSibling();
            while (sib is not null)
            {
                var next = sib.NextSibling();
                if (!(sib is ParagraphProperties)) sib.Remove();
                sib = next;
            }
        }
        // 2) w galezi konca: wszystko PRZED koncem (bez wlasciwosci akapitu/wiersza)
        for (OpenXmlElement e = end; !ReferenceEquals(e, endTop); e = e.Parent!)
        {
            var sib = e.PreviousSibling();
            while (sib is not null)
            {
                var prev = sib.PreviousSibling();
                if (!(sib is ParagraphProperties || sib is TableRowProperties || sib is TableCellProperties)) sib.Remove();
                sib = prev;
            }
        }
        // 3) wszystko pomiedzy galeziami
        var between = startTop.NextSibling();
        while (between is not null && !ReferenceEquals(between, endTop))
        {
            var next = between.NextSibling();
            RemoveKeepingSectionBreak(between);
            between = next;
        }
        // 4) Word laczy akapit startu z akapitem konca (znika znak konca akapitu startu).
        if (startTop is Paragraph sp && endTop is Paragraph ep)
        {
            foreach (var child in ep.ChildElements.Where(c => c is not ParagraphProperties).ToList())
            {
                child.Remove();
                sp.AppendChild(child);
            }
            // Wlasciwosci ostatniego akapitu (np. podzial sekcji) przechodza na polaczony.
            var epProps = ep.ParagraphProperties;
            if (epProps?.SectionProperties is not null)
            {
                sp.ParagraphProperties?.Remove();
                epProps.Remove();
                sp.PrependChild(epProps);
            }
            ep.Remove();
        }
        start.Remove();
        end.Remove();
    }

    private static OpenXmlElement TopChildUnder(OpenXmlElement e, OpenXmlElement ancestor)
    {
        var cur = e;
        while (!ReferenceEquals(cur.Parent, ancestor)) cur = cur.Parent!;
        return cur;
    }

    // Akapit niosacy podzial sekcji (w:pPr/w:sectPr) nie moze zniknac - zmienilby
    // uklad stron calego dokumentu. Czyscimy wtedy tylko jego tresc.
    private static void RemoveKeepingSectionBreak(OpenXmlElement node)
    {
        if (node is Paragraph p && p.ParagraphProperties?.SectionProperties is not null)
        {
            foreach (var child in p.ChildElements.Where(c => c is not ParagraphProperties).ToList()) child.Remove();
            return;
        }
        if (node is SectionProperties) return;
        node.Remove();
    }
}
