using DocumentFormat.OpenXml.Packaging;
using DocumentFormat.OpenXml.Validation;
using Scyzoryk.DocumentEngine.Commands;
using Scyzoryk.DocumentEngine.Tests.Fixtures;
using Xunit;

namespace Scyzoryk.DocumentEngine.Tests;

// Sekcja 24 promptu migracji: to samo pokrycie co apps/kreator-wzorow/scripts/
// test-word-com.ps1 (audyt 2026-09-10), ale BEZ Microsoft Word - dziala w CI.
public class KreatorScanTests : IDisposable
{
    private readonly string _fixturePath;

    public KreatorScanTests()
    {
        _fixturePath = Path.Combine(Path.GetTempPath(), $"scyzoryk-fixture-{Guid.NewGuid():N}.docx");
        FixtureBuilder.Build(_fixturePath);
    }

    public void Dispose()
    {
        try { File.Delete(_fixturePath); } catch { /* najlepszy wysilek sprzatania tmp */ }
    }

    [Fact]
    public void Palette_WykrywaWszystkieUzyteKolory()
    {
        var output = ScanTemplateCommand.RunPalette(new ScanPaletteInput { TemplatePath = _fixturePath });
        Assert.True(output.Ok, output.Message);
        var keys = output.Markings!.Select(m => m.Key).ToHashSet();
        Assert.Contains("highlight:yellow", keys);
        Assert.Contains("highlight:brightgreen", keys);
        Assert.Contains("shading:FFE599", keys);
        Assert.Contains("shading:C6E0B4", keys);
        Assert.Contains("shading:F4B183", keys);
        Assert.Contains("shading:ADD8E6", keys); // DECORATIVE_BLUE - w PALECIE ma byc widoczny, dopiero user go nie wybiera
    }

    [Fact]
    public void Candidates_ZnajdujeWszystkieMechanizmy_INiewybranyKolorJestPominiety()
    {
        var output = ScanTemplateCommand.RunCandidates(new ScanCandidatesInput
        {
            TemplatePath = _fixturePath,
            SelectedMarkings = FixtureBuilder.SelectedMarkings.ToList(),
        });
        Assert.True(output.Ok, output.Message);
        var candidates = output.Candidates!;

        var texts = candidates.Select(c => c.Text).ToList();
        Assert.Contains("HL_YELLOW", texts);
        Assert.Contains("HL_GREEN", texts);
        Assert.Contains("RUN_SHADING", texts);
        Assert.Contains("PARAGRAPH_SHADING", texts);
        Assert.Contains("CELL_SHADING", texts);
        Assert.Contains("HEADER_MARK", texts);
        Assert.Contains("FOOTER_MARK", texts);
        Assert.Contains("TEXTBOX_MARK", texts);
        Assert.DoesNotContain("DECORATIVE_BLUE", texts);

        var xxxCandidates = candidates.Where(c => c.Text == "XXX").ToList();
        Assert.Equal(2, xxxCandidates.Count);
        Assert.NotEqual(xxxCandidates[0].Ordinal, xxxCandidates[1].Ordinal);

        var kinds = candidates.Select(c => c.MarkKind).ToHashSet();
        Assert.Contains("highlight", kinds);
        Assert.Contains("shading-run", kinds);
        Assert.Contains("shading-paragraph", kinds);
        Assert.Contains("shading-cell", kinds);

        var headerCandidate = candidates.First(c => c.Text == "HEADER_MARK");
        var footerCandidate = candidates.First(c => c.Text == "FOOTER_MARK");
        Assert.NotEqual(headerCandidate.PartUri, footerCandidate.PartUri);

        var textboxCandidate = candidates.First(c => c.Text == "TEXTBOX_MARK");
        Assert.Equal("textbox", textboxCandidate.ContainerKind);

        var cellCandidate = candidates.First(c => c.Text == "CELL_SHADING");
        Assert.Equal("tableCell", cellCandidate.ContainerKind);
    }

