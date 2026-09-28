using System.Text;
using DocumentFormat.OpenXml;
using DocumentFormat.OpenXml.Wordprocessing;

namespace Scyzoryk.DocumentEngine.Merge;

// Widok "znak po znaku" na tresc JEDNEGO akapitu - odpowiednik tego, co Word COM
// daje przez Range.Characters / Range.Find, ale bez Worda. Kazdy znak pamieta,
// z ktorego elementu XML pochodzi (w:t, w:tab, w:br...), wiec podmiana
// fragmentu tekstu moze przeciac granice runow dokladnie tak, jak robi to Word
// (tekst zastepczy dostaje formatowanie PIERWSZEGO podmienianego znaku).
//
// Pomijane (jak w Wordzie przy ukrytych kodach pol):
//  - kody pol (w:instrText i wszystko miedzy fldChar begin a separate),
//  - runy zagniezdzonych akapitow (tekst textboxa zakotwiczonego w tym akapicie
//    nalezy do INNEGO akapitu - ma wlasny ParagraphText).
public sealed class ParagraphText
{
    public sealed class Slot
    {
        public required Run Run { get; init; }
        public required OpenXmlElement Element { get; init; }
        // Pozycja w Text.Text dla w:t; 0 dla elementow jednoznakowych (tab/br).
        public required int Offset { get; init; }
        public required char Char { get; init; }
    }

    public Paragraph Paragraph { get; }
    public List<Slot> Slots { get; } = new();
    public string Text { get; private set; } = "";

    private ParagraphText(Paragraph paragraph)
    {
        Paragraph = paragraph;
    }

    public static ParagraphText Build(Paragraph paragraph)
    {
        var model = new ParagraphText(paragraph);
        model.Rebuild();
        return model;
    }

    public void Rebuild()
    {
        Slots.Clear();
        var fieldDepthInCode = 0;
        var stack = new Stack<bool>(); // true = jestesmy w kodzie pola (przed separate)

        foreach (var run in Paragraph.Descendants<Run>())
        {
            if (!ReferenceEquals(NearestParagraph(run), Paragraph)) continue;

            foreach (var child in run.ChildElements)
            {
                switch (child)
                {
                    case FieldChar fc:
                        var type = fc.FieldCharType?.Value;
                        if (type == FieldCharValues.Begin) { stack.Push(true); fieldDepthInCode++; }
                        else if (type == FieldCharValues.Separate)
                        {
                            if (stack.Count > 0 && stack.Peek()) { stack.Pop(); stack.Push(false); fieldDepthInCode--; }
                        }
                        else if (type == FieldCharValues.End)
                        {
                            if (stack.Count > 0) { if (stack.Pop()) fieldDepthInCode--; }
                        }
                        break;
                    case Text t when fieldDepthInCode == 0:
                        var s = t.Text ?? "";
                        for (var i = 0; i < s.Length; i++)
                            Slots.Add(new Slot { Run = run, Element = t, Offset = i, Char = s[i] });
                        break;
                    case TabChar tab when fieldDepthInCode == 0:
                        Slots.Add(new Slot { Run = run, Element = tab, Offset = 0, Char = '\t' });
                        break;
                    case Break br when fieldDepthInCode == 0:
                        // Word pokazuje miekki enter (Shift+Enter) jako znak 11 (\v).
                        Slots.Add(new Slot { Run = run, Element = br, Offset = 0, Char = '\v' });
                        break;
                    case NoBreakHyphen nbh when fieldDepthInCode == 0:
                        Slots.Add(new Slot { Run = run, Element = nbh, Offset = 0, Char = '‑' });
                        break;
                }
            }
        }

        var sb = new StringBuilder(Slots.Count);
        foreach (var slot in Slots) sb.Append(slot.Char);
        Text = sb.ToString();
    }

    public static Paragraph? NearestParagraph(OpenXmlElement element)
    {
        for (var e = element.Parent; e is not null; e = e.Parent)
        {
            if (e is Paragraph p) return p;
        }
        return null;
    }

    public bool IsHighlighted(int index) => RunFormatting.IsHighlighted(Slots[index].Run);

