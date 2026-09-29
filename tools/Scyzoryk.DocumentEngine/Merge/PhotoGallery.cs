using System.Text.Json;
using DocumentFormat.OpenXml;
using DocumentFormat.OpenXml.Packaging;
using DocumentFormat.OpenXml.Wordprocessing;
using SkiaSharp;
using A = DocumentFormat.OpenXml.Drawing;
using DW = DocumentFormat.OpenXml.Drawing.Wordprocessing;
using PIC = DocumentFormat.OpenXml.Drawing.Pictures;

namespace Scyzoryk.DocumentEngine.Merge;

// Galeria zdjec (Replace-PhotoGalleryMergeField z mailmerge-to-pdf.ps1):
// pole MERGEFIELD Zdjecia_pomontazowe jest zastepowane WSZYSTKIMI zdjeciami z
// folderu adresu (manifest zdjec z serwera), jedno pod drugim (miekki enter),
// kazde inline. Brak zdjec albo niejednoznaczny folder -> pole znika.
//
// ROZMIAR: skrypt PowerShell probowal ograniczac zdjecia do 425 x 311 pt
// (Resize-InlinePicture), ale porownanie z prawdziwym wynikiem Worda
// (2026-09-28, te same pliki, obie sciezki) pokazalo, ze w praktyce Word
// wstawia zdjecie w rozmiarze naturalnym zmniejszonym do szerokosci/wysokosci
// obszaru tekstu strony - ograniczenie 425 x 311 nigdy realnie nie dzialalo.
// Nowy silnik odtwarza to, co uzytkownicy FAKTYCZNIE dostawali (dopasowanie do
// obszaru tekstu), a nie niedzialajacy zamiar - zmiana wygladu gotowych
// dokumentow bylaby niespodzianka. Stary limit zostaje jako opcja
// (UseLegacyBox), gdyby wlasciciel wolal mniejsze zdjecia.
//
// Roznice wobec Worda, swiadome:
//  - orientacja EXIF (zdjecia z telefonu) jest stosowana do pikseli, zeby
//    zdjecie w PDF stalo tak, jak w galerii telefonu,
//  - zdjecie jest zmniejszane do 220 ppi rozmiaru na stronie (to samo robi Word
//    przy zapisie - domyslna kompresja obrazow), zeby DOCX/PDF nie puchly o
//    pelnowymiarowe zdjecia z aparatu.
public sealed class PhotoGallery
{
    public const string GalleryFieldName = "Zdjecia_pomontazowe";
    private static readonly string GalleryKey = TextNormalize.NormalizeAddress(GalleryFieldName);
    private const double LegacyMaxWidthPt = 425;
    private const double LegacyMaxHeightPt = 311;
    public bool UseLegacyBox { get; set; }
    private const double TargetPpi = 220;
    private const long EmuPerPoint = 12700;

    public sealed record Photo(string OriginalName, string StoredPath, string AddressFolder);
    public sealed record GalleryDebug(string Status, string? Path = null, string? Error = null, IReadOnlyList<string>? Folders = null);

    private readonly List<Photo> _photos;
    private readonly Action<string, string> _log;
    // Cache przetworzonych zdjec: ten sam plik moze trafic do wielu rekordow
    // (i do kilku szablonow w jednym zadaniu) - skalujemy go raz.
    private readonly Dictionary<string, PreparedImage> _cache = new(StringComparer.OrdinalIgnoreCase);

    public sealed record PreparedImage(byte[] Bytes, string ContentType, long Cx, long Cy);

    public PhotoGallery(IEnumerable<Photo> photos, Action<string, string> log)
    {
        _photos = photos.ToList();
        _log = log;
    }

    public static PhotoGallery Load(string? manifestPath, Action<string, string> log)
    {
        var photos = new List<Photo>();
        if (!string.IsNullOrWhiteSpace(manifestPath) && File.Exists(manifestPath))
        {
            try
            {
                using var json = JsonDocument.Parse(File.ReadAllText(manifestPath));
                if (json.RootElement.TryGetProperty("files", out var files) && files.ValueKind == JsonValueKind.Array)
                {
                    foreach (var f in files.EnumerateArray())
                    {
                        if (f.ValueKind != JsonValueKind.Object) continue;
                        photos.Add(new Photo(
                            Str(f, "originalName"),
                            Str(f, "storedPath"),
                            Str(f, "addressFolder")));
                    }
                }
            }
            catch (Exception ex)
            {
                log("warn", $"Nie udalo sie wczytac manifestu zdjec: {ex.Message}");
            }
        }
        return new PhotoGallery(photos, log);
    }

