namespace Scyzoryk.DocumentEngine.Pdf;

// Nastepca lib/printing/docx-to-pdf.ps1: paczka DOCX -> PDF jednym
// rendererem (jedna sesja, jak dotad). Format wyniku identyczny jak w
// PowerShell ({ok, results:[{ok, input, output | error}]}), zeby
// lib/printing.js#convertDocxBatchToPdf nie musial nic zmieniac w konsumentach.
public sealed class RenderPdfInput
{
    public List<FileItem> Files { get; set; } = new();
    public string? PdfRenderer { get; set; }
    public string? SyncfusionLicenseKey { get; set; }

    public sealed class FileItem
    {
        public string InputPath { get; set; } = "";
        public string OutputPath { get; set; } = "";
    }
}

public sealed class RenderPdfResultItem
{
    public bool Ok { get; set; }
    public string Input { get; set; } = "";
    public string? Output { get; set; }
    public string? Error { get; set; }
}

public sealed class RenderPdfOutput
{
    public bool Ok { get; set; }
    public string? Renderer { get; set; }
    public List<RenderPdfResultItem> Results { get; set; } = new();
    public string? Error { get; set; }
}

public static class RenderPdfCommand
{
    public static RenderPdfOutput Run(RenderPdfInput input, Action<string, string>? log = null)
    {
        log ??= (level, msg) => Console.Error.WriteLine($"[{level}] {msg}");
        var output = new RenderPdfOutput { Ok = true };
        using var renderer = PdfRendererFactory.Create(input.PdfRenderer, input.SyncfusionLicenseKey, log);
        output.Renderer = renderer.Name;
        foreach (var item in input.Files)
        {
            try
            {
                if (!File.Exists(item.InputPath)) throw new FileNotFoundException($"Nie znaleziono pliku DOCX: {item.InputPath}");
                var dir = Path.GetDirectoryName(item.OutputPath);
                if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
                renderer.Render(File.ReadAllBytes(item.InputPath), item.OutputPath);
                output.Results.Add(new RenderPdfResultItem { Ok = true, Input = item.InputPath, Output = item.OutputPath });
            }
            catch (Exception ex)
            {
                output.Results.Add(new RenderPdfResultItem { Ok = false, Input = item.InputPath, Error = ex.Message });
            }
        }
        return output;
    }
}
