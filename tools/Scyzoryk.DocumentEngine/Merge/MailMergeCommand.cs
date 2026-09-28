using System.Diagnostics;
using System.Globalization;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Nodes;
using DocumentFormat.OpenXml.Packaging;
using Scyzoryk.DocumentEngine.Pdf;

namespace Scyzoryk.DocumentEngine.Merge;

// Nastepca apps/dokumenty-seryjne/scripts/mailmerge-to-pdf.ps1 (Word COM).
// Protokol z Node celowo IDENTYCZNY jak w skrypcie PowerShell: linie JSON na
// stdout ({"event":"record-start",...}), na koncu linia z polem "ok"
// (created/errors/...). Dzieki temu server.js Dokumentow seryjnych i podglad
// Kreatora uzywaja tego samego parsera co dotad - zmienia sie tylko proces,
// ktory uruchamiaja.
//
// Kolejnosc krokow na rekord - ta sama co w PowerShell:
//   galeria zdjec -> (Smart Template: bloki | legacy: komorki tabel + wielokropki)
//   -> MERGEFIELD -> znaczniki tekstowe -> zapis DOCX (opcjonalnie) -> PDF.
public sealed class MailMergeInput
{
    public string TemplatePath { get; set; } = "";
    public string OutputDir { get; set; } = "";
    public string AddressColumn { get; set; } = "Adres";
    public JsonElement Records { get; set; }
    public List<RuleDto>? Rules { get; set; }
    public string? FilePrefix { get; set; }
    public string? ImageManifestPath { get; set; }
    public bool SaveWord { get; set; }
    public bool SavePdf { get; set; } = true;
    public bool DebugMode { get; set; }
    public bool SmartTemplateMode { get; set; }
    public string? LogPath { get; set; }
    public string? DebugJsonPath { get; set; }
    public string? PdfRenderer { get; set; }
    public string? OnlyOfficeDir { get; set; }

    public sealed class RuleDto
    {
        public string? Find { get; set; }
        public string? Column { get; set; }
        public JsonElement Occurrence { get; set; }
    }
}

public sealed class MailMergeCommand
{
    private static readonly JsonSerializerOptions EventJson = new()
    {
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        WriteIndented = false,
    };

    private readonly MailMergeInput _input;
    private readonly TextWriter _stdout;
    private readonly object _logLock = new();

    public MailMergeCommand(MailMergeInput input, TextWriter stdout)
    {
        _input = input;
        _stdout = stdout;
    }

    public static List<List<KeyValuePair<string, string>>> ParseRecords(JsonElement records)
    {
        var list = new List<List<KeyValuePair<string, string>>>();
        if (records.ValueKind != JsonValueKind.Array) return list;
        foreach (var r in records.EnumerateArray())
        {
            if (r.ValueKind != JsonValueKind.Object) continue;
            var rec = new List<KeyValuePair<string, string>>();
            foreach (var p in r.EnumerateObject()) rec.Add(new(p.Name, JsonValueToString(p.Value)));
            list.Add(rec);
        }
        return list;
    }

    // Odpowiednik rzutowania [string] w PowerShell dla wartosci z JSON.
    public static string JsonValueToString(JsonElement v) => v.ValueKind switch
    {
        JsonValueKind.String => v.GetString() ?? "",
        JsonValueKind.Number => v.GetRawText(),
        JsonValueKind.True => "True",
        JsonValueKind.False => "False",
        JsonValueKind.Null or JsonValueKind.Undefined => "",
        _ => v.GetRawText(),
    };

    private static int ParseOccurrence(JsonElement e)
    {
        try
        {
            if (e.ValueKind == JsonValueKind.Number && e.TryGetInt32(out var n)) return n;
            if (e.ValueKind == JsonValueKind.String && int.TryParse(e.GetString(), NumberStyles.Integer, CultureInfo.InvariantCulture, out var s)) return s;
        }
        catch { }
        return 0;
    }

