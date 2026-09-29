using System.Text.Json;
using DocumentFormat.OpenXml;
using DocumentFormat.OpenXml.Packaging;
using DocumentFormat.OpenXml.Wordprocessing;
using Scyzoryk.DocumentEngine.Merge;
using SkiaSharp;
using Xunit;

namespace Scyzoryk.DocumentEngine.Tests;

// Galeria zdjec na prawdziwych rozmiarach zdjec z aparatu/telefonu (przeglad
// 2026-09-28): duze zdjecie jest zmniejszane do obszaru tekstu, obrot EXIF
// z telefonu jest stosowany, kolejnosc jest naturalna (2 przed 10), a pole
// galerii znika z dokumentu.
public class PhotoGalleryTests : IDisposable
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), $"scyzoryk-zdjecia-{Guid.NewGuid():N}");

    public PhotoGalleryTests() => Directory.CreateDirectory(_dir);

    public void Dispose()
    {
        try { Directory.Delete(_dir, true); } catch { }
    }

    private static byte[] Jpeg(int w, int h, SKColor color)
    {
        using var bmp = new SKBitmap(w, h);
        using (var canvas = new SKCanvas(bmp)) canvas.Clear(color);
        using var img = SKImage.FromBitmap(bmp);
        using var data = img.Encode(SKEncodedImageFormat.Jpeg, 80);
        return data.ToArray();
    }

    // Wstawia segment APP1/EXIF z tagiem Orientation zaraz po SOI (tak zapisuja telefony).
    private static byte[] WithExifOrientation(byte[] jpeg, ushort orientation)
    {
        var tiff = new byte[]
        {
            0x4D, 0x4D, 0x00, 0x2A, 0x00, 0x00, 0x00, 0x08, // big-endian, IFD0 @ 8
            0x00, 0x01,                                     // 1 wpis
            0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, // Orientation, SHORT, count 1
            (byte)(orientation >> 8), (byte)orientation, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00,                         // brak kolejnego IFD
        };
        var exif = new List<byte> { 0x45, 0x78, 0x69, 0x66, 0x00, 0x00 };
        exif.AddRange(tiff);
        var len = exif.Count + 2;
        var segment = new List<byte> { 0xFF, 0xE1, (byte)(len >> 8), (byte)len };
        segment.AddRange(exif);
        return jpeg.Take(2).Concat(segment).Concat(jpeg.Skip(2)).ToArray();
    }

    [Fact]
    public void DuzeZdjecie_ZmniejszoneDoObszaruTekstu()
    {
        var prepared = PhotoGallery.PrepareImage(Jpeg(4000, 3000, SKColors.Red), 453, 700);
        Assert.Equal(453 * 12700L, prepared.Cx);
        Assert.InRange(prepared.Cy, (long)(453 * 0.75 * 12700) - 20000, (long)(453 * 0.75 * 12700) + 20000);
        using var decoded = SKBitmap.Decode(prepared.Bytes);
        Assert.True(decoded.Width <= 1400, $"piksele zmniejszone do ~220 ppi, jest {decoded.Width}");
    }

    [Fact]
    public void ZdjecieZTelefonu_ObrotExifStosowany()
    {
        // Sensor zapisal 4000x3000, telefon trzymany pionowo -> Orientation 6.
        var prepared = PhotoGallery.PrepareImage(WithExifOrientation(Jpeg(4000, 3000, SKColors.Blue), 6), 453, 700);
        Assert.True(prepared.Cy > prepared.Cx, "zdjecie pionowe po obrocie");
        using var decoded = SKBitmap.Decode(prepared.Bytes);
        Assert.True(decoded.Height > decoded.Width);
    }

    [Fact]
    public void Galeria_WstawiaZdjeciaWKolejnosciNaturalnejIUsuwaPole()
    {
        var p2 = Path.Combine(_dir, "b.jpg");
        var p10 = Path.Combine(_dir, "a.jpg");
        File.WriteAllBytes(p2, Jpeg(300, 400, SKColors.Green));   // IMG_2 - pionowe
        File.WriteAllBytes(p10, Jpeg(400, 300, SKColors.Green));  // IMG_10 - poziome
        var gallery = new PhotoGallery(new[]
        {
            new PhotoGallery.Photo("IMG_10.jpg", p10, "Kamion 5"),
            new PhotoGallery.Photo("IMG_2.jpg", p2, "Kamion 5"),
            new PhotoGallery.Photo("x.jpg", p10, "Kamion 15"),
        }, (_, _) => { });

        using var ms = new MemoryStream();
        using (var doc = WordprocessingDocument.Create(ms, WordprocessingDocumentType.Document))
        {
            var main = doc.AddMainDocumentPart();
            main.Document = new Document(new Body(
                new Paragraph(new Run(new Text("Zdjecia:"))),
                new Paragraph(new SimpleField(new Run(new Text("«Zdjecia_pomontazowe»"))) { Instruction = " MERGEFIELD Zdjecia_pomontazowe " }),
                new SectionProperties()));
            var debug = gallery.Apply(doc, "kamion 5");
            Assert.Equal(2, debug.Count(d => d.Status == "image_inserted"));
            var extents = main.Document.Descendants<DocumentFormat.OpenXml.Drawing.Wordprocessing.Extent>().ToList();
            Assert.Equal(2, extents.Count);
            Assert.True(extents[0].Cy!.Value > extents[0].Cx!.Value, "IMG_2 (pionowe) pierwsze");
            Assert.True(extents[1].Cx!.Value > extents[1].Cy!.Value, "IMG_10 (poziome) drugie");
            Assert.Empty(main.Document.Descendants<SimpleField>());
            Assert.Equal(2, main.ImageParts.Count());
        }
    }

    [Fact]
    public void Galeria_BezZdjecDlaAdresu_PoleZnika()
    {
        var gallery = new PhotoGallery(Array.Empty<PhotoGallery.Photo>(), (_, _) => { });
        using var ms = new MemoryStream();
        using var doc = WordprocessingDocument.Create(ms, WordprocessingDocumentType.Document);
        var main = doc.AddMainDocumentPart();
        main.Document = new Document(new Body(new Paragraph(new SimpleField(new Run(new Text("x"))) { Instruction = " MERGEFIELD Zdjecia_pomontazowe " })));
        var debug = gallery.Apply(doc, "Kamion 5");
        Assert.Contains(debug, d => d.Status == "no_images_removed");
        Assert.Empty(main.Document.Descendants<SimpleField>());
    }
}
