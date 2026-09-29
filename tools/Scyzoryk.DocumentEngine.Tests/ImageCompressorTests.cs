using DocumentFormat.OpenXml.Packaging;
using DocumentFormat.OpenXml.Wordprocessing;
using Scyzoryk.DocumentEngine.Merge;
using SkiaSharp;
using Xunit;
using A = DocumentFormat.OpenXml.Drawing;
using DW = DocumentFormat.OpenXml.Drawing.Wordprocessing;
using PIC = DocumentFormat.OpenXml.Drawing.Pictures;

namespace Scyzoryk.DocumentEngine.Tests;

// Grafiki wzoru zmniejszane do 220 ppi rozmiaru na stronie (jak Word przy
// zapisie) - przeglad 2026-09-29.
public class ImageCompressorTests
{
    private static byte[] Jpeg(int w, int h)
    {
        using var bmp = new SKBitmap(w, h);
        using (var c = new SKCanvas(bmp)) { c.Clear(SKColors.SteelBlue); c.DrawCircle(w / 2f, h / 2f, h / 3f, new SKPaint { Color = SKColors.Orange }); }
        using var img = SKImage.FromBitmap(bmp);
        return img.Encode(SKEncodedImageFormat.Jpeg, 95).ToArray();
    }

    private static long Len(ImagePart p) { using var s = p.GetStream(FileMode.Open, FileAccess.Read); return s.Length; }
    private static SKBitmap Bmp(ImagePart p) { using var s = p.GetStream(FileMode.Open, FileAccess.Read); return SKBitmap.Decode(s); }

    private static Drawing Picture(string relId, long cx, long cy) => new Drawing(new DW.Inline(
        new DW.Extent { Cx = cx, Cy = cy },
        new DW.DocProperties { Id = 1U, Name = "obraz" },
        new A.Graphic(new A.GraphicData(new PIC.Picture(
            new PIC.NonVisualPictureProperties(new PIC.NonVisualDrawingProperties { Id = 0U, Name = "x.jpg" }, new PIC.NonVisualPictureDrawingProperties()),
            new PIC.BlipFill(new A.Blip { Embed = relId }, new A.Stretch(new A.FillRectangle())),
            new PIC.ShapeProperties(new A.Transform2D(new A.Offset { X = 0, Y = 0 }, new A.Extents { Cx = cx, Cy = cy }), new A.PresetGeometry { Preset = A.ShapeTypeValues.Rectangle })))
        { Uri = "http://schemas.openxmlformats.org/drawingml/2006/picture" })));

    [Fact]
    public void DuzyObrazWzoru_ZmniejszonyDo220ppi_RozmiarNaStronieBezZmian()
    {
        using var ms = new MemoryStream();
        using (var doc = WordprocessingDocument.Create(ms, DocumentFormat.OpenXml.WordprocessingDocumentType.Document))
        {
            var main = doc.AddMainDocumentPart();
            var img = main.AddImagePart(ImagePartType.Jpeg);
            using (var s = new MemoryStream(Jpeg(3000, 2000))) img.FeedData(s);
            var relId = main.GetIdOfPart(img);
            // 2 cale x 1,33 cala na stronie -> potrzeba ~440 x 293 px.
            main.Document = new Document(new Body(new Paragraph(new Run(Picture(relId, 1828800, 1219200)))));
            var before = Len(img);

            var result = ImageCompressor.Compress(doc);

            Assert.Equal(1, result.Compressed);
            using var decoded = Bmp(img);
            Assert.InRange(decoded.Width, 430, 460);
            Assert.True(Len(img) < before / 5, "plik wyraznie mniejszy");
            var ext = main.Document.Descendants<DW.Extent>().Single();
            Assert.Equal(1828800L, ext.Cx!.Value);
        }
    }

    [Fact]
    public void MalyObraz_i_ObrazBezZnanegoRozmiaru_ZostajaBezZmian()
    {
        using var ms = new MemoryStream();
        using var doc = WordprocessingDocument.Create(ms, DocumentFormat.OpenXml.WordprocessingDocumentType.Document);
        var main = doc.AddMainDocumentPart();
        var small = main.AddImagePart(ImagePartType.Jpeg);
        using (var s = new MemoryStream(Jpeg(400, 300))) small.FeedData(s);
        var orphan = main.AddImagePart(ImagePartType.Jpeg); // np. uzyty przez VML - brak a:blip
        using (var s = new MemoryStream(Jpeg(3000, 2000))) orphan.FeedData(s);
        main.Document = new Document(new Body(new Paragraph(new Run(Picture(main.GetIdOfPart(small), 1828800, 1371600)))));
        var orphanBefore = Len(orphan);

        var result = ImageCompressor.Compress(doc);

        Assert.Equal(0, result.Compressed);
        Assert.Equal(orphanBefore, Len(orphan));
    }

    [Fact]
    public void CiezkiJpeg_TeSameWymiary_MniejszyPlik()
    {
        var rnd = new Random(7);
        using var bmp = new SKBitmap(800, 600);
        for (var y = 0; y < 600; y++) for (var x = 0; x < 800; x++) bmp.SetPixel(x, y, new SKColor((byte)rnd.Next(256), (byte)rnd.Next(256), (byte)rnd.Next(256)));
        using var img = SKImage.FromBitmap(bmp);
        var heavy = img.Encode(SKEncodedImageFormat.Jpeg, 98).ToArray();
        var lighter = ImageCompressor.RecompressJpegIfHeavy(heavy);
        Assert.NotNull(lighter);
        Assert.True(lighter!.Length < heavy.Length * 0.75);
        using var decoded = SKBitmap.Decode(lighter);
        Assert.Equal(800, decoded.Width);
        Assert.Null(ImageCompressor.RecompressJpegIfHeavy(Jpeg(800, 600)));
    }
}