    public JsonObject Run()
    {
        var created = new JsonArray();
        var errors = new JsonArray();
        var outputDir = _input.OutputDir;
        try
        {
            if (!File.Exists(_input.TemplatePath)) throw new FileNotFoundException($"Nie znaleziono szablonu Word: {_input.TemplatePath}");
            Directory.CreateDirectory(outputDir);
            // LogPath/DebugJsonPath NIE sa tu czyszczone: cyklem zycia tych plikow
            // zarzadza Node (Dokumenty seryjne czyszcza je raz na zadanie, a przy
            // paczce kilku szablonow - _keepLog - i w trybie "folder" dopisuja
            // kolejne szablony do tego samego logu). Czyszczenie tutaj kasowalo
            // diagnostyke wczesniejszych szablonow z tej samej paczki.

            var rules = (_input.Rules ?? new())
                .Select(r => new TextMarkerReplacer.Rule(r.Find ?? "", r.Column ?? "", ParseOccurrence(r.Occurrence)))
                .ToList();

            Event("start", "Rozpoczynam tworzenie PDF.", new JsonObject
            {
                ["template"] = _input.TemplatePath,
                ["output"] = outputDir,
                ["addressColumn"] = _input.AddressColumn,
                ["debugMode"] = _input.DebugMode,
                ["textReplacementRules"] = rules.Count,
                ["filePrefix"] = _input.FilePrefix ?? "",
                ["engine"] = "openxml",
            });

            var records = ParseRecords(_input.Records);
            if (records.Count < 1) throw new InvalidOperationException("Brak rekordow do wygenerowania.");
            Event("start", "Wczytano rekordy do generowania.", new JsonObject { ["total"] = records.Count });

            Event("template-clean", "Przygotowuje kopie szablonu i usuwam polaczenie korespondencji seryjnej.", null);
            var cleanTemplate = TemplateCleaner.CleanTemplate(_input.TemplatePath, Log);
            var gallery = PhotoGallery.Load(_input.ImageManifestPath, Log);

            using var renderer = _input.SavePdf ? PdfRendererFactory.Create(_input.PdfRenderer, _input.OnlyOfficeDir, Log) : null;
            Event("engine-start", renderer is null
                ? "Uruchamiam silnik dokumentow (bez Worda)."
                : $"Uruchamiam silnik dokumentow (bez Worda); PDF: {(renderer.Name == "word" ? "Word (tylko zapis PDF)" : "bez Worda")}.",
                new JsonObject { ["pdfRenderer"] = renderer?.Name ?? "brak" });

            var total = records.Count;
            for (var index = 1; index <= total; index++)
            {
                var record = records[index - 1];
                var rowNumber = int.TryParse(TextNormalize.GetRecordValue(record, "_record"), NumberStyles.Integer, CultureInfo.InvariantCulture, out var rn) && rn >= 1 ? rn : index;
                try
                {
                    var address = TextNormalize.GetRecordValue(record, _input.AddressColumn);
                    if (string.IsNullOrWhiteSpace(address)) address = $"rekord_{rowNumber}";
                    var baseName = TextNormalize.SafeFileName(TextNormalize.JoinPrefixAndAddress(_input.FilePrefix, address));
                    var pdfPath = TextNormalize.UniquePath(outputDir, baseName, ".pdf");

                    Event("record-start", $"Tworze PDF {index}/{total}: {address}", new JsonObject
                    {
                        ["current"] = index, ["total"] = total, ["row"] = rowNumber, ["address"] = address, ["target"] = pdfPath,
                    });

                    var sw = Stopwatch.StartNew();
                    var (docxBytes, smartIssues, fieldMap) = BuildRecordDocument(cleanTemplate, record, rules, gallery, address);
                    Log("info", $"Dokument rekordu wypelniony w {sw.ElapsedMilliseconds} ms.", new JsonObject { ["row"] = rowNumber });
                    if (_input.DebugMode)
                    {
                        fieldMap["event"] = "field-map";
                        fieldMap["row"] = rowNumber;
                        fieldMap["address"] = address;
                        WriteJsonLine(fieldMap);
                        try { File.WriteAllBytes(Path.ChangeExtension(pdfPath, ".debug.docx"), docxBytes); } catch (Exception ex) { Log("warn", $"Nie udalo sie zapisac roboczego DOCX: {ex.Message}"); }
                    }

                    if (_input.SaveWord)
                    {
                        var docxPath = TextNormalize.UniquePath(outputDir, baseName, ".docx");
                        File.WriteAllBytes(docxPath, docxBytes);
                        created.Add(new JsonObject { ["row"] = rowNumber, ["address"] = address, ["file"] = Path.GetFileName(docxPath), ["path"] = docxPath });
                        Event("export-done", $"Word zapisany: {address}", new JsonObject { ["current"] = index, ["total"] = total, ["row"] = rowNumber, ["address"] = address, ["file"] = Path.GetFileName(docxPath) });
                    }

                    if (renderer is not null)
                    {
                        Event("export-start", $"Eksportuje do PDF: {address}.", new JsonObject { ["current"] = index, ["total"] = total, ["row"] = rowNumber, ["address"] = address, ["pdf"] = pdfPath });
                        var exportSw = Stopwatch.StartNew();
                        renderer.Render(docxBytes, pdfPath);
                        Event("export-done", $"PDF wyeksportowany: {address}", new JsonObject
                        {
                            ["current"] = index, ["total"] = total, ["row"] = rowNumber, ["address"] = address, ["file"] = Path.GetFileName(pdfPath),
                            ["seconds"] = Math.Round(exportSw.Elapsed.TotalSeconds, 2),
                        });
                        created.Add(new JsonObject { ["row"] = rowNumber, ["address"] = address, ["file"] = Path.GetFileName(pdfPath), ["path"] = pdfPath });
                    }

                    if (smartIssues.Count > 0)
                    {
                        var blockMsg = "PDF powstal, ale wystapil problem ze smart blokami: " + string.Join("; ", smartIssues.Select(i => i.Message));
                        errors.Add(new JsonObject { ["row"] = rowNumber, ["message"] = blockMsg });
                        Event("record-error", $"Rekord {rowNumber}: {blockMsg}", new JsonObject { ["current"] = index, ["total"] = total, ["row"] = rowNumber, ["error"] = blockMsg });
                    }
                    Event("record-done", $"Gotowy PDF {index}/{total}: {address}", new JsonObject
                    {
                        ["current"] = index, ["total"] = total, ["row"] = rowNumber, ["address"] = address, ["file"] = Path.GetFileName(pdfPath),
                    });
                }
                catch (Exception ex)
                {
                    Log("error", $"Blad przy rekordzie {rowNumber}: {ex}");
                    errors.Add(new JsonObject { ["row"] = rowNumber, ["message"] = ex.Message });
                    Event("record-error", $"Blad przy rekordzie {rowNumber}: {ex.Message}", new JsonObject { ["current"] = index, ["total"] = total, ["row"] = rowNumber, ["error"] = ex.Message });
                }
            }

            var ok = errors.Count == 0;
            var pdfCount = created.Count(c => c!["file"]!.GetValue<string>().EndsWith(".pdf", StringComparison.OrdinalIgnoreCase));
            var message = ok ? $"Zakonczono. Utworzono {pdfCount} PDF." : $"Zakonczono z bledami. Utworzono {pdfCount} PDF, bledy: {errors.Count}.";
            Event("finish", message, new JsonObject { ["total"] = created.Count + errors.Count, ["createdCount"] = created.Count, ["errorCount"] = errors.Count });
            var result = new JsonObject
            {
                ["ok"] = ok, ["message"] = message, ["created"] = created, ["errors"] = errors, ["outputDir"] = outputDir,
                ["total"] = created.Count + errors.Count, ["logPath"] = _input.LogPath, ["debugJsonPath"] = _input.DebugJsonPath,
                ["engine"] = "openxml",
            };
            WriteJsonLine(result);
            return result;
        }
        catch (Exception ex)
        {
            Log("error", $"Blad krytyczny: {ex}");
            Event("fatal", $"Blad krytyczny: {ex.Message}", new JsonObject { ["error"] = ex.Message });
            var result = new JsonObject
            {
                ["ok"] = false, ["fatal"] = true, ["message"] = ex.Message, ["created"] = created, ["errors"] = errors,
                ["outputDir"] = outputDir, ["logPath"] = _input.LogPath, ["debugJsonPath"] = _input.DebugJsonPath, ["engine"] = "openxml",
            };
            WriteJsonLine(result);
            return result;
        }
    }

