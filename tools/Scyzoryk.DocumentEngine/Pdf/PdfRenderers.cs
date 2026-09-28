using System.Diagnostics;
using System.Runtime.InteropServices;
using Syncfusion.DocIO;
using Syncfusion.DocIO.DLS;
using Syncfusion.DocIORenderer;

namespace Scyzoryk.DocumentEngine.Pdf;

// DOCX -> PDF. Dwie implementacje za jednym interfejsem:
//  - SyncfusionPdfRenderer: bez Worda, w tym samym procesie (docelowa),
//    wymaga klucza licencji Syncfusion - bez klucza biblioteka dopisuje na
//    kazdej stronie napis "Created with a trial version", czego NIE wolno
//    wyslac klientowi,
//  - WordPdfRenderer: Word COM TYLKO do ostatniego kroku (zapis PDF gotowego
//    DOCX-a), jedna instancja Worda na cala paczke, obnizony priorytet.
//    Zostaje jako sciezka przejsciowa/awaryjna, dopoki nie ma klucza.
public interface IPdfRenderer : IDisposable
{
    string Name { get; }
    void Render(byte[] docx, string pdfPath);
}

public static class PdfRendererFactory
{
    public const string EnvLicenseKey = "SCYZORYK_SYNCFUSION_LICENSE_KEY";

    // mode: "auto" (domyslnie) | "syncfusion" | "word"
    // auto = Syncfusion, jesli jest klucz licencji; inaczej Word (tylko PDF).
    public static IPdfRenderer Create(string? mode, string? licenseKey, Action<string, string> log)
    {
        var key = string.IsNullOrWhiteSpace(licenseKey) ? Environment.GetEnvironmentVariable(EnvLicenseKey) : licenseKey;
        var normalized = (mode ?? "auto").Trim().ToLowerInvariant();
        if (normalized == "word") return new WordPdfRenderer(log);
        if (normalized == "syncfusion") return new SyncfusionPdfRenderer(key, log);
        if (!string.IsNullOrWhiteSpace(key)) return new SyncfusionPdfRenderer(key, log);
        log("warn", "Brak klucza licencji Syncfusion - PDF zapisze Word (tylko ostatni krok, bez automatyzacji tresci). Dodaj klucz, zeby calkiem pominac Worda.");
        return new WordPdfRenderer(log);
    }
}

public sealed class SyncfusionPdfRenderer : IPdfRenderer
{
    private static bool _licenseRegistered;
    private readonly Action<string, string> _log;
    public string Name => "syncfusion";

    public SyncfusionPdfRenderer(string? licenseKey, Action<string, string> log)
    {
        _log = log;
        if (!string.IsNullOrWhiteSpace(licenseKey) && !_licenseRegistered)
        {
            Syncfusion.Licensing.SyncfusionLicenseProvider.RegisterLicense(licenseKey.Trim());
            _licenseRegistered = true;
        }
        else if (string.IsNullOrWhiteSpace(licenseKey))
        {
            log("warn", "Renderer Syncfusion bez klucza licencji - PDF bedzie mial napis o wersji probnej (tylko do testow).");
        }
    }

    public void Render(byte[] docx, string pdfPath)
    {
        using var input = new MemoryStream(docx, writable: false);
        using var document = new WordDocument(input, FormatType.Docx);
        using var renderer = new DocIORenderer();
        // Word przy zapisie PDF osadza czcionki - bez tego PDF u klienta bez
        // tych samych czcionek wyglada inaczej niz u nas.
        renderer.Settings.EmbedFonts = true;
        renderer.Settings.EmbedCompleteFonts = false;
        using var pdf = renderer.ConvertToPDF(document);
        var tmp = pdfPath + ".tmp";
        using (var output = File.Create(tmp)) pdf.Save(output);
        pdf.Close(true);
        File.Move(tmp, pdfPath, overwrite: true);
    }

    public void Dispose() { }
}

public sealed class WordPdfRenderer : IPdfRenderer
{
    private readonly Action<string, string> _log;
    private dynamic? _word;
    public string Name => "word";

    public WordPdfRenderer(Action<string, string> log) { _log = log; }

    private dynamic Word()
    {
        if (_word is not null) return _word;
        if (!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException("Zapis PDF przez Worda dziala tylko na Windows.");
        var type = Type.GetTypeFromProgID("Word.Application") ?? throw new InvalidOperationException("Brak Microsoft Word na tym komputerze, a nie skonfigurowano renderera PDF bez Worda (klucz Syncfusion).");
        var before = Process.GetProcessesByName("WINWORD").Select(p => p.Id).ToHashSet();
        _word = Activator.CreateInstance(type)!;
        _word.Visible = false;
        _word.DisplayAlerts = 0;
        try { _word.Options.UpdateLinksAtOpen = false; } catch { }
        try { _word.Options.ConfirmConversions = false; } catch { }
        try { _word.Options.SaveNormalPrompt = false; } catch { }
        try { _word.Options.BackgroundSave = false; } catch { }
        try { _word.AutomationSecurity = 3; } catch { }
        try
        {
            Thread.Sleep(300);
            foreach (var p in Process.GetProcessesByName("WINWORD").Where(p => !before.Contains(p.Id)))
            {
                p.PriorityClass = ProcessPriorityClass.BelowNormal;
            }
        }
        catch (Exception ex) { _log("warn", $"Nie udalo sie obnizyc priorytetu WINWORD.EXE: {ex.Message}"); }
        return _word;
    }

    public void Render(byte[] docx, string pdfPath)
    {
        var tmpDocx = Path.Combine(Path.GetTempPath(), $"scyzoryk_pdf_{Guid.NewGuid():N}.docx");
        File.WriteAllBytes(tmpDocx, docx);
        try
        {
            for (var attempt = 1; ; attempt++)
            {
                dynamic? doc = null;
                try
                {
                    doc = Word().Documents.Open(tmpDocx, false, true, false);
                    doc.SaveAs2(pdfPath, 17);
                    doc.Close(false);
                    return;
                }
                catch (COMException ex) when (attempt < 3 && IsTransient(ex))
                {
                    _log("warn", $"Word chwilowo zajety przy zapisie PDF (proba {attempt}/3): {ex.Message}");
                    try { doc?.Close(false); } catch { }
                    Thread.Sleep(1500 * attempt);
                }
                finally
                {
                    if (doc is not null) { try { Marshal.FinalReleaseComObject(doc); } catch { } }
                }
            }
        }
        finally
        {
            try { File.Delete(tmpDocx); } catch { }
        }
    }

    private static bool IsTransient(COMException ex)
    {
        var hr = (uint)ex.HResult;
        return hr is 0x80010001 or 0x8001010A or 0x8001010B or 0x800706BA or 0x80080005;
    }

    public void Dispose()
    {
        if (_word is null) return;
        try { _word.Quit(false); } catch { }
        try { Marshal.FinalReleaseComObject(_word); } catch { }
        _word = null;
        GC.Collect();
        GC.WaitForPendingFinalizers();
    }
}