    private static string Str(JsonElement e, string name) =>
        e.TryGetProperty(name, out var v) && v.ValueKind != JsonValueKind.Null ? (v.ValueKind == JsonValueKind.String ? v.GetString() ?? "" : v.ToString()) : "";

    public static bool IsGalleryFieldName(string? name) =>
        !string.IsNullOrWhiteSpace(name) && TextNormalize.NormalizeAddress(name) == GalleryKey;

    // Find-PhotosForAddress
    public (string Status, List<Photo> Photos, List<string> Folders) FindPhotosForAddress(string address)
    {
        var key = TextNormalize.NormalizeAddress(address);
        if (string.IsNullOrWhiteSpace(key)) return ("ok", new(), new());
        var groups = new Dictionary<string, List<Photo>>();
        var order = new List<string>();
        foreach (var file in _photos)
        {
            var ext = Path.GetExtension(file.OriginalName).ToLowerInvariant();
            if (ext is not (".jpg" or ".jpeg" or ".png")) continue;
            if (TextNormalize.NormalizeAddress(file.AddressFolder) != key) continue;
            if (!groups.TryGetValue(file.AddressFolder, out var list)) { groups[file.AddressFolder] = list = new(); order.Add(file.AddressFolder); }
            list.Add(file);
        }
        if (groups.Count == 0) return ("ok", new(), new());
        if (groups.Count > 1) return ("ambiguous", new(), groups.Keys.OrderBy(k => k, StringComparer.Ordinal).ToList());
        var sorted = groups[order[0]].OrderBy(p => TextNormalize.NaturalSortKey(p.OriginalName), StringComparer.Ordinal).ToList();
        return ("ok", sorted, new());
    }

    public List<GalleryDebug> Apply(WordprocessingDocument doc, string address)
    {
        var debug = new List<GalleryDebug>();
        var main = doc.MainDocumentPart;
        if (main?.Document is null) return debug;

        // Tylko glowny tekst - Word COM Document.Fields tez obejmowal tylko glowna historie.
        while (true)
        {
            var complex = FieldParser.ParseComplexFields(main.Document)
                .FirstOrDefault(f => IsGalleryFieldName(FieldParser.MergeFieldName(f.Instruction.ToString())));
            var simple = complex is null
                ? main.Document.Descendants<SimpleField>().FirstOrDefault(s => IsGalleryFieldName(FieldParser.MergeFieldName(s.Instruction?.Value ?? "")))
                : null;
            if (complex is null && simple is null) break;

            var resolved = FindPhotosForAddress(address);
            var replacement = new List<OpenXmlElement>();
            if (resolved.Status == "ambiguous")
            {
                _log("warn", $"Niejednoznaczne foldery zdjec dla adresu '{address}'. Zdjecia pominieto. ({string.Join(", ", resolved.Folders)})");
                debug.Add(new GalleryDebug("ambiguous_skipped", Folders: resolved.Folders));
            }
            else if (resolved.Photos.Count == 0)
            {
                _log("info", $"Brak zdjec dla {address} - generuje dokument bez zdjec.");
                debug.Add(new GalleryDebug("no_images_removed"));
            }
            else
            {
                _log("info", $"Zdjecia dla {address}: {resolved.Photos.Count}");
                var props = complex is not null
                    ? FieldParser.ResultFormatting(complex)
                    : simple!.Descendants<Run>().FirstOrDefault()?.RunProperties?.CloneNode(true) as RunProperties;
                var nextDocPrId = NextDocPrId(doc);
                var anchor = (OpenXmlElement?)complex?.BeginRun ?? simple!;
                var (boxW, boxH) = UseLegacyBox ? (LegacyMaxWidthPt, LegacyMaxHeightPt) : TextAreaPt(main, anchor);
                for (var i = 0; i < resolved.Photos.Count; i++)
                {
                    var photo = resolved.Photos[i];
                    _log("info", $"Wstawiam {photo.OriginalName}");
                    try
                    {
                        var prepared = Prepare(photo.StoredPath, boxW, boxH);
                        var run = new Run();
                        if (props is not null) run.RunProperties = (RunProperties)props.CloneNode(true);
                        run.AppendChild(BuildInlineDrawing(main, prepared, nextDocPrId++, Path.GetFileName(photo.StoredPath)));
                        if (i < resolved.Photos.Count - 1) run.AppendChild(new Break());
                        replacement.Add(run);
                        debug.Add(new GalleryDebug("image_inserted", photo.StoredPath));
                    }
                    catch (Exception ex)
                    {
                        _log("warn", $"Nie udalo sie wstawic zdjecia '{photo.OriginalName}' dla adresu '{address}': {ex.Message}");
                        debug.Add(new GalleryDebug("image_error", Error: ex.Message));
                    }
                }
            }

            if (complex is not null) FieldParser.ReplaceComplexField(complex, replacement);
            else
            {
                foreach (var e in replacement) simple!.InsertBeforeSelf(e);
                simple!.Remove();
            }
        }
        return debug;
    }

