using System.Text;
using System.Text.Json;
using DocumentFormat.OpenXml.Packaging;
using DocumentFormat.OpenXml.Wordprocessing;
using Scyzoryk.DocumentEngine.Merge;
using Scyzoryk.DocumentEngine.Pdf;
using Scyzoryk.DocumentEngine.Wnioski;
using Xunit;

namespace Scyzoryk.DocumentEngine.Tests;

// Pokrycie migracji Word COM -> Open XML dla polecen, ktore zastapily
// usuniete skrypty PowerShell (convert-wm.ps1, mailmerge-to-pdf.ps1,
// docx-to-pdf.ps1). Bez Worda i bez ONLYOFFICE - dzialaja w CI.
public class MigrationEngineTests : IDisposable
{
    private readonly string _dir;

    public MigrationEngineTests()
    {
        _dir = Path.Combine(Path.GetTempPath(), $"scyzoryk-migration-{Guid.NewGuid():N}");
        Directory.CreateDirectory(_dir);
    }

    public void Dispose()
    {
        try { Directory.Delete(_dir, recursive: true); } catch { /* najlepszy wysilek sprzatania tmp */ }
    }

    private static byte[] BuildDocx(params string[] paragraphs)
    {
        using var ms = new MemoryStream();
        using (var doc = WordprocessingDocument.Create(ms, DocumentFormat.OpenXml.WordprocessingDocumentType.Document))
        {
            var main = doc.AddMainDocumentPart();
            main.Document = new Document(new Body());
            foreach (var text in paragraphs)
            {
                main.Document.Body!.Append(new Paragraph(new Run(new Text(text) { Space = DocumentFormat.OpenXml.SpaceProcessingModeValues.Preserve })));
            }
            main.Document.Body!.Append(new SectionProperties());
            main.Document.Save();
        }
        return ms.ToArray();
    }

    private static string BodyText(byte[] docx)
    {
        using var ms = new MemoryStream(docx);
        using var doc = WordprocessingDocument.Open(ms, false);
        return string.Join("\n", doc.MainDocumentPart!.Document.Body!.Elements<Paragraph>().Select(p => p.InnerText));
    }

    [Fact]
    public void ConvertWm_TytulUwagiDataIUsuniecieOdZatwierdzam()
    {
        var input = BuildDocx(
            "Wniosek o zatwierdzenie Materiałów / Urządzeń",
            "Uwagi: Nie dotyczy",
            "Kraków, dn. 12.03.2025",
            "Numer sprawy ZP.271.3.2025",
            "ZATWIERDZAM / ZATWIERDZAM z UWAGAMI / ODRZUCAM*",
            "Podpis inspektora");

        var (docx, report) = ConvertWmCommand.ConvertDocument(input, "30.09.2026");
        var text = BodyText(docx);

        Assert.Contains("Dokumentacja Powykonawcza", text);
        Assert.DoesNotContain("Wniosek o zatwierdzenie", text);
        Assert.Contains("Wbudowano poniższe materiały/urządzenia", text);
        Assert.Contains("dn. 30.09.2026", text);
        Assert.DoesNotContain("12.03.2025", text);
        // Regresja 2026-09-28: numer sprawy nie jest data (granice cyfr).
        Assert.Contains("ZP.271.3.2025", text);
        Assert.DoesNotContain("ZATWIERDZAM", text);
        Assert.DoesNotContain("Podpis inspektora", text);
        Assert.True(report.DeletedSection);
        Assert.Contains(report.DateReplacements, r => r.From == "12.03.2025" && r.To == "30.09.2026");
    }

    [Fact]
    public void ConvertWm_BezDaty_UsuwaDateRazemZDn()
    {
        var input = BuildDocx("Kraków, dn. 12.03.2025", "Treść wniosku");

        var (docx, report) = ConvertWmCommand.ConvertDocument(input, "");
        var text = BodyText(docx);

        Assert.DoesNotContain("12.03.2025", text);
        Assert.DoesNotContain("dn.", text);
        Assert.Contains("Kraków,", text);
        Assert.Contains("Treść wniosku", text);
        Assert.False(report.DeletedSection);
        Assert.Contains(report.DateReplacements, r => r.From == "12.03.2025" && r.To == "");
    }

    [Fact]
    public void ConvertWm_TytulWStopceTezPodmieniony()
    {
        // Realny blad z czasow Word COM: stopka zostawala ze starym tytulem.
        byte[] input;
        using (var ms = new MemoryStream())
        {
            using (var doc = WordprocessingDocument.Create(ms, DocumentFormat.OpenXml.WordprocessingDocumentType.Document))
            {
                var main = doc.AddMainDocumentPart();
                main.Document = new Document(new Body(new Paragraph(new Run(new Text("Treść")))));
                var footerPart = main.AddNewPart<FooterPart>();
                footerPart.Footer = new Footer(new Paragraph(new Run(new Text("Wniosek o zatwierdzenie Materiałów i Urządzeń"))));
                footerPart.Footer.Save();
                main.Document.Body!.Append(new SectionProperties(new FooterReference { Type = HeaderFooterValues.Default, Id = main.GetIdOfPart(footerPart) }));
                main.Document.Save();
            }
            input = ms.ToArray();
        }

        var (docx, _) = ConvertWmCommand.ConvertDocument(input, "30.09.2026");

        using var outMs = new MemoryStream(docx);
        using var outDoc = WordprocessingDocument.Open(outMs, false);
        var footerText = outDoc.MainDocumentPart!.FooterParts.Single().Footer.InnerText;
        Assert.Equal("Dokumentacja Powykonawcza", footerText);
    }

