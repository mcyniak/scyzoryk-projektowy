using DocumentFormat.OpenXml;
using DocumentFormat.OpenXml.Packaging;
using SkiaSharp;
using A = DocumentFormat.OpenXml.Drawing;
using DW = DocumentFormat.OpenXml.Drawing.Wordprocessing;

namespace Scyzoryk.DocumentEngine.Merge;

// Zmniejszanie grafik zapisanych w SAMYM wzorze (logo w naglowku, karty
// katalogowe, rysunki) - przeglad 2026-09-29. Word przy zapisie dokumentu
// sam zmniejszal obrazy do 220 ppi rozmiaru na stronie (domyslna kompresja
// obrazow), nowy silnik kopiowal oryginaly: PDF-y wychodzily ~2x wieksze niz
// z Worda (porownanie na wzorze Wierzchlas: 11 MB zamiast 5 MB), a ZIP z
// paczka adresow odpowiednio wiekszy. Wyglad sie nie zmienia - obraz ma na
// stronie ten sam rozmiar, tylko mniej zbednych pikseli.
//
// Bezpiecznie i zachowawczo:
//  - tylko JPEG/PNG (EMF/WMF/SVG/TIFF zostaja nietkniete),
//  - rozmiar na stronie brany z KAZDEGO uzycia obrazu (wp:extent + ewentualne
//    przyciecie a:srcRect); jesli obraz jest uzyty gdzies, gdzie nie znamy
//    rozmiaru (np. stary VML), zostaje nietkniety,
//  - zmniejszamy tylko gdy oszczednosc jest wyrazna (>25% pikseli w kazdym wymiarze),
//  - wynik wieksze niz oryginal (np. PNG) -> zostaje oryginal.
public static class ImageCompressor
{
    private const double TargetPpi = 220;
    private const double EmuPerInch = 914400;

    public sealed record Result(int Compressed, long BytesBefore, long BytesAfter);

    public static Result Compress(WordprocessingDocument doc, Action<string, string>? log = null)
    {
        if (Environment.GetEnvironmentVariable("SCYZORYK_NO_IMAGE_COMPRESSION") == "1") return new Result(0, 0, 0);
        var main = doc.MainDocumentPart;
        if (main is null) return new Result(0, 0, 0);

        // ImagePart (po URI) -> potrzebne piksele (max ze wszystkich uzyc) albo null = nieznane.
        var need = new Dictionary<Uri, (double W, double H)?>();
        var partsByUri = new Dictionary<Uri, ImagePart>();

        var hosts = new List<OpenXmlPart> { main };
        hosts.AddRange(main.HeaderParts);
        hosts.AddRange(main.FooterParts);
        if (main.FootnotesPart is not null) hosts.Add(main.FootnotesPart);
        if (main.EndnotesPart is not null) hosts.Add(main.EndnotesPart);

        foreach (var host in hosts)
        {
            var root = host.RootElement;
            if (root is null) continue;
            var usedIds = new HashSet<string>();
            foreach (var blip in root.Descendants<A.Blip>())
            {
                var relId = blip.Embed?.Value;
                if (string.IsNullOrEmpty(relId)) continue;
                usedIds.Add(relId);
                if (host.GetPartById(relId) is not ImagePart img) continue;
                partsByUri[img.Uri] = img;
                var extent = blip.Ancestors<DW.Inline>().FirstOrDefault()?.Extent
                             ?? (OpenXmlElement?)blip.Ancestors<DW.Anchor>().FirstOrDefault()?.GetFirstChild<DW.Extent>();
                var ext = extent as DW.Extent;
                if (ext?.Cx is null || ext.Cy is null) { need[img.Uri] = null; continue; }
                var src = blip.Parent?.GetFirstChild<A.SourceRectangle>();
                double visW = 1, visH = 1;
                if (src is not null)
                {
                    visW = 1 - ((src.Left?.Value ?? 0) + (src.Right?.Value ?? 0)) / 100000.0;
                    visH = 1 - ((src.Top?.Value ?? 0) + (src.Bottom?.Value ?? 0)) / 100000.0;
                    if (visW <= 0.01 || visH <= 0.01) { need[img.Uri] = null; continue; }
                }
                var w = ext.Cx.Value / EmuPerInch * TargetPpi / visW;
                var h = ext.Cy.Value / EmuPerInch * TargetPpi / visH;
                if (!need.TryGetValue(img.Uri, out var prev)) need[img.Uri] = (w, h);
                else if (prev is not null) need[img.Uri] = (Math.Max(prev.Value.W, w), Math.Max(prev.Value.H, h));
            }
            // Obrazy tej czesci uzyte inaczej niz przez a:blip (VML v:imagedata,
            // pola INCLUDEPICTURE...) - rozmiar nieznany, nie ruszamy.
            foreach (var pair in host.Parts)
            {
                if (pair.OpenXmlPart is ImagePart img && !usedIds.Contains(pair.RelationshipId)) need[img.Uri] = null;
            }
        }

        int count = 0;
        long before = 0, after = 0;
        foreach (var (uri, target) in need)
        {
            if (target is null || !partsByUri.TryGetValue(uri, out var part)) continue;
            var type = part.ContentType.ToLowerInvariant();
            if (type is not ("image/jpeg" or "image/jpg" or "image/png")) continue;
            byte[] bytes;
            using (var s = part.GetStream(FileMode.Open, FileAccess.Read))
            using (var copy = new MemoryStream()) { s.CopyTo(copy); bytes = copy.ToArray(); }
            try
            {
                var isPng = type == "image/png";
                var smaller = Downscale(bytes, isPng, target.Value.W, target.Value.H);
                if (smaller is null && !isPng) smaller = RecompressJpegIfHeavy(bytes);
                if (smaller is null || smaller.Length >= bytes.Length) continue;
                using (var ms = new MemoryStream(smaller)) part.FeedData(ms);
                count++;
                before += bytes.Length;
                after += smaller.Length;
            }
            catch (Exception ex)
            {
                log?.Invoke("warn", $"Nie udalo sie zmniejszyc obrazu {uri}: {ex.Message}");
            }
        }
        if (count > 0) log?.Invoke("info", $"Zmniejszono {count} obrazow wzoru (do {TargetPpi} ppi / jakosc JPEG {RecompressJpegQuality}): {before / 1024} KB -> {after / 1024} KB.");
        return new Result(count, before, after);
    }

