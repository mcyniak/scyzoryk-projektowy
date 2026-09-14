using System.Text.Json.Serialization;

namespace Scyzoryk.DocumentEngine.Commands;

// Ksztalt wymieniany z Node (lib/documentEngine.js) przez pliki JSON UTF-8 bez
// BOM (sekcja 2 promptu migracji - "nie przez duze argumenty CLI"). Nazwy pol
// camelCase, zeby po stronie JS wygladalo naturalnie bez dodatkowego mapowania.

public sealed class PaletteExample
{
    [JsonPropertyName("text")] public string Text { get; set; } = "";
}

public sealed class PaletteEntryDto
{
    [JsonPropertyName("key")] public string Key { get; set; } = "";
    [JsonPropertyName("kind")] public string Kind { get; set; } = "";
    [JsonPropertyName("rawValue")] public string RawValue { get; set; } = "";
    [JsonPropertyName("displayColor")] public string DisplayColor { get; set; } = "";
    [JsonPropertyName("count")] public int Count { get; set; }
    [JsonPropertyName("examples")] public List<PaletteExample> Examples { get; set; } = new();
}

public sealed class ScanPaletteInput
{
    [JsonPropertyName("templatePath")] public string TemplatePath { get; set; } = "";
}

public sealed class ScanPaletteOutput
{
    [JsonPropertyName("ok")] public bool Ok { get; set; }
    [JsonPropertyName("message")] public string? Message { get; set; }
    [JsonPropertyName("markings")] public List<PaletteEntryDto>? Markings { get; set; }
}

public sealed class CandidateDto
{
    [JsonPropertyName("id")] public string Id { get; set; } = "";
    [JsonPropertyName("partUri")] public string PartUri { get; set; } = "";
    [JsonPropertyName("containerKind")] public string ContainerKind { get; set; } = "";
    [JsonPropertyName("markKind")] public string MarkKind { get; set; } = "";
    [JsonPropertyName("paletteKey")] public string PaletteKey { get; set; } = "";
    [JsonPropertyName("rawColor")] public string RawColor { get; set; } = "";
    [JsonPropertyName("displayColor")] public string DisplayColor { get; set; } = "";
    [JsonPropertyName("structuralPath")] public string StructuralPath { get; set; } = "";
    [JsonPropertyName("ordinal")] public int Ordinal { get; set; }
    [JsonPropertyName("text")] public string Text { get; set; } = "";
    [JsonPropertyName("before")] public string Before { get; set; } = "";
    [JsonPropertyName("after")] public string After { get; set; } = "";
    [JsonPropertyName("fingerprint")] public string Fingerprint { get; set; } = "";

    // Kontekst strukturalny dla auto-konfiguracji Kreatora (JS:
    // apps/kreator-wzorow/src/autoConfigurator.js) - liczony przez
    // MarkScanner.PopulateExtendedContext. Zawsze "" gdy nie dotyczy (np. pola
    // tabelaryczne dla kandydata spoza tabeli), nigdy null - upraszcza kod JS
    // (`if (candidate.leftCellText) {...}` bez sprawdzania null/undefined) i
    // zachowuje kompatybilnosc wsteczna ze starszymi zeskanowanymi jobami.
    [JsonPropertyName("paragraphText")] public string ParagraphText { get; set; } = "";
    [JsonPropertyName("paragraphPrefix")] public string ParagraphPrefix { get; set; } = "";
    [JsonPropertyName("paragraphSuffix")] public string ParagraphSuffix { get; set; } = "";
    [JsonPropertyName("tableRowText")] public string TableRowText { get; set; } = "";
    [JsonPropertyName("leftCellText")] public string LeftCellText { get; set; } = "";
    [JsonPropertyName("rightCellText")] public string RightCellText { get; set; } = "";
}

public sealed class ScanDiagnosticsDto
{
    [JsonPropertyName("partsScanned")] public int PartsScanned { get; set; }
    [JsonPropertyName("highlightRangesFound")] public int HighlightRangesFound { get; set; }
    [JsonPropertyName("runShadingRangesFound")] public int RunShadingRangesFound { get; set; }
    [JsonPropertyName("paragraphShadingRangesFound")] public int ParagraphShadingRangesFound { get; set; }
    [JsonPropertyName("cellShadingRangesFound")] public int CellShadingRangesFound { get; set; }
    [JsonPropertyName("selectedMarkings")] public List<string> SelectedMarkings { get; set; } = new();
}

public sealed class ScanCandidatesInput
{
    [JsonPropertyName("templatePath")] public string TemplatePath { get; set; } = "";
    [JsonPropertyName("selectedMarkings")] public List<string> SelectedMarkings { get; set; } = new();
}

public sealed class ScanCandidatesOutput
{
    [JsonPropertyName("ok")] public bool Ok { get; set; }
    [JsonPropertyName("message")] public string? Message { get; set; }
    [JsonPropertyName("candidates")] public List<CandidateDto>? Candidates { get; set; }
    [JsonPropertyName("diagnostics")] public ScanDiagnosticsDto? Diagnostics { get; set; }
}

// --- build ------------------------------------------------------------------

public sealed class CandidateDecisionDto
{
    [JsonPropertyName("status")] public string Status { get; set; } = "unresolved"; // constant | field | block | manual | unresolved
    [JsonPropertyName("constantText")] public string? ConstantText { get; set; }
    [JsonPropertyName("fieldId")] public string? FieldId { get; set; }
    [JsonPropertyName("blockId")] public string? BlockId { get; set; }
}

public sealed class FieldDefDto
{
    [JsonPropertyName("mergeFieldName")] public string MergeFieldName { get; set; } = "";
}

public sealed class BlockDefDto
{
    [JsonPropertyName("bookmarkName")] public string BookmarkName { get; set; } = "";
}

public sealed class BuildTemplateInput
{
    [JsonPropertyName("templatePath")] public string TemplatePath { get; set; } = "";
    [JsonPropertyName("outputPath")] public string OutputPath { get; set; } = "";
    [JsonPropertyName("selectedMarkings")] public List<string> SelectedMarkings { get; set; } = new();
    [JsonPropertyName("storedCandidates")] public List<CandidateDto> StoredCandidates { get; set; } = new();
    [JsonPropertyName("candidateDecisions")] public Dictionary<string, CandidateDecisionDto> CandidateDecisions { get; set; } = new();
    [JsonPropertyName("fields")] public Dictionary<string, FieldDefDto> Fields { get; set; } = new();
    [JsonPropertyName("blocks")] public Dictionary<string, BlockDefDto> Blocks { get; set; } = new();
    [JsonPropertyName("manifestJson")] public string ManifestJson { get; set; } = "";
}

public sealed class BuildTemplateOutput
{
    [JsonPropertyName("ok")] public bool Ok { get; set; }
    [JsonPropertyName("message")] public string? Message { get; set; }
    [JsonPropertyName("warnings")] public List<string> Warnings { get; set; } = new();
}
