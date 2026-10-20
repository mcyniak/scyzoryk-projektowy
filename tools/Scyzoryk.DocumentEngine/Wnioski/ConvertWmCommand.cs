using System.Text;
using System.Text.RegularExpressions;
using DocumentFormat.OpenXml;
using DocumentFormat.OpenXml.Packaging;
using DocumentFormat.OpenXml.Wordprocessing;
using Scyzoryk.DocumentEngine.Merge;
using Scyzoryk.DocumentEngine.Pdf;

namespace Scyzoryk.DocumentEngine.Wnioski;

// Nastepca apps/wnioski-powykonawcze/scripts/convert-wm.ps1 (Word COM):
// "Wniosek o zatwierdzenie materialow" -> "Dokumentacja powykonawcza".
// Te same kroki i ta sama kolejnosc co w PowerShell:
//   1) tytul (wszystkie historie: tekst, naglowki, stopki, textboxy),
//   2) "Uwagi"/"Nie dotyczy"/"wnioskuje o zgode..." (tylko glowny tekst),
//   3) usuniecie od "ZATWIERDZAM / ..." do konca dokumentu,
//   4) daty -> jedna podana data (albo usuniecie dat przy "Bez daty").
// Wejscie/wyjscie JSON identyczne jak dotad, wiec server.js zmienia tylko
// uruchamiany proces.
public sealed class ConvertWmInput
{
    public string? DateText { get; set; }
    public bool SaveDocx { get; set; }
    public List<FileItem> Files { get; set; } = new();
    public string? PdfRenderer { get; set; }
    public string? OnlyOfficeDir { get; set; }

    public sealed class FileItem
    {
        public string InputPath { get; set; } = "";
        public string? OriginalName { get; set; }
        public string PdfPath { get; set; } = "";
        public string? DocxPath { get; set; }
    }
}

public sealed class ConvertWmOutput
{
    public bool Ok { get; set; }
    public string? Error { get; set; }
    public string? Renderer { get; set; }
    public List<Dictionary<string, object?>> Results { get; set; } = new();
}

public static class ConvertWmCommand
{
    // Teksty zakodowane base64 (UTF-8) - skopiowane 1:1 z convert-wm.ps1, zeby
    // polskie znaki nie zalezaly od kodowania pliku zrodlowego.
    private static string D(string b64) => Encoding.UTF8.GetString(Convert.FromBase64String(b64));
    private static readonly string Title1 = D("V25pb3NlayBvIHphdHdpZXJkemVuaWUgTWF0ZXJpYcWCw7N3IC8gVXJ6xIVkemXFhA==");
    private static readonly string Title2 = D("V25pb3NlayBvIHphdHdpZXJkemVuaWUgTWF0ZXJpYcWCw7N3L1VyesSFZHplxYQ=");
    private static readonly string Title3 = D("V25pb3NlayBvIHphdHdpZXJkemVuaWUgTWF0ZXJpYcWCw7N3IGkgVXJ6xIVkemXFhA==");
    private static readonly string Pow = D("RG9rdW1lbnRhY2phIFBvd3lrb25hd2N6YQ==");
    private static readonly string UwagiNd = D("VXdhZ2k6IE5pZSBkb3R5Y3p5");
    private static readonly string Wbud = D("V2J1ZG93YW5vIHBvbmnFvHN6ZSBtYXRlcmlhxYJ5L3VyesSFZHplbmlh");
    private static readonly string Uwagi = D("VXdhZ2k6");
    private static readonly string Nd = D("TmllIGRvdHljenk=");
    private static readonly string Wn1 = D("d25pb3NrdWrEmSBvIHpnb2TEmSBuYSB6YW3Ds3dpZW5pZSB3L3cgTWF0ZXJpYcWCw7N3");
    private static readonly string Wn2 = D("d25pb3NrdWplIG8gemdvZMSZIG5hIHphbcOzd2llbmllIHcvdyBNYXRlcmlhxYLDs3c=");
    private static readonly string Wn3 = D("d25pb3NrdWrEmSBvIHpnb2TEmSBuYSB6YW3Ds3dpZW5pZSB3L3cgTWF0ZXJpYcWCw7N3ICA=");
    private static readonly string Mark1 = D("WkFUV0lFUkRaQU0gLyBaQVRXSUVSRFpBTSB6IFVXQUdBTUkgLyBPRFJaVUNBTSo=");
    private static readonly string Mark2 = D("WkFUV0lFUkRaQU0gLyBaQVRXSUVSRFpBTSB6IFVXQUdBTUkgLyBPRFJaVUNBTQ==");
    private static readonly string Mark3 = D("U3R3aWVyZHphbSwgacW8IHcvdw==");