    [Fact]
    public void Candidates_ParagraphContext_PrefixSuffixRozdzielonePoprawnie()
    {
        var output = ScanTemplateCommand.RunCandidates(new ScanCandidatesInput
        {
            TemplatePath = _fixturePath,
            SelectedMarkings = FixtureBuilder.SelectedMarkings.ToList(),
        });
        Assert.True(output.Ok, output.Message);
        var candidate = output.Candidates!.First(c => c.Text == "CTX_PARA_VALUE");

        Assert.Equal("Projektowana moc instalacji: CTX_PARA_VALUE (potwierdzone).", candidate.ParagraphText);
        Assert.Equal("Projektowana moc instalacji:", candidate.ParagraphPrefix);
        Assert.Equal("(potwierdzone).", candidate.ParagraphSuffix);
        // Nie jest w tabeli - pola tabelaryczne musza zostac puste, nie null.
        Assert.Equal("", candidate.TableRowText);
        Assert.Equal("", candidate.LeftCellText);
        Assert.Equal("", candidate.RightCellText);
    }

    [Fact]
    public void Candidates_TableCellContext_LeftRightCellTextIWierszWypelnione()
    {
        var output = ScanTemplateCommand.RunCandidates(new ScanCandidatesInput
        {
            TemplatePath = _fixturePath,
            SelectedMarkings = FixtureBuilder.SelectedMarkings.ToList(),
        });
        Assert.True(output.Ok, output.Message);
        var candidate = output.Candidates!.First(c => c.Text == "CTX_TABLE_VALUE");

        Assert.Equal("tableCell", candidate.ContainerKind);
        Assert.Equal("Moc PV", candidate.LeftCellText);
        Assert.Equal("kWp", candidate.RightCellText);
        Assert.Equal("Moc PVCTX_TABLE_VALUEkWp", candidate.TableRowText);
    }

    [Fact]
    public void Candidates_NonTableContext_TableFieldsPozostajaPuste()
    {
        var output = ScanTemplateCommand.RunCandidates(new ScanCandidatesInput
        {
            TemplatePath = _fixturePath,
            SelectedMarkings = FixtureBuilder.SelectedMarkings.ToList(),
        });
        Assert.True(output.Ok, output.Message);
        var candidate = output.Candidates!.First(c => c.Text == "HL_YELLOW");

        Assert.Equal("", candidate.TableRowText);
        Assert.Equal("", candidate.LeftCellText);
        Assert.Equal("", candidate.RightCellText);
        Assert.Equal("HL_YELLOW", candidate.ParagraphText);
    }

    [Fact]
    public void Candidates_BezWybranychOznaczen_DajeCzytelnyBladNiePustyWynik()
    {
        var output = ScanTemplateCommand.RunCandidates(new ScanCandidatesInput
        {
            TemplatePath = _fixturePath,
            SelectedMarkings = new List<string>(),
        });
        Assert.False(output.Ok);
        Assert.NotNull(output.Message);
    }

    [Fact]
    public void ZeroWordSmoke_ZadenNowyWinwordExeNiePowstaje()
    {
        var before = System.Diagnostics.Process.GetProcessesByName("WINWORD").Select(p => p.Id).ToHashSet();

        ScanTemplateCommand.RunPalette(new ScanPaletteInput { TemplatePath = _fixturePath });
        ScanTemplateCommand.RunCandidates(new ScanCandidatesInput { TemplatePath = _fixturePath, SelectedMarkings = FixtureBuilder.SelectedMarkings.ToList() });

        var after = System.Diagnostics.Process.GetProcessesByName("WINWORD").Select(p => p.Id).ToHashSet();
        var newPids = after.Except(before).ToList();
        Assert.Empty(newPids);
    }