    // Ponowna kompresja JPEG bez zmiany wymiarow: Word przy eksporcie do PDF
    // zapisuje zdjecia z jakoscia ~80 (w porownaniu Wierzchlas: te same
    // 1386x1959 px zajmowaly u Worda ~350 KB, u nas ~715 KB). Tylko pliki
    // wyraznie "ciezkie" (> 0,2 bajta na piksel) i tylko gdy zysk > 25%.
    public const int RecompressJpegQuality = 80;
    public static byte[]? RecompressJpegIfHeavy(byte[] bytes)
    {
        using var data = SKData.CreateCopy(bytes);
        using var codec = SKCodec.Create(data);
        if (codec is null || codec.EncodedFormat != SKEncodedImageFormat.Jpeg) return null;
        var origin = codec.EncodedOrigin;
        if (origin != SKEncodedOrigin.TopLeft && origin != SKEncodedOrigin.Default) return null;
        var pixels = (double)codec.Info.Width * codec.Info.Height;
        if (pixels <= 0 || bytes.Length / pixels < 0.2) return null;
        using var decoded = SKBitmap.Decode(codec);
        if (decoded is null) return null;
        using var image = SKImage.FromBitmap(decoded);
        using var encoded = image.Encode(SKEncodedImageFormat.Jpeg, RecompressJpegQuality);
        var result = encoded?.ToArray();
        return result is not null && result.Length < bytes.Length * 0.75 ? result : null;
    }

    // null = bez zmian (obraz juz wystarczajaco maly albo nieczytelny).
    public static byte[]? Downscale(byte[] bytes, bool isPng, double needW, double needH)
    {
        using var data = SKData.CreateCopy(bytes);
        using var codec = SKCodec.Create(data);
        if (codec is null) return null;
        var origin = codec.EncodedOrigin;
        if (origin != SKEncodedOrigin.TopLeft && origin != SKEncodedOrigin.Default) return null; // obrot EXIF - nie ryzykujemy
        var info = codec.Info;
        var targetW = (int)Math.Ceiling(needW);
        var targetH = (int)Math.Ceiling(needH);
        if (targetW < 1 || targetH < 1) return null;
        // Proporcje zachowane: skala wg wiekszego z wymaganych wymiarow.
        var scale = Math.Max(targetW / (double)info.Width, targetH / (double)info.Height);
        if (scale > 0.75) return null; // oszczednosc za mala - zostawiamy oryginal
        var w = Math.Max(1, (int)Math.Round(info.Width * scale));
        var h = Math.Max(1, (int)Math.Round(info.Height * scale));
        using var decoded = SKBitmap.Decode(codec);
        if (decoded is null) return null;
        using var resized = decoded.Resize(new SKImageInfo(w, h, decoded.ColorType, decoded.AlphaType), new SKSamplingOptions(SKCubicResampler.Mitchell));
        if (resized is null) return null;
        using var image = SKImage.FromBitmap(resized);
        using var encoded = image.Encode(isPng ? SKEncodedImageFormat.Png : SKEncodedImageFormat.Jpeg, 85);
        return encoded?.ToArray();
    }
}