    private static readonly Regex DateRe = new(@"(?<!\d)([0-3]?\d[\.\-/][01]?\d[\.\-/](?:19|20)\d{2})(?!\d)", RegexOptions.Compiled);
    // Tryb "Bez daty": [separator] [dnia|dn.] DATA [r.|r|roku]. Separator i slowo
    // sa opcjonalne (data w osobnej komorce tabeli tez znika).
    private static readonly Regex NoDateRe = new(
        @"(?:[ \t ]*[,.]?[ \t ]*\b(?:dnia|dn\.?)[ \t ]*)?(?<!\d)[0-3]?\d[\.\-/][01]?\d[\.\-/](?:19|20)\d{2}(?!\d)(?:[ \t ]*(?:roku\b|r\.|r(?![\p{L}\d])))?",
        RegexOptions.Compiled | RegexOptions.IgnoreCase);
    // Odpowiedniki wildcardow Worda z convert-wm.ps1 ([0-9]{1,2}.[0-9]{1,2}.[0-9]{4} itd.).
    // Granice cyfr (?<!\d)/(?!\d) konieczne: bez nich numer sprawy
    // "ZP.271.3.2025" byl brany za date "71.3.2025" (zlapane porownaniem z
    // wynikiem Worda na prawdziwym WM, 2026-09-28 - Word go nie ruszal).
    private static readonly Regex[] FallbackDatePatterns =
    {
        new(@"(?<!\d)\d{1,2}\.\d{1,2}\.\d{4}(?!\d)", RegexOptions.Compiled),
        new(@"(?<!\d)\d{1,2}/\d{1,2}/\d{4}(?!\d)", RegexOptions.Compiled),
    };

    public static ConvertWmOutput Run(ConvertWmInput input)
    {
        var output = new ConvertWmOutput { Ok = true };
        void Log(string level, string msg) => Console.Error.WriteLine($"[{level}] {msg}");
        using var renderer = PdfRendererFactory.Create(input.PdfRenderer, input.OnlyOfficeDir, Log);
        output.Renderer = renderer.Name;

        foreach (var item in input.Files)
        {
            try
            {
                if (!File.Exists(item.InputPath)) throw new FileNotFoundException($"Nie znaleziono pliku DOCX: {item.InputPath}");
                var (bytes, report) = ConvertDocument(File.ReadAllBytes(item.InputPath), input.DateText ?? "");

                string? savedDocx = null;
                if (input.SaveDocx && !string.IsNullOrWhiteSpace(item.DocxPath))
                {
                    File.WriteAllBytes(item.DocxPath, bytes);
                    savedDocx = item.DocxPath;
                }
                renderer.Render(bytes, item.PdfPath);

                output.Results.Add(new Dictionary<string, object?>
                {
                    ["ok"] = true,
                    ["input"] = item.InputPath,
                    ["pdf"] = item.PdfPath,
                    ["file"] = Path.GetFileName(item.PdfPath),
                    ["docx"] = savedDocx,
                    ["deletedSection"] = report.DeletedSection,
                    ["deletedCharCount"] = report.DeletedCharCount,
                    ["deletedPreview"] = report.DeletedPreview,
                    ["dateReplacements"] = report.DateReplacements.Select(r => new Dictionary<string, string> { ["from"] = r.From, ["to"] = r.To }).ToList(),
                });
            }
            catch (Exception ex)
            {
                output.Results.Add(new Dictionary<string, object?> { ["ok"] = false, ["input"] = item.InputPath, ["error"] = ex.Message });
            }
        }
        return output;
    }