    [Fact]
    public void Build_KompletnyPrzeplyw_FieldConstantBlockManual_TabelaINietkniętyManualRegion()
    {
        var scanResult = ScanTemplateCommand.RunCandidates(new ScanCandidatesInput
        {
            TemplatePath = _fixturePath,
            SelectedMarkings = FixtureBuilder.SelectedMarkings.ToList(),
        });
        Assert.True(scanResult.Ok, scanResult.Message);
        var candidates = scanResult.Candidates!;

        var xxxCandidates = candidates.Where(c => c.Text == "XXX").OrderBy(c => c.Ordinal).ToList();
        var runShading = candidates.First(c => c.Text == "RUN_SHADING");
        var paragraphShading = candidates.First(c => c.Text == "PARAGRAPH_SHADING"); // -> manual, Do projektanta

        var decisions = new Dictionary<string, CandidateDecisionDto>();
        decisions[xxxCandidates[0].Id] = new CandidateDecisionDto { Status = "field", FieldId = "fld1" };
        decisions[xxxCandidates[1].Id] = new CandidateDecisionDto { Status = "constant", ConstantText = "STALA_XXX" };
        decisions[runShading.Id] = new CandidateDecisionDto { Status = "block", BlockId = "blk1" };
        decisions[paragraphShading.Id] = new CandidateDecisionDto { Status = "manual" };
        foreach (var c in candidates)
        {
            if (!decisions.ContainsKey(c.Id))
                decisions[c.Id] = new CandidateDecisionDto { Status = "constant", ConstantText = $"STALA_{c.PaletteKey.Replace(":", "_")}" };
        }

        var outputPath = Path.Combine(Path.GetTempPath(), $"scyzoryk-built-{Guid.NewGuid():N}.docx");
        try
        {
            var manifestJson = "{\"schemaVersion\":1,\"templateId\":\"t1\",\"templateName\":\"Test\",\"fields\":[],\"blocks\":[],\"variantGroups\":[],\"placements\":[],\"manualRegions\":[]}";
            var buildOutput = BuildTemplateCommand.Run(new BuildTemplateInput
            {
                TemplatePath = _fixturePath,
                OutputPath = outputPath,
                SelectedMarkings = FixtureBuilder.SelectedMarkings.ToList(),
                StoredCandidates = candidates,
                CandidateDecisions = decisions,
                Fields = new Dictionary<string, FieldDefDto> { ["fld1"] = new() { MergeFieldName = "SCY_F_TEST01" } },
                Blocks = new Dictionary<string, BlockDefDto> { ["blk1"] = new() { BookmarkName = "SCYB_TEST01" } },
                ManifestJson = manifestJson,
            });
            Assert.True(buildOutput.Ok, buildOutput.Message);

            using var built = WordprocessingDocument.Open(outputPath, false);
            var validator = new OpenXmlValidator();
            var errors = validator.Validate(built).ToList();
            Assert.Empty(errors);

            var mainText = built.MainDocumentPart!.Document.Body!.InnerText;
            Assert.Contains("STALA_XXX", mainText);
            Assert.DoesNotContain("XXX separator", mainText); // oba XXX zastapione (field + constant)

            var fields = built.MainDocumentPart.Document.Descendants<DocumentFormat.OpenXml.Wordprocessing.FieldCode>().ToList();
            Assert.Contains(fields, f => f.Text.Contains("MERGEFIELD SCY_F_TEST01"));

            var bookmarks = built.MainDocumentPart.Document.Descendants<DocumentFormat.OpenXml.Wordprocessing.BookmarkStart>().ToList();
            Assert.Contains(bookmarks, b => b.Name == "SCYB_TEST01");

            // "Do projektanta" (PARAGRAPH_SHADING) musi zostac 1:1 - tresc I kolor.
            var manualParagraph = built.MainDocumentPart.Document.Descendants<DocumentFormat.OpenXml.Wordprocessing.Paragraph>()
                .FirstOrDefault(p => p.InnerText.Contains("PARAGRAPH_SHADING"));
            Assert.NotNull(manualParagraph);
            var manualShading = manualParagraph!.ParagraphProperties?.GetFirstChild<DocumentFormat.OpenXml.Wordprocessing.Shading>();
            Assert.NotNull(manualShading);
            Assert.Equal("C6E0B4", manualShading!.Fill?.Value, ignoreCase: true);

            // Tabela: vMerge/gridSpan nietkniete (sekcja 23).
            var table = built.MainDocumentPart.Document.Descendants<DocumentFormat.OpenXml.Wordprocessing.Table>().First();
            var vMerges = table.Descendants<DocumentFormat.OpenXml.Wordprocessing.VerticalMerge>().ToList();
            Assert.Equal(2, vMerges.Count);
        }
        finally
        {
            try { File.Delete(outputPath); } catch { }
        }
    }