    private static uint NextDocPrId(WordprocessingDocument doc)
    {
        uint max = 0;
        foreach (var part in OpenXml.PackageWalker.EnumerateParts(doc))
        {
            foreach (var dp in part.Root.Descendants<DW.DocProperties>())
            {
                if (dp.Id is not null && dp.Id.HasValue && dp.Id.Value > max) max = dp.Id.Value;
            }
        }
        return max + 1;
    }

    // Obszar tekstu sekcji, w ktorej stoi pole (rozmiar strony minus marginesy),
    // w punktach. Sekcje w OOXML: w:sectPr w akapicie konczy sekcje, ostatnia
    // sekcja ma w:sectPr bezposrednio w w:body.
    public static (double W, double H) TextAreaPt(MainDocumentPart main, OpenXmlElement anchor)
    {
        SectionProperties? sect = null;
        var body = main.Document?.Body;
        var para = anchor as Paragraph ?? anchor.Ancestors<Paragraph>().LastOrDefault();
        if (body is not null && para is not null)
        {
            var top = para.Ancestors().LastOrDefault(a => ReferenceEquals(a.Parent, body)) ?? para;
            for (var e = top; e is not null; e = e.NextSibling())
            {
                if (e is Paragraph p && p.ParagraphProperties?.SectionProperties is { } s) { sect = s; break; }
                if (e is SectionProperties bs) { sect = bs; break; }
            }
        }
        sect ??= body?.GetFirstChild<SectionProperties>();
        var size = sect?.GetFirstChild<PageSize>();
        var margin = sect?.GetFirstChild<PageMargin>();
        double pageW = size?.Width?.Value ?? 11906, pageH = size?.Height?.Value ?? 16838; // A4 w twipach
        double left = margin?.Left?.Value ?? 1417, right = margin?.Right?.Value ?? 1417;
        double topM = Math.Abs(margin?.Top?.Value ?? 1417), bottomM = Math.Abs(margin?.Bottom?.Value ?? 1417);
        var w = Math.Max(72, (pageW - left - right) / 20.0);
        var h = Math.Max(72, (pageH - topM - bottomM) / 20.0);
        return (w, h);
    }

    public PreparedImage Prepare(string path, double maxWidthPt, double maxHeightPt)
    {
        var key = $"{path}|{maxWidthPt:F1}|{maxHeightPt:F1}";
        if (_cache.TryGetValue(key, out var cached)) return cached;
        var prepared = PrepareImage(File.ReadAllBytes(path), maxWidthPt, maxHeightPt);
        _cache[key] = prepared;
        return prepared;
    }