    // Podmienia znaki [start, start+length) na `replacement`. Tekst zastepczy
    // trafia do elementu PIERWSZEGO podmienianego znaku (dziedziczy jego
    // formatowanie - tak samo dziala Word Find/Replace i Range.Text = ...).
    // Po wywolaniu model jest przebudowywany (Rebuild), wiec indeksy znakow
    // ZA podmienionym fragmentem sie przesuwaja - wywolujacy, ktory podmienia
    // kilka fragmentow w jednym akapicie, robi to od konca albo przelicza
    // pozycje po kazdej podmianie.
    public void ReplaceRange(int start, int length, string replacement)
    {
        if (length <= 0 && string.IsNullOrEmpty(replacement)) return;
        if (start < 0 || start + length > Slots.Count) throw new ArgumentOutOfRangeException(nameof(start));

        if (length == 0)
        {
            InsertAt(start, replacement);
            Rebuild();
            return;
        }

        var first = Slots[start];
        // Grupujemy usuwane znaki per element (w:t moze stracic tylko czesc znakow).
        var removals = new Dictionary<OpenXmlElement, List<int>>();
        for (var i = start; i < start + length; i++)
        {
            var slot = Slots[i];
            if (!removals.TryGetValue(slot.Element, out var list)) removals[slot.Element] = list = new List<int>();
            list.Add(slot.Offset);
        }

        foreach (var (element, offsets) in removals)
        {
            if (element is Text t)
            {
                var chars = (t.Text ?? "").ToCharArray().ToList();
                var insertHere = ReferenceEquals(element, first.Element) ? first.Offset : -1;
                foreach (var off in offsets.OrderByDescending(o => o)) chars.RemoveAt(off);
                var newText = new string(chars.ToArray());
                if (insertHere >= 0) newText = newText.Insert(Math.Min(insertHere, newText.Length), replacement);
                t.Text = newText;
                t.Space = SpaceProcessingModeValues.Preserve;
            }
            else
            {
                if (ReferenceEquals(element, first.Element) && !string.IsNullOrEmpty(replacement))
                {
                    element.InsertBeforeSelf(new Text(replacement) { Space = SpaceProcessingModeValues.Preserve });
                }
                element.Remove();
            }
        }

        Rebuild();
    }

    private void InsertAt(int index, string text)
    {
        if (index < Slots.Count)
        {
            var slot = Slots[index];
            if (slot.Element is Text t)
            {
                t.Text = (t.Text ?? "").Insert(slot.Offset, text);
                t.Space = SpaceProcessingModeValues.Preserve;
            }
            else
            {
                slot.Element.InsertBeforeSelf(new Text(text) { Space = SpaceProcessingModeValues.Preserve });
            }
            return;
        }

        if (Slots.Count > 0)
        {
            var last = Slots[^1];
            if (last.Element is Text lt)
            {
                lt.Text = (lt.Text ?? "") + text;
                lt.Space = SpaceProcessingModeValues.Preserve;
            }
            else
            {
                last.Element.InsertAfterSelf(new Text(text) { Space = SpaceProcessingModeValues.Preserve });
            }
            return;
        }

        Paragraph.AppendChild(new Run(new Text(text) { Space = SpaceProcessingModeValues.Preserve }));
    }

    // Runy, ktore maja choc jeden znak w [start, start+length).
    public List<Run> RunsInRange(int start, int length)
    {
        var result = new List<Run>();
        for (var i = start; i < start + length && i < Slots.Count; i++)
        {
            if (!result.Any(r => ReferenceEquals(r, Slots[i].Run))) result.Add(Slots[i].Run);
        }
        return result;
    }
}

public static class RunFormatting
{
    // Highlight tylko z bezposrednich wlasciwosci runu - tak samo jak
    // MarkScanner (skaner Kreatora), zeby "co jest podswietlone" znaczylo to
    // samo przy budowie wzoru i przy generowaniu.
    public static bool IsHighlighted(Run run)
    {
        var val = run.RunProperties?.GetFirstChild<Highlight>()?.Val;
        if (val is null || !val.HasValue) return false;
        return !string.Equals(val.InnerText, "none", StringComparison.OrdinalIgnoreCase);
    }

    public static void ClearHighlight(Run run)
    {
        run.RunProperties?.GetFirstChild<Highlight>()?.Remove();
    }
}