    [Fact]
    public void Build_PhotoGallery_WstawiaPrawdziwyMergefieldZdjeciaPomontazowe()
    {
        // Kandydat "Zdjecia" (galeria) - real feature zgloszona przez uzytkownika
        // (2026-09-21): chce miec te sama galerie zdjec co apps/dokumenty-seryjne
        // juz obsluguje (MERGEFIELD "Zdjecia_pomontazowe"), ale wstawiana przez
        // Kreator zamiast recznie w Wordzie. Kandydat nie potrzebuje ZADNEJ
        // wartosci/reguly runtime (jak "constant") - dokumenty-seryjne samo
        // znajduje to pole po nazwie i wypelnia je zdjeciami z folderu adresu.
        var scanResult = ScanTemplateCommand.RunCandidates(new ScanCandidatesInput
        {
            TemplatePath = _fixturePath,
            SelectedMarkings = FixtureBuilder.SelectedMarkings.ToList(),
        });
        Assert.True(scanResult.Ok, scanResult.Message);
        var candidates = scanResult.Candidates!;
        var xxxCandidates = candidates.Where(c => c.Text == "XXX").OrderBy(c => c.Ordinal).ToList();

        var decisions = new Dictionary<string, CandidateDecisionDto>();
        decisions[xxxCandidates[0].Id] = new CandidateDecisionDto { Status = "photoGallery" };
        foreach (var c in candidates)
        {
            if (!decisions.ContainsKey(c.Id))
                decisions[c.Id] = new CandidateDecisionDto { Status = "constant", ConstantText = $"STALA_{c.PaletteKey.Replace(":", "_")}" };
        }

        var outputPath = Path.Combine(Path.GetTempPath(), $"scyzoryk-built-gallery-{Guid.NewGuid():N}.docx");
        try
        {
            var buildOutput = BuildTemplateCommand.Run(new BuildTemplateInput
            {
                TemplatePath = _fixturePath,
                OutputPath = outputPath,
                SelectedMarkings = FixtureBuilder.SelectedMarkings.ToList(),
                StoredCandidates = candidates,
                CandidateDecisions = decisions,
                ManifestJson = "{\"schemaVersion\":1,\"templateId\":\"t1\",\"templateName\":\"Test\",\"fields\":[],\"blocks\":[],\"variantGroups\":[],\"placements\":[],\"manualRegions\":[]}",
            });
            Assert.True(buildOutput.Ok, buildOutput.Message);

            using var built = WordprocessingDocument.Open(outputPath, false);
            var validator = new OpenXmlValidator();
            Assert.Empty(validator.Validate(built).ToList());

            var fields = built.MainDocumentPart!.Document.Descendants<DocumentFormat.OpenXml.Wordprocessing.FieldCode>().ToList();
            Assert.Contains(fields, f => f.Text.Contains("MERGEFIELD Zdjecia_pomontazowe"));
        }
        finally
        {
            try { File.Delete(outputPath); } catch { }
        }
    }

    [Fact]
    public void Build_WzorZmienionyOdCzasuSkanowania_PrzerywaZCzytelnymBledem()
    {
        var scanResult = ScanTemplateCommand.RunCandidates(new ScanCandidatesInput
        {
            TemplatePath = _fixturePath,
            SelectedMarkings = FixtureBuilder.SelectedMarkings.ToList(),
        });
        var candidates = scanResult.Candidates!;
        // symuluj falszywy fingerprint (jakby dokument zmienil sie od skanu)
        candidates[0].Fingerprint = "sfalszowany-fingerprint";

        var decisions = candidates.ToDictionary(c => c.Id, c => new CandidateDecisionDto { Status = "manual" });
        var outputPath = Path.Combine(Path.GetTempPath(), $"scyzoryk-shouldfail-{Guid.NewGuid():N}.docx");
        try
        {
            var buildOutput = BuildTemplateCommand.Run(new BuildTemplateInput
            {
                TemplatePath = _fixturePath,
                OutputPath = outputPath,
                SelectedMarkings = FixtureBuilder.SelectedMarkings.ToList(),
                StoredCandidates = candidates,
                CandidateDecisions = decisions,
                ManifestJson = "{}",
            });
            Assert.False(buildOutput.Ok);
            Assert.Contains("zmienil", buildOutput.Message);
        }
        finally
        {
            try { File.Delete(outputPath); } catch { }
        }
    }
}
