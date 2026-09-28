using DocumentFormat.OpenXml;
using DocumentFormat.OpenXml.Packaging;
using DocumentFormat.OpenXml.Wordprocessing;
using Scyzoryk.DocumentEngine.OpenXml;

namespace Scyzoryk.DocumentEngine.Merge;

// Replace-AllMergeFields (mailmerge-to-pdf.ps1) bez Worda: kazde pole
// MERGEFIELD dostaje wartosc z rekordu (Get-RecordValue) i jest "odlaczane"
// (zostaje zwykly tekst). Pole galerii Zdjecia_pomontazowe jest pomijane -
// obsluguje je wczesniej PhotoGallery.
public static class MergeFieldReplacer
{
    public sealed record FieldDebug(string Field, string Value);

    public static List<FieldDebug> ReplaceAll(WordprocessingDocument doc, IReadOnlyList<KeyValuePair<string, string>> record)
    {
        var debug = new List<FieldDebug>();
        foreach (var part in PackageWalker.EnumerateParts(doc))
        {
            foreach (var field in FieldParser.ParseComplexFields(part.Root))
            {
                if (field.BeginRun.Parent is null) continue; // usuniete razem z innym polem
                var name = FieldParser.MergeFieldName(field.Instruction.ToString());
                if (string.IsNullOrWhiteSpace(name) || PhotoGallery.IsGalleryFieldName(name)) continue;
                var value = TextNormalize.GetRecordValue(record, name);
                debug.Add(new FieldDebug(name, value));
                FieldParser.ReplaceComplexField(field, FieldParser.MakeTextRuns(value, FieldParser.ResultFormatting(field)));
            }

            foreach (var simple in part.Root.Descendants<SimpleField>().ToList())
            {
                if (simple.Parent is null) continue;
                var name = FieldParser.MergeFieldName(simple.Instruction?.Value ?? "");
                if (string.IsNullOrWhiteSpace(name) || PhotoGallery.IsGalleryFieldName(name)) continue;
                var value = TextNormalize.GetRecordValue(record, name);
                debug.Add(new FieldDebug(name, value));
                var props = simple.Descendants<Run>().FirstOrDefault()?.RunProperties?.CloneNode(true) as RunProperties;
                foreach (var r in FieldParser.MakeTextRuns(value, props)) simple.InsertBeforeSelf(r);
                simple.Remove();
            }
        }
        return debug;
    }
}
