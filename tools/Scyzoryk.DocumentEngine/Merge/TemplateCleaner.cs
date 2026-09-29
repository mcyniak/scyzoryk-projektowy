using DocumentFormat.OpenXml.Packaging;
using DocumentFormat.OpenXml.Wordprocessing;

namespace Scyzoryk.DocumentEngine.Merge;

// Remove-MailMergeFromDocx: szablon z podpietym zrodlem korespondencji
// seryjnej (w:mailMerge w settings.xml + relacje do starego Excela) jest
// czyszczony RAZ na poczatku zadania. Bez tego Word przy otwarciu probowal
// laczyc sie ze starym plikiem Excela (np. na dysku sieciowym); nowy silnik
// Worda nie uruchamia, ale gotowe DOCX-y trafiaja do ludzi, ktorzy otworza je
// w Wordzie - maja sie otwierac bez pytania o zrodlo danych.
public static class TemplateCleaner
{
    public static byte[] CleanTemplate(string templatePath, Action<string, string> log)
    {
        var bytes = File.ReadAllBytes(templatePath);
        using var ms = new MemoryStream();
        ms.Write(bytes, 0, bytes.Length);
        ms.Position = 0;
        using (var doc = WordprocessingDocument.Open(ms, true))
        {
            var settingsPart = doc.MainDocumentPart?.DocumentSettingsPart;
            if (settingsPart?.Settings is null)
            {
                log("warn", "Nie znaleziono settings.xml w szablonie.");
            }
            else
            {
                var mailMerge = settingsPart.Settings.GetFirstChild<MailMerge>();
                if (mailMerge is not null)
                {
                    mailMerge.Remove();
                    log("info", "Usunieto blok mailMerge z settings.xml.");
                }

                foreach (var rel in settingsPart.ExternalRelationships.ToList())
                {
                    if (rel.RelationshipType.Contains("mailMerge", StringComparison.OrdinalIgnoreCase))
                        settingsPart.DeleteExternalRelationship(rel);
                }
                foreach (var pair in settingsPart.Parts.ToList())
                {
                    if (pair.OpenXmlPart.RelationshipType.Contains("recipientData", StringComparison.OrdinalIgnoreCase) ||
                        pair.OpenXmlPart.RelationshipType.Contains("mailMerge", StringComparison.OrdinalIgnoreCase))
                        settingsPart.DeletePart(pair.RelationshipId);
                }
                settingsPart.Settings.Save();
            }
            ImageCompressor.Compress(doc, log);
        }
        return ms.ToArray();
    }
}