    public (byte[] Docx, List<SmartBlockApplier.Issue> SmartIssues, JsonObject FieldMap) BuildRecordDocument(
        byte[] cleanTemplate, List<KeyValuePair<string, string>> record, List<TextMarkerReplacer.Rule> rules, PhotoGallery gallery, string address)
    {
        using var ms = new MemoryStream();
        ms.Write(cleanTemplate, 0, cleanTemplate.Length);
        ms.Position = 0;
        var smartIssues = new List<SmartBlockApplier.Issue>();
        var fieldMap = new JsonObject();
        using (var doc = WordprocessingDocument.Open(ms, true))
        {
            // Galeria szuka zdjec po adresie z kolumny adresu (jak w PowerShell),
            // nie po nazwie pliku - "rekord_N" nie ma folderu zdjec.
            var galleryAddress = TextNormalize.GetRecordValue(record, _input.AddressColumn);
            var imageDebug = gallery.Apply(doc, galleryAddress);

            var legacyDebug = new List<LegacyFillers.FillDebug>();
            int tableFilled = 0, narrativeFilled = 0;
            if (_input.SmartTemplateMode)
            {
                smartIssues = SmartBlockApplier.Apply(doc, record);
                foreach (var issue in smartIssues) Log(issue.Level, issue.Message);
            }
            else
            {
                tableFilled = LegacyFillers.FillHighlightedTableCells(doc, record, legacyDebug);
                narrativeFilled = LegacyFillers.FillNarrativeBlanks(doc, record, legacyDebug);
            }

            var fields = MergeFieldReplacer.ReplaceAll(doc, record);
            var markers = TextMarkerReplacer.ReplaceAll(doc, record, rules, _input.DebugMode);

            if (_input.DebugMode)
            {
                fieldMap["tableLabelFilled"] = tableFilled;
                fieldMap["narrativeFilled"] = narrativeFilled;
                fieldMap["legacy"] = JsonSerializer.SerializeToNode(legacyDebug, EventJson);
                fieldMap["imageFields"] = JsonSerializer.SerializeToNode(imageDebug, EventJson);
                fieldMap["fields"] = JsonSerializer.SerializeToNode(fields, EventJson);
                fieldMap["textMarkers"] = JsonSerializer.SerializeToNode(markers, EventJson);
            }
            doc.MainDocumentPart!.Document.Save();
        }
        return (ms.ToArray(), smartIssues, fieldMap);
    }