    [Fact]
    public void MailMerge_NieCzysciLoguWywolujacego_IZapisujeDocx()
    {
        var templatePath = Path.Combine(_dir, "szablon.docx");
        File.WriteAllBytes(templatePath, BuildDocx("Adres budowy: XXX"));
        var logPath = Path.Combine(_dir, "log.txt");
        var debugPath = Path.Combine(_dir, "debug-events.jsonl");
        // Paczka kilku szablonow (Dokumenty seryjne, _keepLog) i tryb "folder"
        // dopisuja kolejne szablony do tego samego logu - silnik nie moze go
        // czyscic przy starcie (kasowal diagnostyke wczesniejszych szablonow).
        File.WriteAllText(logPath, "POPRZEDNI SZABLON\n", new UTF8Encoding(false));
        File.WriteAllText(debugPath, "{\"event\":\"poprzedni\"}\n", new UTF8Encoding(false));

        var input = new MailMergeInput
        {
            TemplatePath = templatePath,
            OutputDir = Path.Combine(_dir, "wynik"),
            AddressColumn = "Adres",
            Records = JsonDocument.Parse("[{\"Adres\":\"Zażółć 1\",\"_record\":2}]").RootElement,
            Rules = new() { new MailMergeInput.RuleDto { Find = "XXX", Column = "Adres" } },
            SaveWord = true,
            SavePdf = false,
            LogPath = logPath,
            DebugJsonPath = debugPath,
        };
        using var stdout = new StringWriter();
        var result = new MailMergeCommand(input, stdout).Run();

        Assert.True(result["ok"]!.GetValue<bool>(), result.ToJsonString());
        Assert.StartsWith("POPRZEDNI SZABLON", File.ReadAllText(logPath));
        Assert.StartsWith("{\"event\":\"poprzedni\"}", File.ReadAllText(debugPath));
        var docxPath = result["created"]!.AsArray().Single()!["path"]!.GetValue<string>();
        Assert.Contains("Zażółć 1", Path.GetFileName(docxPath));
        Assert.Contains("Adres budowy: Zażółć 1", BodyText(File.ReadAllBytes(docxPath)));
    }

    [Fact]
    public void Paleta_KolorTylkoWNaglowkuTabeli_NieJestDomyslnieZaznaczony()
    {
        static TableCell Cell(string text, string? fill)
        {
            var cell = new TableCell();
            if (fill is not null) cell.Append(new TableCellProperties(new Shading { Val = ShadingPatternValues.Clear, Color = "auto", Fill = fill }));
            cell.Append(new Paragraph(new Run(new Text(text))));
            return cell;
        }
        var path = Path.Combine(_dir, "paleta.docx");
        using (var doc = WordprocessingDocument.Create(path, DocumentFormat.OpenXml.WordprocessingDocumentType.Document))
        {
            var main = doc.AddMainDocumentPart();
            var table = new Table(
                new TableRow(Cell("Pozycja", "D9E2F3"), Cell("Wartość", "D9E2F3")),
                new TableRow(Cell("Uczestnik projektu:", null), Cell("Jan Kowalski", "FFE599")),
                new TableRow(Cell("Falownik:", null), Cell("SE5K", "FFE599")));
            // Kolor danych, ktory WYSTEPUJE TEZ w naglowku - nadal proponowany.
            var table2 = new Table(
                new TableRow(Cell("Moc", "C6E0B4"), Cell("Typ", null)),
                new TableRow(Cell("5,4", "C6E0B4"), Cell("x", null)));
            main.Document = new Document(new Body(table, table2, new Paragraph(new Run(new Text("koniec"))), new SectionProperties()));
            main.Document.Save();
        }
        using var read = WordprocessingDocument.Open(path, false);
        var palette = Scyzoryk.DocumentEngine.OpenXml.PaletteScanner.ScanPalette(read).ToDictionary(p => p.Key);
        Assert.False(palette["shading:D9E2F3"].Suggested);
        Assert.Equal(2, palette["shading:D9E2F3"].HeaderRowCount);
        Assert.True(palette["shading:FFE599"].Suggested);
        Assert.True(palette["shading:C6E0B4"].Suggested);
    }

    [Fact]
    public void PdfRenderer_OnlyOfficeZJawnegoKatalogu_WordTylkoNaZadanie()
    {
        var fakeDir = Path.Combine(_dir, "onlyoffice");
        Directory.CreateDirectory(fakeDir);
        // Katalog bez x2t.exe nie jest brany pod uwage.
        Assert.NotEqual(Path.GetFullPath(fakeDir), OnlyOfficePdfRenderer.FindDirectory(fakeDir));
        File.WriteAllBytes(Path.Combine(fakeDir, "x2t.exe"), Array.Empty<byte>());
        Assert.Equal(Path.GetFullPath(fakeDir), OnlyOfficePdfRenderer.FindDirectory(fakeDir));

        void Log(string level, string msg) { }
        using (var oo = PdfRendererFactory.Create("onlyoffice", fakeDir, Log)) Assert.Equal("onlyoffice", oo.Name);
        using (var auto = PdfRendererFactory.Create(null, fakeDir, Log)) Assert.Equal("onlyoffice", auto.Name);
        // Word startuje leniwie (dopiero przy Render) - samo utworzenie nie odpala WINWORD.EXE.
        using (var word = PdfRendererFactory.Create("word", fakeDir, Log)) Assert.Equal("word", word.Name);
    }
}