    public sealed record Report(bool DeletedSection, int DeletedCharCount, string DeletedPreview, List<(string From, string To)> DateReplacements);

    public static (byte[] Docx, Report Report) ConvertDocument(byte[] input, string dateText)
    {
        using var ms = new MemoryStream();
        ms.Write(input, 0, input.Length);
        ms.Position = 0;
        Report report;
        using (var doc = WordprocessingDocument.Open(ms, true))
        {
            var all = DocumentStories.OrderedParagraphs(doc);
            var mainOnly = all.Where(p => p.Story == "main").ToList();

            TextMarkerReplacer.ReplaceEverywhere(all, Title1, Pow, 0);
            TextMarkerReplacer.ReplaceEverywhere(all, Title2, Pow, 0);
            TextMarkerReplacer.ReplaceEverywhere(all, Title3, Pow, 0);

            TextMarkerReplacer.ReplaceEverywhere(mainOnly, UwagiNd, Wbud, 0);
            TextMarkerReplacer.ReplaceEverywhere(mainOnly, Uwagi, Wbud, 0);
            TextMarkerReplacer.ReplaceEverywhere(mainOnly, Nd, "", 0);
            TextMarkerReplacer.ReplaceEverywhere(mainOnly, Wn1, "", 0);
            TextMarkerReplacer.ReplaceEverywhere(mainOnly, Wn2, "", 0);
            TextMarkerReplacer.ReplaceEverywhere(mainOnly, Wn3, "", 0);

            var deletion = DeleteFromMarkerToEnd(doc, Mark1);
            if (!deletion.Deleted) deletion = DeleteFromMarkerToEnd(doc, Mark2);
            if (!deletion.Deleted) deletion = DeleteFromMarkerToEnd(doc, Mark3);

            // Po usunieciu czesci dokumentu lista akapitow jest nieaktualna.
            all = DocumentStories.OrderedParagraphs(doc);
            var dates = ReplaceAllDates(all, dateText);

            report = new Report(deletion.Deleted, deletion.CharCount, deletion.Preview, dates);
            doc.MainDocumentPart!.Document.Save();
        }
        return (ms.ToArray(), report);
    }

    public static List<string> CollectDateTexts(List<DocumentStories.StoryParagraph> paragraphs)
    {
        var set = new List<string>();
        foreach (var sp in paragraphs.Where(p => !p.IsFallbackCopy))
        {
            var text = ParagraphText.Build(sp.Paragraph).Text;
            foreach (Match m in DateRe.Matches(text))
            {
                if (!set.Contains(m.Value, StringComparer.OrdinalIgnoreCase)) set.Add(m.Value);
            }
        }
        return set;
    }

    private static List<(string From, string To)> ReplaceAllDates(List<DocumentStories.StoryParagraph> all, string dateText)
    {
        var replacements = new List<(string From, string To)>();
        var dates = CollectDateTexts(all);

        if (string.IsNullOrWhiteSpace(dateText))
        {
            // "Bez daty": data znika razem ze slowem "dnia"/"dn." przed nia, separatorem
            // przed tym slowem i dopiskiem "r."/"roku" po niej. Realny wzor WM:
            // "Kudrowice. dn. 12.05.2026r." -> "Kudrowice" (wczesniej zostawalo
            // "Kudrowice.r." - audyt 2026-10-20).
            foreach (var sp in all)
            {
                if (sp.Paragraph.Parent is null) continue;
                var model = ParagraphText.Build(sp.Paragraph);
                var matches = NoDateRe.Matches(model.Text).Cast<Match>().OrderByDescending(m => m.Index).ToList();
                foreach (var m in matches) model.ReplaceRange(m.Index, m.Length, "");
            }
            foreach (var oldDate in dates) replacements.Add((oldDate, ""));
            return replacements;
        }

        foreach (var oldDate in dates)
        {
            if (oldDate == dateText) continue;
            TextMarkerReplacer.ReplaceEverywhere(all, oldDate, dateText, 0);
            replacements.Add((oldDate, dateText));
        }

        // Fallback jak wildcardy Worda: inne zapisy dat niz zlapane regexem wyzej.
        foreach (var re in FallbackDatePatterns)
        {
            foreach (var sp in all)
            {
                if (sp.Paragraph.Parent is null) continue;
                var model = ParagraphText.Build(sp.Paragraph);
                var matches = re.Matches(model.Text).Cast<Match>().Where(m => m.Value != dateText).OrderByDescending(m => m.Index).ToList();
                foreach (var m in matches) model.ReplaceRange(m.Index, m.Length, dateText);
            }
        }
        return replacements;
    }

