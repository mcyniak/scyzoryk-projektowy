using DocumentFormat.OpenXml;
using DocumentFormat.OpenXml.Wordprocessing;

namespace Scyzoryk.DocumentEngine.OpenXml;

// Model wewnetrzny (NIGDY nie serializowany 1:1 do JSON - patrz Commands/Dtos.cs
// dla ksztaltu wymienianego z Node) uzywany zarowno przy skanowaniu jak i przy
// buildzie. W przeciwienstwie do Word COM (gdzie kandydat byl para Range.Start/
// End wymagajaca pozniejszej, zawodnej rekonstrukcji - patrz audyt 2026-09-10),
// tu Container/ContentRuns sa BEZPOSREDNIMI referencjami do wezlow OpenXmlElement
// w drzewie DOM biezacej sesji - build po prostu mutuje je wprost, bez zadnej
// arytmetyki pozycji.
public sealed class MarkRegion
{
    public string PartUri { get; set; } = "";
    public string ContainerKind { get; set; } = ""; // paragraph | tableCell | textbox
    public string MarkKind { get; set; } = ""; // highlight | shading-run | shading-paragraph | shading-cell
    public string PaletteKey { get; set; } = "";
    public string RawColor { get; set; } = "";
    public string DisplayColor { get; set; } = "";
    public string StructuralPath { get; set; } = "";
    public int Ordinal { get; set; }
    public string Text { get; set; } = "";
    public string Before { get; set; } = "";
    public string After { get; set; } = "";
    public string Fingerprint { get; set; } = "";

    // Kontekst strukturalny dla auto-konfiguracji Kreatora - patrz komentarz
    // przy tych samych polach w Commands/Dtos.cs#CandidateDto.
    public string ParagraphText { get; set; } = "";
    public string ParagraphPrefix { get; set; } = "";
    public string ParagraphSuffix { get; set; } = "";
    public string TableRowText { get; set; } = "";
    public string LeftCellText { get; set; } = "";
    public string RightCellText { get; set; } = "";

    // Wylacznie do uzytku WEWNATRZ jednej sesji builda - nigdy nie
    // serializowane, nigdy nie przekazywane miedzy procesami.
    public OpenXmlElement? Container { get; set; } // Paragraph albo TableCell
    public List<Run> ContentRuns { get; set; } = new();
}
