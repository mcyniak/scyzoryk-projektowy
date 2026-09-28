using DocumentFormat.OpenXml;
using DocumentFormat.OpenXml.Packaging;
using DocumentFormat.OpenXml.Wordprocessing;
using Scyzoryk.DocumentEngine.OpenXml;

namespace Scyzoryk.DocumentEngine.Merge;

// Kolejnosc "historii" (stories) dokumentu, w jakiej stara sciezka Word COM
// przechodzila tresc przy podmianie pol/znacznikow:
//   1) glowny tekst (bez textboxow),
//   2) textboxy zakotwiczone w glownym tekscie (Word COM: $doc.Shapes),
//   3) naglowki/stopki/przypisy - stara sciezka ich NIE obslugiwala (znany
//      blad StoryRanges.NextStoryRange, patrz lib/wordSmartTemplate.ps1);
//      nowa sciezka je obsluguje, na koncu, zeby numeracja "N-te wystapienie"
//      w glownym tekscie zostala identyczna jak dotad.
//
// mc:AlternateContent: nowoczesny textbox (DrawingML) jest zapisany DWA razy -
// w mc:Choice (wps:txbx) i w mc:Fallback (stary VML). Renderer i Word pokazuja
// Choice, wiec licznik wystapien liczy tylko Choice; Fallback dostaje te same
// podmiany "wszystkich wystapien", zeby obie kopie nie rozjechaly sie tresciowo.
public static class DocumentStories
{
    public sealed record StoryParagraph(Paragraph Paragraph, bool IsFallbackCopy, string Story);

    public static List<StoryParagraph> OrderedParagraphs(WordprocessingDocument doc)
    {
        var result = new List<StoryParagraph>();
        var parts = PackageWalker.EnumerateParts(doc);

        var main = parts.FirstOrDefault(p => p.ContainerHint == "main");
        if (main is not null)
        {
            var all = main.Root.Descendants<Paragraph>().ToList();
            foreach (var p in all.Where(p => !IsInTextBox(p))) result.Add(new StoryParagraph(p, false, "main"));
            foreach (var p in all.Where(IsInTextBox)) result.Add(new StoryParagraph(p, IsInFallback(p), "textbox"));
        }

        foreach (var part in parts.Where(p => p.ContainerHint != "main"))
        {
            foreach (var p in part.Root.Descendants<Paragraph>())
                result.Add(new StoryParagraph(p, IsInFallback(p), part.ContainerHint));
        }

        return result;
    }

    // Tylko glowny tekst (bez textboxow) - odpowiednik Word COM
    // Document.Range()/Document.Tables uzywanych przez heurystyki legacy.
    public static List<Paragraph> MainStoryParagraphs(WordprocessingDocument doc)
    {
        var body = doc.MainDocumentPart?.Document?.Body;
        if (body is null) return new List<Paragraph>();
        return body.Descendants<Paragraph>().Where(p => !IsInTextBox(p)).ToList();
    }

    public static bool IsInTextBox(OpenXmlElement e) =>
        e.Ancestors<TextBoxContent>().Any() || e.Ancestors().Any(a => a.LocalName == "txbxContent");

    public static bool IsInFallback(OpenXmlElement e) =>
        e.Ancestors().Any(a => a.LocalName == "Fallback" && a.NamespaceUri == "http://schemas.openxmlformats.org/markup-compatibility/2006");

    public static TableCell? NearestCell(OpenXmlElement e)
    {
        for (var p = e.Parent; p is not null; p = p.Parent)
        {
            if (p is TableCell c) return c;
            if (p.LocalName == "txbxContent") return null;
        }
        return null;
    }
}