    public static PreparedImage PrepareImage(byte[] bytes, double maxWidthPt, double maxHeightPt)
    {
        using var data = SKData.CreateCopy(bytes);
        using var codec = SKCodec.Create(data) ?? throw new InvalidOperationException("Nieobslugiwany format zdjecia (oczekiwano JPG/PNG).");
        var isPng = codec.EncodedFormat == SKEncodedImageFormat.Png;
        var origin = codec.EncodedOrigin;
        var info = codec.Info;
        var swap = origin is SKEncodedOrigin.LeftTop or SKEncodedOrigin.RightTop or SKEncodedOrigin.RightBottom or SKEncodedOrigin.LeftBottom;
        var pxW = swap ? info.Height : info.Width;
        var pxH = swap ? info.Width : info.Height;

        // Rozmiar "naturalny" jak w Wordzie (96 dpi, gdy plik nie mowi inaczej),
        // potem dopasowanie do ramki z zachowaniem proporcji: najpierw
        // szerokosc, potem wysokosc.
        var dpi = ReadDpi(bytes, isPng) ?? 96.0;
        var wPt = pxW / dpi * 72.0;
        var hPt = pxH / dpi * 72.0;
        if (wPt > maxWidthPt) { hPt = hPt * maxWidthPt / wPt; wPt = maxWidthPt; }
        if (hPt > maxHeightPt) { wPt = wPt * maxHeightPt / hPt; hPt = maxHeightPt; }

        var targetW = Math.Max(1, (int)Math.Round(wPt / 72.0 * TargetPpi));
        var targetH = Math.Max(1, (int)Math.Round(hPt / 72.0 * TargetPpi));
        var needsResize = targetW < pxW || targetH < pxH;
        var needsRotate = origin != SKEncodedOrigin.TopLeft && origin != SKEncodedOrigin.Default;

        byte[] outBytes = bytes;
        // Zdjecie juz we wlasciwym rozmiarze, ale "ciezkie" (jakosc aparatu) -
        // ta sama ponowna kompresja co dla grafik wzoru (patrz ImageCompressor).
        if (!needsResize && !needsRotate && !isPng)
            outBytes = ImageCompressor.RecompressJpegIfHeavy(bytes) ?? bytes;
        if (needsResize || needsRotate)
        {
            using var decoded = SKBitmap.Decode(codec) ?? throw new InvalidOperationException("Nie udalo sie odczytac zdjecia.");
            using var oriented = ApplyOrigin(decoded, origin);
            var w = needsResize ? targetW : oriented.Width;
            var h = needsResize ? targetH : oriented.Height;
            using var resized = (w == oriented.Width && h == oriented.Height)
                ? oriented.Copy()
                : oriented.Resize(new SKImageInfo(w, h), new SKSamplingOptions(SKCubicResampler.Mitchell));
            using var image = SKImage.FromBitmap(resized);
            using var encoded = image.Encode(isPng ? SKEncodedImageFormat.Png : SKEncodedImageFormat.Jpeg, 85);
            outBytes = encoded.ToArray();
        }

        return new PreparedImage(outBytes, isPng ? "image/png" : "image/jpeg",
            (long)Math.Round(wPt * EmuPerPoint), (long)Math.Round(hPt * EmuPerPoint));
    }

    private static SKBitmap ApplyOrigin(SKBitmap src, SKEncodedOrigin origin)
    {
        if (origin is SKEncodedOrigin.TopLeft or SKEncodedOrigin.Default) return src.Copy();
        var swap = origin is SKEncodedOrigin.LeftTop or SKEncodedOrigin.RightTop or SKEncodedOrigin.RightBottom or SKEncodedOrigin.LeftBottom;
        var dst = new SKBitmap(swap ? src.Height : src.Width, swap ? src.Width : src.Height, src.ColorType, src.AlphaType);
        using var canvas = new SKCanvas(dst);
        float w = src.Width, h = src.Height;
        // x' = ScaleX*x + SkewX*y + TransX ; y' = SkewY*x + ScaleY*y + TransY
        var m = origin switch
        {
            SKEncodedOrigin.TopRight => new SKMatrix(-1, 0, w, 0, 1, 0, 0, 0, 1),     // lustro poziome
            SKEncodedOrigin.BottomRight => new SKMatrix(-1, 0, w, 0, -1, h, 0, 0, 1), // 180
            SKEncodedOrigin.BottomLeft => new SKMatrix(1, 0, 0, 0, -1, h, 0, 0, 1),   // lustro pionowe
            SKEncodedOrigin.LeftTop => new SKMatrix(0, 1, 0, 1, 0, 0, 0, 0, 1),       // transpozycja
            SKEncodedOrigin.RightTop => new SKMatrix(0, -1, h, 1, 0, 0, 0, 0, 1),     // 90 w prawo
            SKEncodedOrigin.RightBottom => new SKMatrix(0, -1, h, -1, 0, w, 0, 0, 1), // transwersja
            SKEncodedOrigin.LeftBottom => new SKMatrix(0, 1, 0, -1, 0, w, 0, 0, 1),   // 90 w lewo
            _ => SKMatrix.Identity,
        };
        canvas.SetMatrix(m);
        canvas.DrawBitmap(src, 0, 0);
        canvas.Flush();
        return dst;
    }

