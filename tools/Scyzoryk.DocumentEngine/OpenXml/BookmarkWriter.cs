using DocumentFormat.OpenXml;
using DocumentFormat.OpenXml.Packaging;
using DocumentFormat.OpenXml.Wordprocessing;

namespace Scyzoryk.DocumentEngine.OpenXml;

// Tworzy bookmarkStart/bookmarkEnd (smart block, sekcja 11) - zachowuje
// istniejacy format nazw (SCYB_<hex>, generowany po stronie serwera bez
// zmian). Kazdy bookmark w calym dokumencie musi miec UNIKALNE numeryczne
// Id (schemat OOXML tego wymaga) - GetNextBookmarkId przegląda WSZYSTKIE
// czesci pakietu, nie tylko biezaca, zeby nigdy nie zderzyc sie z istniejacym.
public static class BookmarkWriter
{
    public static int GetNextBookmarkId(WordprocessingDocument doc)
    {
        var max = 0;
        foreach (var part in PackageWalker.EnumerateParts(doc))
        {
            foreach (var bookmarkStart in part.Root.Descendants<BookmarkStart>())
            {
                if (int.TryParse(bookmarkStart.Id?.Value, out var id) && id > max) max = id;
            }
        }
        return max + 1;
    }

    // firstContainer/lastContainer musza byc RODZENSTWEM (tym samym rodzicem)
    // - to jest jedyny bezpieczny przypadek do owiniecia bookmarkiem bez
    // ryzyka uszkodzenia struktury (sekcja 11: "jesli blok obejmuje strukture,
    // ktorej nie da sie bezpiecznie objac bookmarkiem, zablokuj build
    // czytelnym bledem zamiast produkowac uszkodzony DOCX"). Wywolujacy
    // (BuildTemplateCommand) ma to zweryfikowac PRZED wywolaniem.
    public static void WrapInBookmark(OpenXmlElement firstContainer, OpenXmlElement lastContainer, string bookmarkName, int bookmarkId)
    {
        if (firstContainer.Parent is null || !ReferenceEquals(firstContainer.Parent, lastContainer.Parent))
        {
            throw new InvalidOperationException(
                $"Blok '{bookmarkName}' laczy fragmenty, ktorych nie da sie bezpiecznie objac jednym bookmarkiem (rozne kontenery nadrzedne) - popraw konfiguracje bloku przed buildem.");
        }

        var start = new BookmarkStart { Id = bookmarkId.ToString(), Name = bookmarkName };
        var end = new BookmarkEnd { Id = bookmarkId.ToString() };
        firstContainer.InsertBeforeSelf(start);
        lastContainer.InsertAfterSelf(end);
    }
}
