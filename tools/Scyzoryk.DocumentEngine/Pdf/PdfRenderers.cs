using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security;

namespace Scyzoryk.DocumentEngine.Pdf;

// DOCX -> PDF. Dwie implementacje za jednym interfejsem:
//  - OnlyOfficePdfRenderer (docelowa, darmowa): konwerter x2t.exe z ONLYOFFICE
//    (AGPL v3, uruchamiany jako osobny, niezmodyfikowany program - bez Worda).
//    Wybrany 2026-09-28 po porownaniu na prawdziwych dokumentach: ta sama
//    liczba stron co Word, wszystkie obrazy i zdjecia, bez znaku wodnego.
//    Odrzucone: LibreOffice (gubil zdjecia i skany w ostatniej sekcji
//    dokumentu), Syncfusion (platny dla firmy tej wielkosci), ONLYOFFICE
//    DocumentBuilder (znak wodny "Unregistered Version" - x2t go nie ma).
//  - WordPdfRenderer: Word COM TYLKO do zapisu gotowego DOCX jako PDF, jedna
//    instancja na paczke, obnizony priorytet - awaryjnie, gdy brak x2t.
public interface IPdfRenderer : IDisposable
{
    string Name { get; }
    void Render(byte[] docx, string pdfPath);
}

public static class PdfRendererFactory
{
    // mode: "auto" (domyslnie) | "onlyoffice" | "word"
    // auto = ONLYOFFICE x2t, jesli jest dostepny; inaczej Word (tylko PDF).
    public static IPdfRenderer Create(string? mode, string? onlyOfficeDir, Action<string, string> log)
    {
        var normalized = (mode ?? "auto").Trim().ToLowerInvariant();
        if (normalized == "word") return new WordPdfRenderer(log);
        var dir = OnlyOfficePdfRenderer.FindDirectory(onlyOfficeDir);
        if (dir is not null) return new OnlyOfficePdfRenderer(dir, log);
        if (normalized == "onlyoffice")
            throw new InvalidOperationException("Nie znaleziono konwertera PDF (ONLYOFFICE x2t.exe). Zbuduj go: powershell -File scripts/fetch-onlyoffice-x2t.ps1.");
        log("warn", "Brak konwertera PDF bez Worda (ONLYOFFICE x2t) - PDF zapisze Word (tylko ostatni krok).");
        return new WordPdfRenderer(log);
    }
}

public sealed class OnlyOfficePdfRenderer : IPdfRenderer
{
    public const string EnvDir = "SCYZORYK_ONLYOFFICE_DIR";
    private const int FormatPdf = 513; // AVS_OFFICESTUDIO_FILE_CROSSPLATFORM_PDF
    private readonly string _dir;
    private readonly Action<string, string> _log;
    private bool _fontsChecked;
    public string Name => "onlyoffice";

    public OnlyOfficePdfRenderer(string dir, Action<string, string> log)
    {
        _dir = dir;
        _log = log;
    }

    // Kolejnosc: jawny parametr -> zmienna srodowiskowa -> obok exe silnika
    // (instalator) -> repo (tryb deweloperski, po scripts/fetch-onlyoffice-x2t.ps1).
    public static string? FindDirectory(string? explicitDir)
    {
        var exeDir = AppContext.BaseDirectory;
        var candidates = new[]
        {
            explicitDir,
            Environment.GetEnvironmentVariable(EnvDir),
            Path.Combine(exeDir, "onlyoffice"),
            // tools/Scyzoryk.DocumentEngine/publish/ -> tools/onlyoffice
            Path.GetFullPath(Path.Combine(exeDir, "..", "..", "onlyoffice")),
            // tools/Scyzoryk.DocumentEngine/bin/Release/net8.0/win-x64/ -> tools/onlyoffice
            Path.GetFullPath(Path.Combine(exeDir, "..", "..", "..", "..", "..", "onlyoffice")),
        };
        foreach (var c in candidates)
        {
            if (!string.IsNullOrWhiteSpace(c) && File.Exists(Path.Combine(c, "x2t.exe"))) return Path.GetFullPath(c);
        }
        return null;
    }