    // JFIF (APP0) gestosc w dpi / PNG pHYs. EXIF XResolution celowo pominiete -
    // aparaty zapisuja tam zwykle 72 niezaleznie od niczego.
    private static double? ReadDpi(byte[] b, bool isPng)
    {
        try
        {
            if (isPng)
            {
                var i = 8;
                while (i + 12 <= b.Length)
                {
                    var len = (b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3];
                    var type = System.Text.Encoding.ASCII.GetString(b, i + 4, 4);
                    if (type == "pHYs" && len >= 9)
                    {
                        var x = (uint)((b[i + 8] << 24) | (b[i + 9] << 16) | (b[i + 10] << 8) | b[i + 11]);
                        var unit = b[i + 16];
                        if (unit == 1 && x > 0) return x * 0.0254;
                        return null;
                    }
                    if (type == "IDAT") return null;
                    i += 12 + len;
                }
                return null;
            }
            if (b.Length > 18 && b[0] == 0xFF && b[1] == 0xD8 && b[2] == 0xFF && b[3] == 0xE0 &&
                b[6] == (byte)'J' && b[7] == (byte)'F' && b[8] == (byte)'I' && b[9] == (byte)'F')
            {
                var units = b[13];
                var xd = (b[14] << 8) | b[15];
                if (xd <= 0) return null;
                if (units == 1) return xd;
                if (units == 2) return xd * 2.54;
            }
        }
        catch { /* uszkodzony naglowek - zostaje domyslne 96 dpi */ }
        return null;
    }

    private static Drawing BuildInlineDrawing(MainDocumentPart main, PreparedImage img, uint docPrId, string name)
    {
        var imagePart = main.AddImagePart(img.ContentType == "image/png" ? ImagePartType.Png : ImagePartType.Jpeg);
        using (var ms = new MemoryStream(img.Bytes)) imagePart.FeedData(ms);
        var relId = main.GetIdOfPart(imagePart);

        var inline = new DW.Inline(
            new DW.Extent { Cx = img.Cx, Cy = img.Cy },
            new DW.EffectExtent { LeftEdge = 0L, TopEdge = 0L, RightEdge = 0L, BottomEdge = 0L },
            new DW.DocProperties { Id = docPrId, Name = $"Zdjecie {docPrId}" },
            new DW.NonVisualGraphicFrameDrawingProperties(new A.GraphicFrameLocks { NoChangeAspect = true }),
            new A.Graphic(
                new A.GraphicData(
                    new PIC.Picture(
                        new PIC.NonVisualPictureProperties(
                            new PIC.NonVisualDrawingProperties { Id = 0U, Name = name },
                            new PIC.NonVisualPictureDrawingProperties(new A.PictureLocks { NoChangeAspect = true })),
                        new PIC.BlipFill(
                            new A.Blip { Embed = relId },
                            new A.Stretch(new A.FillRectangle())),
                        new PIC.ShapeProperties(
                            new A.Transform2D(
                                new A.Offset { X = 0L, Y = 0L },
                                new A.Extents { Cx = img.Cx, Cy = img.Cy }),
                            new A.PresetGeometry(new A.AdjustValueList()) { Preset = A.ShapeTypeValues.Rectangle })))
                { Uri = "http://schemas.openxmlformats.org/drawingml/2006/picture" }))
        {
            DistanceFromTop = 0U,
            DistanceFromBottom = 0U,
            DistanceFromLeft = 0U,
            DistanceFromRight = 0U,
        };
        return new Drawing(inline);
    }
}