    public sealed record Deletion(bool Deleted, int CharCount, string Preview);

    // Delete-FromMarkerToEnd: od (pierwszego) znacznika w glownym tekscie do
    // konca dokumentu. Word Range.Delete: tresc znika, struktura sekcji zostaje.
    public static Deletion DeleteFromMarkerToEnd(WordprocessingDocument doc, string marker)
    {
        var body = doc.MainDocumentPart?.Document?.Body;
        if (body is null) return new Deletion(false, 0, "");
        var paragraphs = DocumentStories.MainStoryParagraphs(doc);

        for (var pi = 0; pi < paragraphs.Count; pi++)
        {
            var model = ParagraphText.Build(paragraphs[pi]);
            var idx = model.Text.IndexOf(marker, StringComparison.OrdinalIgnoreCase);
            if (idx < 0) continue;

            // Tekst usuwanego fragmentu (licznik + podglad dla uzytkownika).
            var sb = new StringBuilder(model.Text[idx..]);
            for (var pj = pi + 1; pj < paragraphs.Count; pj++) sb.Append('\r').Append(ParagraphText.Build(paragraphs[pj]).Text);
            var deletedText = sb.ToString();
            var preview = Regex.Replace(deletedText[..Math.Min(200, deletedText.Length)], "[\r\v\f]", " ").Trim();

            var start = paragraphs[pi];
            model.ReplaceRange(idx, model.Text.Length - idx, "");
            RemoveEverythingAfter(start, body);
            return new Deletion(true, deletedText.Length, preview);
        }
        return new Deletion(false, 0, "");
    }

    private static void RemoveEverythingAfter(Paragraph start, Body body)
    {
        OpenXmlElement current = start;
        while (!ReferenceEquals(current.Parent, body) && current.Parent is not null)
        {
            var parent = current.Parent;
            var sib = current.NextSibling();
            while (sib is not null)
            {
                var next = sib.NextSibling();
                switch (sib)
                {
                    case TableCell cell:
                        // Kolejne komorki tego samego wiersza: czyscimy tresc,
                        // ale komorki zostaja (usuniecie rozwaliloby siatke tabeli).
                        foreach (var child in cell.ChildElements.Where(c => c is not TableCellProperties).ToList()) child.Remove();
                        cell.AppendChild(new Paragraph());
                        break;
                    case TableCellProperties or TableRowProperties or TableProperties or TableGrid:
                        break;
                    default:
                        sib.Remove();
                        break;
                }
                sib = next;
            }
            current = parent;
        }

        var after = current.NextSibling();
        while (after is not null)
        {
            var next = after.NextSibling();
            if (after is not SectionProperties) after.Remove();
            after = next;
        }

        // Komorka tabeli musi miec co najmniej jeden akapit; dokument musi
        // konczyc sie akapitem (nie tabela) - Word sam dopisuje pusty akapit.
        if (body.Elements().LastOrDefault(e => e is not SectionProperties) is Table)
        {
            var sect = body.GetFirstChild<SectionProperties>();
            if (sect is not null) sect.InsertBeforeSelf(new Paragraph());
            else body.AppendChild(new Paragraph());
        }
    }
}
