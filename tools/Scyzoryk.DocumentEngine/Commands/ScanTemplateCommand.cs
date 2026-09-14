using DocumentFormat.OpenXml.Packaging;
using Scyzoryk.DocumentEngine.OpenXml;

namespace Scyzoryk.DocumentEngine.Commands;

// Zastepuje apps/kreator-wzorow/scripts/scan-template.ps1 (oba tryby, palette
// i candidates) - ETAP 2 promptu migracji. WINWORD.EXE nie jest juz w ogole
// potrzebny do zadnego z nich.
public static class ScanTemplateCommand
{
    public static ScanPaletteOutput RunPalette(ScanPaletteInput input)
    {
        if (!File.Exists(input.TemplatePath))
            return new ScanPaletteOutput { Ok = false, Message = $"Nie znaleziono szablonu: {input.TemplatePath}" };

        try
        {
            using var doc = WordprocessingDocument.Open(input.TemplatePath, false);
            var palette = PaletteScanner.ScanPalette(doc);
            return new ScanPaletteOutput
            {
                Ok = true,
                Markings = palette.Select(p => new PaletteEntryDto
                {
                    Key = p.Key,
                    Kind = p.Kind,
                    RawValue = p.RawValue,
                    DisplayColor = p.DisplayColor,
                    Count = p.Count,
                    Examples = p.Examples.Select(e => new PaletteExample { Text = e }).ToList(),
                }).ToList(),
            };
        }
        catch (Exception ex)
        {
            return new ScanPaletteOutput { Ok = false, Message = $"Nie udalo sie odczytac struktury DOCX: {ex.Message}" };
        }
    }

    public static ScanCandidatesOutput RunCandidates(ScanCandidatesInput input)
    {
        if (!File.Exists(input.TemplatePath))
            return new ScanCandidatesOutput { Ok = false, Message = $"Nie znaleziono szablonu: {input.TemplatePath}" };
        if (input.SelectedMarkings.Count == 0)
            return new ScanCandidatesOutput { Ok = false, Message = "Nie wybrano zadnych oznaczen do skanowania." };

        try
        {
            using var doc = WordprocessingDocument.Open(input.TemplatePath, false);
            var (regions, diagnostics) = ScanRegions(doc, input.SelectedMarkings);
            return new ScanCandidatesOutput
            {
                Ok = true,
                Candidates = regions.Select(ToDto).ToList(),
                Diagnostics = new ScanDiagnosticsDto
                {
                    PartsScanned = diagnostics.PartsScanned,
                    HighlightRangesFound = diagnostics.HighlightRangesFound,
                    RunShadingRangesFound = diagnostics.RunShadingRangesFound,
                    ParagraphShadingRangesFound = diagnostics.ParagraphShadingRangesFound,
                    CellShadingRangesFound = diagnostics.CellShadingRangesFound,
                    SelectedMarkings = input.SelectedMarkings,
                },
            };
        }
        catch (Exception ex)
        {
            return new ScanCandidatesOutput { Ok = false, Message = $"Nie udalo sie przeskanowac oznaczen: {ex.Message}" };
        }
    }

    public static (List<MarkRegion> Regions, MarkScanner.ScanDiagnostics Diagnostics) ScanRegions(WordprocessingDocument doc, List<string> selectedMarkings)
    {
        var highlightKeys = selectedMarkings.Where(m => m.StartsWith("highlight:")).Select(m => m["highlight:".Length..]).ToHashSet();
        var shadingHexes = selectedMarkings.Where(m => m.StartsWith("shading:")).Select(m => m["shading:".Length..].ToUpperInvariant()).ToHashSet();
        var diagnostics = new MarkScanner.ScanDiagnostics();
        var options = new MarkScanner.ScanOptions(highlightKeys, shadingHexes);
        var regions = MarkScanner.ScanDocument(doc, options, diagnostics);
        return (regions, diagnostics);
    }

    public static CandidateDto ToDto(MarkRegion region) => new()
    {
        Id = $"cand_{Sanitize(region.PartUri)}_{Sanitize(region.PaletteKey)}_{region.Ordinal}",
        PartUri = region.PartUri,
        ContainerKind = region.ContainerKind,
        MarkKind = region.MarkKind,
        PaletteKey = region.PaletteKey,
        RawColor = region.RawColor,
        DisplayColor = region.DisplayColor,
        StructuralPath = region.StructuralPath,
        Ordinal = region.Ordinal,
        Text = region.Text,
        Before = region.Before,
        After = region.After,
        Fingerprint = region.Fingerprint,
        ParagraphText = region.ParagraphText,
        ParagraphPrefix = region.ParagraphPrefix,
        ParagraphSuffix = region.ParagraphSuffix,
        TableRowText = region.TableRowText,
        LeftCellText = region.LeftCellText,
        RightCellText = region.RightCellText,
    };

    private static string Sanitize(string value) => new(value.Where(char.IsLetterOrDigit).ToArray());
}
