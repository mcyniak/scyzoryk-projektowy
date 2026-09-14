using DocumentFormat.OpenXml;
using DocumentFormat.OpenXml.Wordprocessing;

namespace Scyzoryk.DocumentEngine.OpenXml;

// Podmiana tresci kandydata (STALE) i czyszczenie roboczego oznaczenia
// (sekcja 9/10 promptu migracji) - dziala BEZPOSREDNIO na wezlach
// OpenXmlElement zebranych przez MarkScanner w TEJ SAMEJ sesji, bez zadnej
// arytmetyki pozycji (przeciwienstwo Word COM Range.Start/End).
public static class TextReplacer
{
    // Zastepuje CALA zawartosc kandydata (region.ContentRuns) JEDNYM nowym
    // runem z podana trescia, zachowujac formatowanie PIERWSZEGO runu
    // (sekcja 10: "Wynik ma zachowac formatting target run"). Po wywolaniu
    // region.ContentRuns wskazuje na TEN JEDEN nowy run - ClearMark dziala
    // na nim dalej normalnie.
    public static Run ReplaceWithConstant(MarkRegion region, string newText)
    {
        if (region.ContentRuns.Count == 0)
            throw new InvalidOperationException($"Kandydat {region.PaletteKey}#{region.Ordinal} nie ma zadnych runow tresci.");

        var firstRun = region.ContentRuns[0];
        var keptProps = firstRun.RunProperties is { } props ? (RunProperties)props.CloneNode(true) : null;

        var newRun = new Run();
        if (keptProps is not null) newRun.RunProperties = keptProps;
        newRun.AppendChild(new Text(newText) { Space = SpaceProcessingModeValues.Preserve });

        firstRun.InsertBeforeSelf(newRun);
        foreach (var run in region.ContentRuns) run.Remove();

        region.ContentRuns = new List<Run> { newRun };
        return newRun;
    }

    // Usuwa WYLACZNIE robocze oznaczenie (highlight/shading), nigdy tresc ani
    // inne wlasciwosci formatowania - sekcja 9: "Nie ruszaj innych
    // wlasciwosci."
    public static void ClearMark(MarkRegion region)
    {
        switch (region.MarkKind)
        {
            case "highlight":
                foreach (var run in region.ContentRuns)
                    run.RunProperties?.GetFirstChild<Highlight>()?.Remove();
                break;
            case "shading-run":
                foreach (var run in region.ContentRuns)
                    run.RunProperties?.GetFirstChild<Shading>()?.Remove();
                break;
            case "shading-paragraph":
                if (region.Container is Paragraph p)
                    p.ParagraphProperties?.GetFirstChild<Shading>()?.Remove();
                break;
            case "shading-cell":
                if (region.Container is TableCell c)
                    c.TableCellProperties?.GetFirstChild<Shading>()?.Remove();
                break;
        }
    }
}