    // x2t potrzebuje indeksu czcionek (sdkjs/common/AllFonts.js) zbudowanego
    // z czcionek TEGO komputera. Brak indeksu -> generujemy go raz przez
    // docbuilder.exe z pustym skryptem (robi to przy starcie).
    private void EnsureFonts()
    {
        if (_fontsChecked) return;
        _fontsChecked = true;
        var allFonts = Path.Combine(_dir, "sdkjs", "common", "AllFonts.js");
        if (File.Exists(allFonts)) return;
        var builder = Path.Combine(_dir, "docbuilder.exe");
        if (!File.Exists(builder)) throw new InvalidOperationException($"Brak indeksu czcionek ({allFonts}) i brak docbuilder.exe do jego zbudowania.");
        _log("info", "Buduje indeks czcionek dla konwertera PDF (jednorazowo).");
        var script = Path.Combine(Path.GetTempPath(), $"scyzoryk_fonts_{Guid.NewGuid():N}.docbuilder");
        File.WriteAllText(script, "");
        try { RunProcess(builder, $"\"{script}\"", _dir, TimeSpan.FromMinutes(5)); }
        finally { try { File.Delete(script); } catch { } }
        if (!File.Exists(allFonts)) throw new InvalidOperationException("Nie udalo sie zbudowac indeksu czcionek konwertera PDF.");
    }

    public void Render(byte[] docx, string pdfPath)
    {
        EnsureFonts();
        var work = Path.Combine(Path.GetTempPath(), $"scyzoryk_x2t_{Guid.NewGuid():N}");
        Directory.CreateDirectory(work);
        try
        {
            var input = Path.Combine(work, "in.docx");
            var output = Path.Combine(work, "out.pdf");
            File.WriteAllBytes(input, docx);
            var tmp = Path.Combine(work, "tmp");
            Directory.CreateDirectory(tmp);
            var fontDir = Environment.GetFolderPath(Environment.SpecialFolder.Fonts);
            var paramsXml =
                "<?xml version=\"1.0\" encoding=\"utf-8\"?>\n<TaskQueueDataConvert>" +
                $"<m_sFileFrom>{SecurityElement.Escape(input)}</m_sFileFrom>" +
                $"<m_sFileTo>{SecurityElement.Escape(output)}</m_sFileTo>" +
                $"<m_nFormatTo>{FormatPdf}</m_nFormatTo>" +
                $"<m_sFontDir>{SecurityElement.Escape(fontDir)}</m_sFontDir>" +
                $"<m_sAllFontsPath>{SecurityElement.Escape(Path.Combine(_dir, "sdkjs", "common", "AllFonts.js"))}</m_sAllFontsPath>" +
                $"<m_sTempDir>{SecurityElement.Escape(tmp)}</m_sTempDir>" +
                "<m_bIsNoBase64>true</m_bIsNoBase64>" +
                "</TaskQueueDataConvert>";
            var paramsPath = Path.Combine(work, "params.xml");
            File.WriteAllText(paramsPath, paramsXml, new System.Text.UTF8Encoding(false));

            var (code, stderr) = RunProcess(Path.Combine(_dir, "x2t.exe"), $"\"{paramsPath}\"", _dir, TimeSpan.FromMinutes(10));
            if (code != 0 || !File.Exists(output) || new FileInfo(output).Length == 0)
                throw new InvalidOperationException($"Konwersja do PDF nie powiodla sie (x2t kod {code}). {stderr}".Trim());
            File.Move(output, pdfPath, overwrite: true);
        }
        finally
        {
            try { Directory.Delete(work, recursive: true); } catch { }
        }
    }

    private static (int Code, string Stderr) RunProcess(string exe, string args, string cwd, TimeSpan timeout)
    {
        var psi = new ProcessStartInfo(exe, args)
        {
            WorkingDirectory = cwd,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardError = true,
            RedirectStandardOutput = true,
        };
        using var p = Process.Start(psi) ?? throw new InvalidOperationException($"Nie udalo sie uruchomic {exe}.");
        try { p.PriorityClass = ProcessPriorityClass.BelowNormal; } catch { }
        var stderrTask = p.StandardError.ReadToEndAsync();
        var stdoutTask = p.StandardOutput.ReadToEndAsync();
        if (!p.WaitForExit((int)timeout.TotalMilliseconds))
        {
            try { p.Kill(entireProcessTree: true); } catch { }
            throw new TimeoutException($"{Path.GetFileName(exe)} przekroczyl limit czasu {timeout.TotalMinutes} min.");
        }
        return (p.ExitCode, stderrTask.Result.Trim());
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
        var type = Type.GetTypeFromProgID("Word.Application") ?? throw new InvalidOperationException("Brak Microsoft Word na tym komputerze, a nie znaleziono konwertera PDF bez Worda (ONLYOFFICE x2t.exe - scripts/fetch-onlyoffice-x2t.ps1).");
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
