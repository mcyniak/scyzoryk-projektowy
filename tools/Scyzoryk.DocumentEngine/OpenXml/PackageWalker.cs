using DocumentFormat.OpenXml;
using DocumentFormat.OpenXml.Packaging;
using DocumentFormat.OpenXml.Wordprocessing;

namespace Scyzoryk.DocumentEngine.OpenXml;

// Enumeruje CZESCI dokumentu, ktore realnie moga zawierac tekst uzytkownika,
// w STABILNEJ, deterministycznej kolejnosci (potrzebnej do przypisywania
// ordinal - musi byc identyczna miedzy skanem a buildem dla niezmienionego
// pliku). Zamiast Word COM StoryRanges (ktore mialo udokumentowany problem:
// NextStoryRange nie laczy roznych typow story) - to jest zwykla iteracja po
// czesciach pakietu OPC, bez zadnych ukrytych niespodzianek.
//
// Textboxy (VML i DrawingML) NIE potrzebuja osobnej sciezki jak w Word COM
// (Shapes collection, TextFrame.HasText itd.) - <w:txbxContent> to zwykly
// element wewnatrz document.xml/headerN.xml/footerN.xml, wiec zwykle
// Descendants<Paragraph>() na korzeniu czesci naturalnie schodzi w glab i go
// znajduje. PackageWalker zwraca tylko KORZENIE czesci - to MarkScanner
// odpowiada za rekursywne wejscie w tresc textboxow.
public static class PackageWalker
{
    public sealed record DocumentPart(string PartUri, OpenXmlPartRootElement Root, string ContainerHint);

    public static List<DocumentPart> EnumerateParts(WordprocessingDocument doc)
    {
        var parts = new List<DocumentPart>();
        var mainPart = doc.MainDocumentPart ?? throw new InvalidOperationException("Dokument nie ma glownej czesci (MainDocumentPart) - plik moze byc uszkodzony.");

        if (mainPart.Document is not null)
        {
            parts.Add(new DocumentPart(GetPartUri(mainPart), mainPart.Document, "main"));
        }

        // Naglowki/stopki w stabilnej kolejnosci wg URI (deterministyczne,
        // niezalezne od kolejnosci wewnetrznych relacji OPC).
        foreach (var headerPart in mainPart.HeaderParts.OrderBy(GetPartUri, StringComparer.Ordinal))
        {
            if (headerPart.Header is not null)
                parts.Add(new DocumentPart(GetPartUri(headerPart), headerPart.Header, "header"));
        }
        foreach (var footerPart in mainPart.FooterParts.OrderBy(GetPartUri, StringComparer.Ordinal))
        {
            if (footerPart.Footer is not null)
                parts.Add(new DocumentPart(GetPartUri(footerPart), footerPart.Footer, "footer"));
        }

        if (mainPart.FootnotesPart?.Footnotes is not null)
            parts.Add(new DocumentPart(GetPartUri(mainPart.FootnotesPart), mainPart.FootnotesPart.Footnotes, "footnotes"));
        if (mainPart.EndnotesPart?.Endnotes is not null)
            parts.Add(new DocumentPart(GetPartUri(mainPart.EndnotesPart), mainPart.EndnotesPart.Endnotes, "endnotes"));
        if (mainPart.WordprocessingCommentsPart?.Comments is not null)
            parts.Add(new DocumentPart(GetPartUri(mainPart.WordprocessingCommentsPart), mainPart.WordprocessingCommentsPart.Comments, "comments"));

        return parts;
    }

    public static string GetPartUri(OpenXmlPart part) => part.Uri.ToString();
}
