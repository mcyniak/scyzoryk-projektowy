using DocumentFormat.OpenXml;
using DocumentFormat.OpenXml.Wordprocessing;

namespace Scyzoryk.DocumentEngine.OpenXml;

// Wstawia pole MERGEFIELD (sekcja 10 promptu migracji) jako "complex field"
// zgodny z tym, co Word sam zapisuje - bez Word COM (poprzednio
// Document.Fields.Add(range, wdFieldMergeField, name, false)). Zachowuje
// istniejacy format nazw pol (SCY_F_<hex>, generowany po stronie serwera,
// patrz apps/kreator-wzorow/src/templateManifest.js - bez zmian).
public static class FieldWriter
{
    // Zwraca run wynikowy (miedzy fldChar separate/end) - TO na nim
    // TextReplacer.ClearMark ma pozniej wyczyscic robocze oznaczenie,
    // dokladnie jak poprzednio $newField.Result w Word COM.
    public static Run InsertMergeField(MarkRegion region, string fieldName)
    {
        if (region.ContentRuns.Count == 0)
            throw new InvalidOperationException($"Kandydat {region.PaletteKey}#{region.Ordinal} nie ma zadnych runow tresci.");

        var firstRun = region.ContentRuns[0];
        var keptProps = firstRun.RunProperties is { } props ? (RunProperties)props.CloneNode(true) : null;

        var beginRun = new Run(new FieldChar { FieldCharType = FieldCharValues.Begin });
        var instrRun = new Run(new FieldCode($" MERGEFIELD {fieldName} \\* MERGEFORMAT ") { Space = SpaceProcessingModeValues.Preserve });
        var separateRun = new Run(new FieldChar { FieldCharType = FieldCharValues.Separate });

        var resultRun = new Run();
        if (keptProps is not null) resultRun.RunProperties = (RunProperties)keptProps.CloneNode(true);
        // Placeholder wyswietlany w Wordzie przed pierwszym "Update Fields" -
        // ten sam konwencjonalny zapis w gilllemetach, co Word sam generuje
        // dla nowo wstawionego, jeszcze nie przeliczonego MERGEFIELD.
        resultRun.AppendChild(new Text($"«{fieldName}»") { Space = SpaceProcessingModeValues.Preserve });

        var endRun = new Run(new FieldChar { FieldCharType = FieldCharValues.End });

        firstRun.InsertBeforeSelf(beginRun);
        beginRun.InsertAfterSelf(instrRun);
        instrRun.InsertAfterSelf(separateRun);
        separateRun.InsertAfterSelf(resultRun);
        resultRun.InsertAfterSelf(endRun);

        foreach (var run in region.ContentRuns) run.Remove();

        region.ContentRuns = new List<Run> { resultRun };
        return resultRun;
    }
}
