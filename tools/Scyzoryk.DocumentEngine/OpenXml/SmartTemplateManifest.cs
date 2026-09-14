using System.Text;
using DocumentFormat.OpenXml.Packaging;

namespace Scyzoryk.DocumentEngine.OpenXml;

// Osadza manifest Smart Template jako Custom XML Part - sekcja 12 promptu
// migracji: "Zachowaj istniejacy namespace/marker manifestu" i "Uzyj Open XML
// SDK do Custom XML Parts/relationships. Nie edytuj [Content_Types].xml
// regexami, jesli SDK moze zarzadzic package." SDK samo dba o
// [Content_Types].xml i relacje OPC przy AddCustomXmlPart/FeedData - dokladnie
// tak samo bezpiecznie jak poprzednio robil to Word COM przez
// Document.CustomXMLParts.Add(...). Namespace i format CDATA MUSZA pozostac
// identyczne, bo apps/dokumenty-seryjne/src/smartTemplate.js#readSmartTemplateManifest
// czyta je wprost przez regex na surowym XML (nie przez SDK) - nie
// modyfikowane w tej migracji.
public static class SmartTemplateManifest
{
    public const string Namespace = "urn:scyzoryk:smart-template:v1";

    public static void Embed(WordprocessingDocument doc, string manifestJson)
    {
        var mainPart = doc.MainDocumentPart ?? throw new InvalidOperationException("Brak glownej czesci dokumentu.");
        // ']]>' w JSON (skrajny, teoretyczny przypadek - staly tekst
        // zawierajacy doslownie ten ciag) rozbilby CDATA - ten sam,
        // sprawdzony sposob rozdzielenia na dwie sekcje CDATA co poprzednio
        // w build-template.ps1 (Word COM).
        var safeJson = manifestJson.Replace("]]>", "]]]]><![CDATA[>");
        var xml = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>" +
                  $"<scyzoryk:smartTemplate xmlns:scyzoryk=\"{Namespace}\" version=\"1\">" +
                  $"<![CDATA[{safeJson}]]>" +
                  "</scyzoryk:smartTemplate>";

        var customXmlPart = mainPart.AddCustomXmlPart(CustomXmlPartType.CustomXml);
        using var stream = new MemoryStream(Encoding.UTF8.GetBytes(xml));
        customXmlPart.FeedData(stream);
    }
}