    // ------------------------------------------------------------ log/eventy
    private void Log(string level, string message) => Log(level, message, null);

    private void Log(string level, string message, JsonObject? data)
    {
        if (string.IsNullOrWhiteSpace(_input.LogPath)) return;
        var line = $"[{DateTime.Now:yyyy-MM-dd HH:mm:ss.fff}] [{level.ToUpperInvariant()}] {message}";
        if (data is not null) line += " " + data.ToJsonString(EventJson);
        lock (_logLock)
        {
            try { File.AppendAllText(_input.LogPath, line + Environment.NewLine, new UTF8Encoding(false)); } catch { }
        }
    }

    private void Event(string name, string message, JsonObject? data)
    {
        Log("info", message, data?.DeepClone().AsObject());
        var obj = new JsonObject { ["event"] = name, ["message"] = message, ["time"] = DateTimeOffset.Now.ToString("o") };
        if (data is not null)
        {
            foreach (var kv in data.ToList())
            {
                data.Remove(kv.Key);
                obj[kv.Key] = kv.Value;
            }
        }
        WriteJsonLine(obj);
    }

    private void WriteJsonLine(JsonObject obj)
    {
        var json = obj.ToJsonString(EventJson);
        lock (_logLock)
        {
            _stdout.WriteLine(json);
            _stdout.Flush();
            if (!string.IsNullOrWhiteSpace(_input.DebugJsonPath))
            {
                try { File.AppendAllText(_input.DebugJsonPath, json + Environment.NewLine, new UTF8Encoding(false)); } catch { }
            }
        }
    }
}
