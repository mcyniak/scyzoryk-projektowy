using DocumentFormat.OpenXml;
using DocumentFormat.OpenXml.Packaging;
using DocumentFormat.OpenXml.Vml;
using DocumentFormat.OpenXml.Wordprocessing;

namespace Scyzoryk.DocumentEngine.Tests.Fixtures;

// Buduje fixture DOCX WYLACZNIE przez Open XML SDK (sekcja 24 promptu
// migracji: "to ma dzialac w CI bez Microsoft Word") - zero Word/COM nawet
// przy TWORZENIU pliku testowego, w przeciwienstwie do poprzedniej generacji
// testow Kreatora (test-word-com.ps1, apps/kreator-wzorow/scripts), ktora
// wymagala zywego Worda do zbudowania wlasnego fixture'a.
public static class FixtureBuilder
{
    public static readonly string[] SelectedMarkings =
    {
        "highlight:yellow", "highlight:brightgreen",
        "shading:FFE599", "shading:C6E0B4", "shading:F4B183",
    };

    // Kolor DECORATIVE_BLUE (ADD8E6) CELOWO nie jest w SelectedMarkings -
    // to jest "niewybrany kolor", ktory ma zostac pominiety przy skanowaniu
    // kandydatow (sekcja 24).
    public static void Build(string path)
    {
        if (File.Exists(path)) File.Delete(path);
        using var doc = WordprocessingDocument.Create(path, WordprocessingDocumentType.Document);
        var mainPart = doc.AddMainDocumentPart();
        mainPart.Document = new Document();
        var body = new Body();
        mainPart.Document.Append(body);

        body.Append(HighlightParagraph("HL_YELLOW", HighlightColorValues.Yellow));
        body.Append(HighlightParagraph("HL_GREEN", HighlightColorValues.Green)); // OOXML "green" -> nasz klucz "brightgreen"
        body.Append(RunShadingParagraph("RUN_SHADING", "FFE599"));
        body.Append(ParagraphShadingParagraph("PARAGRAPH_SHADING", "C6E0B4"));
        body.Append(ParagraphShadingParagraph("DECORATIVE_BLUE", "ADD8E6"));

        var dupParagraph = new Paragraph();
        dupParagraph.Append(HighlightRun("XXX", HighlightColorValues.Yellow));
        dupParagraph.Append(PlainRun(" separator words here "));
        dupParagraph.Append(HighlightRun("XXX", HighlightColorValues.Yellow));
        body.Append(dupParagraph);

        body.Append(BuildTableWithMerges());
        body.Append(BuildTextBoxParagraph());
        body.Append(new SectionProperties());

        // Header/footer z wlasnym oznaczeniem - te same mechanizmy co main,
        // ale w OSOBNYCH czesciach pakietu (sekcja 5: "Skanuj: document,
        // headers, footers, ...").
        var headerPart = mainPart.AddNewPart<HeaderPart>();
        headerPart.Header = new Header(HighlightParagraph("HEADER_MARK", HighlightColorValues.Yellow));
        var headerRelId = mainPart.GetIdOfPart(headerPart);

        var footerPart = mainPart.AddNewPart<FooterPart>();
        footerPart.Footer = new Footer(HighlightParagraph("FOOTER_MARK", HighlightColorValues.Yellow));
        var footerRelId = mainPart.GetIdOfPart(footerPart);

        var sectPr = mainPart.Document.Body!.Elements<SectionProperties>().First();
        sectPr.Append(new HeaderReference { Type = HeaderFooterValues.Default, Id = headerRelId });
        sectPr.Append(new FooterReference { Type = HeaderFooterValues.Default, Id = footerRelId });

        mainPart.Document.Save();
    }

    private static Paragraph HighlightParagraph(string text, HighlightColorValues color)
        => new(HighlightRun(text, color));

    private static Run HighlightRun(string text, HighlightColorValues color) => new(
        new RunProperties(new Highlight { Val = color }),
        new Text(text) { Space = SpaceProcessingModeValues.Preserve });

    private static Run PlainRun(string text) => new(new Text(text) { Space = SpaceProcessingModeValues.Preserve });

    private static Paragraph RunShadingParagraph(string text, string fillHex) => new(new Run(
        new RunProperties(new Shading { Val = ShadingPatternValues.Clear, Color = "auto", Fill = fillHex }),
        new Text(text) { Space = SpaceProcessingModeValues.Preserve }));

    private static Paragraph ParagraphShadingParagraph(string text, string fillHex)
    {
        var p = new Paragraph(new ParagraphProperties(new Shading { Val = ShadingPatternValues.Clear, Color = "auto", Fill = fillHex }));
        p.Append(new Run(new Text(text) { Space = SpaceProcessingModeValues.Preserve }));
        return p;
    }

    // Tabela 3x2: (1,1) shaded "CELL_SHADING", pionowe scalenie kolumny 1
    // wierszy 2-3 (vMerge), poziome scalenie wiersza 3 (gridSpan) - sekcja 23:
    // "vMerge nietkniete, gridSpan nietkniete, tabela otwiera sie bez repair".
    private static Table BuildTableWithMerges()
    {
        var table = new Table();
        table.Append(new TableProperties());
        table.Append(new TableGrid(new GridColumn(), new GridColumn()));

        var row1 = new TableRow();
        var cell11 = new TableCell(
            new TableCellProperties(new Shading { Val = ShadingPatternValues.Clear, Color = "auto", Fill = "F4B183" }),
            new Paragraph(new Run(new Text("CELL_SHADING") { Space = SpaceProcessingModeValues.Preserve })));
        var cell12 = new TableCell(new Paragraph(new Run(new Text("plain cell") { Space = SpaceProcessingModeValues.Preserve })));
        row1.Append(cell11, cell12);

        var row2 = new TableRow();
        var cell21 = new TableCell(
            new TableCellProperties(new VerticalMerge { Val = MergedCellValues.Restart }),
            new Paragraph(new Run(new Text("merge_top") { Space = SpaceProcessingModeValues.Preserve })));
        var cell22 = new TableCell(new Paragraph(new Run(new Text("row2col2") { Space = SpaceProcessingModeValues.Preserve })));
        row2.Append(cell21, cell22);

        var row3 = new TableRow();
        var cell31 = new TableCell(
            new TableCellProperties(new VerticalMerge()),
            new Paragraph(new Run(new Text("merge_bottom") { Space = SpaceProcessingModeValues.Preserve })));
        row3.Append(cell31);

        table.Append(row1, row2, row3);
        return table;
    }

    // Textbox jako VML (w:pict/v:shape/v:textbox/w:txbxContent) - prostszy do
    // zbudowania recznie niz wspolczesny DrawingML (wp:anchor/a:graphic/
    // wps:txbx), a MarkScanner traktuje w:txbxContent identycznie niezaleznie
    // od opakowania (patrz PackageWalker/MarkScanner - Descendants<Paragraph>()
    // schodzi w glab bez rozroznienia VML/DrawingML). DrawingML NIE jest
    // osobno pokryty tym fixture'em - patrz raport koncowy, sekcja "pozostale
    // luki".
    private static Paragraph BuildTextBoxParagraph()
    {
        var txbxContent = new TextBoxContent(HighlightParagraph("TEXTBOX_MARK", HighlightColorValues.Yellow));
        var textBox = new TextBox { Id = "1" };
        textBox.Append(txbxContent);
        var shape = new Shape { Id = "textbox_1", Style = "width:100pt;height:50pt" };
        shape.Append(textBox);
        var pict = new Picture();
        pict.Append(shape);
        var run = new Run();
        run.Append(pict);
        return new Paragraph(run);
    }
}
