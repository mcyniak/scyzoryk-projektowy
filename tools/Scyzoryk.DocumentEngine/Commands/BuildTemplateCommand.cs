using DocumentFormat.OpenXml.Packaging;
using DocumentFormat.OpenXml.Validation;
using Scyzoryk.DocumentEngine.OpenXml;

namespace Scyzoryk.DocumentEngine.Commands;

// Zastepuje apps/kreator-wzorow/scripts/build-template.ps1 (Word COM) - ETAP 2
// promptu migracji. Kluczowa roznica architektoniczna wobec wersji Word COM:
// mutacje dzialaja na BEZPOSREDNICH referencjach OpenXmlElement zebranych w
// TEJ SAMEJ sesji skanowania, wiec KOLEJNOSC PRZETWARZANIA JEDNOSTEK JUZ NIE
// MA ZNACZENIA (nie ma czegos jak Range.Start przesuwajacy sie pod wplywem
// wczesniejszej mutacji, ani ryzyka skasowania calego "ksztaltu" - to byly
// realne, zweryfikowane live problemy Word COM z audytu 2026-09-10, ktore w
// modelu Open XML po prostu nie istnieja).
public static class BuildTemplateCommand
{
    public static BuildTemplateOutput Run(BuildTemplateInput input)
    {
        if (!File.Exists(input.TemplatePath))
            return Fail($"Nie znaleziono szablonu: {input.TemplatePath}");
        if (input.SelectedMarkings.Count == 0)
            return Fail("Brak listy oznaczen uzytych przy skanowaniu - wczytaj/skanuj wzor ponownie.");

        try
        {
            if (File.Exists(input.OutputPath)) File.Delete(input.OutputPath);
            File.Copy(input.TemplatePath, input.OutputPath);

            using var doc = WordprocessingDocument.Open(input.OutputPath, true);
            var (freshRegions, _) = ScanTemplateCommand.ScanRegions(doc, input.SelectedMarkings);

            var storedByKey = input.StoredCandidates.ToDictionary(BuildKey, c => c);
            var freshByKey = freshRegions.ToDictionary(r => BuildKey(ScanTemplateCommand.ToDto(r)), r => r);

            if (freshRegions.Count != input.StoredCandidates.Count)
            {
                return Fail($"Wzor zmienil sie od czasu skanowania (inna liczba oznaczonych fragmentow: bylo {input.StoredCandidates.Count}, jest {freshRegions.Count}). Wczytaj/skanuj ponownie.");
            }
            foreach (var (key, stored) in storedByKey)
            {
                if (!freshByKey.TryGetValue(key, out var fresh))
                    return Fail($"Wzor zmienil sie od czasu skanowania (zniknal fragment {key}). Wczytaj/skanuj ponownie.");
                if (!string.Equals(fresh.Fingerprint, stored.Fingerprint, StringComparison.Ordinal))
                    return Fail($"Wzor zmienil sie od czasu skanowania (tresc fragmentu {key} jest inna niz przy skanie). Wczytaj/skanuj ponownie.");
            }

            var warnings = new List<string>();
            var blockGroups = new Dictionary<string, List<MarkRegion>>();

            foreach (var stored in input.StoredCandidates)
            {
                var key = BuildKey(stored);
                var fresh = freshByKey[key];
                if (!input.CandidateDecisions.TryGetValue(stored.Id, out var decision)) continue;

                switch (decision.Status)
                {
                    case "manual":
                    case "unresolved":
                        continue; // sekcja 8: nietkniete - tresc, oznaczenie, wszystko.
                    case "field":
                        if (decision.FieldId is null || !input.Fields.TryGetValue(decision.FieldId, out var fieldDef))
                        {
                            warnings.Add($"Kandydat {stored.Id}: brak definicji pola '{decision.FieldId}' w manifescie.");
                            continue;
                        }
                        try
                        {
                            var resultRun = FieldWriter.InsertMergeField(fresh, fieldDef.MergeFieldName);
                            TextReplacer.ClearMark(fresh);
                        }
                        catch (Exception ex)
                        {
                            warnings.Add($"Kandydat {stored.Id}: {ex.Message}");
                        }
                        continue;
                    case "constant":
                        try
                        {
                            if (decision.ConstantText is not null)
                            {
                                TextReplacer.ReplaceWithConstant(fresh, decision.ConstantText);
                            }
                            TextReplacer.ClearMark(fresh);
                        }
                        catch (Exception ex)
                        {
                            warnings.Add($"Kandydat {stored.Id}: {ex.Message}");
                        }
                        continue;
                    case "block":
                        if (decision.BlockId is null) { warnings.Add($"Kandydat {stored.Id}: brak blockId."); continue; }
                        if (!blockGroups.TryGetValue(decision.BlockId, out var group)) { group = new List<MarkRegion>(); blockGroups[decision.BlockId] = group; }
                        group.Add(fresh);
                        continue;
                }
            }

            foreach (var (blockId, members) in blockGroups)
            {
                if (!input.Blocks.TryGetValue(blockId, out var blockDef))
                {
                    warnings.Add($"Blok {blockId}: brak definicji w manifescie.");
                    continue;
                }
                try
                {
                    var distinctParts = members.Select(m => m.PartUri).Distinct().ToList();
                    if (distinctParts.Count > 1)
                    {
                        warnings.Add($"Blok '{blockId}' laczy fragmenty z roznych czesci dokumentu ({string.Join(", ", distinctParts)}) - to nie jest obslugiwane, kazdy blok musi byc w jednej czesci dokumentu.");
                        continue;
                    }

                    var parent = members[0].Container!.Parent!;
                    if (members.Any(m => !ReferenceEquals(m.Container!.Parent, parent)))
                    {
                        warnings.Add($"Blok '{blockId}' laczy fragmenty, ktorych nie da sie bezpiecznie objac jednym bookmarkiem (rozne kontenery nadrzedne) - popraw konfiguracje przed buildem.");
                        continue;
                    }

                    var siblings = parent.ChildElements.ToList();
                    var ordered = members.OrderBy(m => siblings.IndexOf(m.Container!)).ToList();
                    var bookmarkId = BookmarkWriter.GetNextBookmarkId(doc);
                    BookmarkWriter.WrapInBookmark(ordered.First().Container!, ordered.Last().Container!, blockDef.BookmarkName, bookmarkId);

                    foreach (var member in members) TextReplacer.ClearMark(member);
                }
                catch (Exception ex)
                {
                    warnings.Add($"Blok {blockId}: {ex.Message}");
                }
            }

            SmartTemplateManifest.Embed(doc, input.ManifestJson);

            var validator = new OpenXmlValidator();
            var validationErrors = validator.Validate(doc).ToList();
            if (validationErrors.Count > 0)
            {
                var details = string.Join("; ", validationErrors.Take(5).Select(e => $"{e.Path?.XPath}: {e.Description}"));
                return Fail($"Zbudowany dokument nie przeszedl walidacji Open XML: {details}");
            }

            doc.Save();
            return new BuildTemplateOutput { Ok = true, Warnings = warnings };
        }
        catch (Exception ex)
        {
            return Fail($"Nie udalo sie zbudowac wzoru: {ex.Message}");
        }
    }

    private static string BuildKey(CandidateDto c) => $"{c.PartUri}|{c.PaletteKey}|{c.Ordinal}";

    private static BuildTemplateOutput Fail(string message) => new() { Ok = false, Message = message };
}
