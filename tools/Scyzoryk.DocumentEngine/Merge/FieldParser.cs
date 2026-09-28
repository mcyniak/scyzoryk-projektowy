using System.Text;
using System.Text.RegularExpressions;
using DocumentFormat.OpenXml;
using DocumentFormat.OpenXml.Wordprocessing;

namespace Scyzoryk.DocumentEngine.Merge;

// Odczyt pol Worda (MERGEFIELD itp.) bezposrednio z OOXML:
//  - "complex field": fldChar begin / instrText / fldChar separate / wynik / fldChar end,
//    rozrzucone po wielu runach (tak zapisuje je Word),
//  - "simple field": <w:fldSimple w:instr="..."> z runami wyniku w srodku.
public static class FieldParser
{
    private static readonly Regex MergeFieldNameRe = new(@"MERGEFIELD\s+(?:""([^""]+)""|([^\s\\]+))", RegexOptions.IgnoreCase | RegexOptions.Compiled);

    public sealed class ComplexField
    {
        public required Run BeginRun { get; init; }
        public Run? SeparateRun { get; set; }
        public Run? EndRun { get; set; }
        public StringBuilder Instruction { get; } = new();
        public bool InCode { get; set; } = true;
        // Wszystkie runy od begin do end wlacznie, w kolejnosci dokumentu.
        public List<Run> Runs { get; } = new();
        // Runy wyniku (miedzy separate a end).
        public List<Run> ResultRuns { get; } = new();
    }

    public static string? MergeFieldName(string instruction)
    {
        var m = MergeFieldNameRe.Match(instruction ?? "");
        if (!m.Success) return null;
        return m.Groups[1].Success ? m.Groups[1].Value.Trim() : m.Groups[2].Value.Trim();
    }

    public static List<ComplexField> ParseComplexFields(OpenXmlElement root)
    {
        var done = new List<ComplexField>();
        // Osobny stos per "kontener tresci" (korzen czesci albo konkretny
        // txbxContent) - Descendants() wchodzi w textbox w polowie akapitu
        // kotwicy, wiec wspolny stos pomieszalby pola z dwoch roznych miejsc.
        var stacks = new Dictionary<OpenXmlElement, Stack<ComplexField>>();

        foreach (var run in root.Descendants<Run>())
        {
            var container = ContainerOf(run, root);
            if (!stacks.TryGetValue(container, out var stack)) stacks[container] = stack = new Stack<ComplexField>();

            // Run nalezy do wszystkich otwartych pol (zagniezdzenia).
            var addedToOpen = false;
            foreach (var child in run.ChildElements)
            {
                if (child is FieldChar fc)
                {
                    var type = fc.FieldCharType?.Value;
                    if (type == FieldCharValues.Begin)
                    {
                        if (!addedToOpen) { AddRunToOpen(stack, run); addedToOpen = true; }
                        var field = new ComplexField { BeginRun = run };
                        field.Runs.Add(run);
                        stack.Push(field);
                    }
                    else if (type == FieldCharValues.Separate)
                    {
                        if (!addedToOpen) { AddRunToOpen(stack, run); addedToOpen = true; }
                        if (stack.Count > 0) { stack.Peek().SeparateRun = run; stack.Peek().InCode = false; }
                    }
                    else if (type == FieldCharValues.End)
                    {
                        if (!addedToOpen) { AddRunToOpen(stack, run); addedToOpen = true; }
                        if (stack.Count > 0)
                        {
                            var f = stack.Pop();
                            f.EndRun = run;
                            done.Add(f);
                        }
                    }
                }
                else if (child is FieldCode code)
                {
                    if (!addedToOpen) { AddRunToOpen(stack, run); addedToOpen = true; }
                    if (stack.Count > 0 && stack.Peek().InCode) stack.Peek().Instruction.Append(code.Text);
                }
            }
            if (!addedToOpen) AddRunToOpen(stack, run);
        }

        return done;
    }

    private static void AddRunToOpen(Stack<ComplexField> stack, Run run)
    {
        foreach (var f in stack)
        {
            if (!f.Runs.Contains(run)) f.Runs.Add(run);
            if (!f.InCode && !ReferenceEquals(run, f.SeparateRun) && !f.ResultRuns.Contains(run)) f.ResultRuns.Add(run);
        }
    }

    private static OpenXmlElement ContainerOf(OpenXmlElement e, OpenXmlElement root)
    {
        for (var p = e.Parent; p is not null && !ReferenceEquals(p, root); p = p.Parent)
        {
            if (p.LocalName == "txbxContent") return p;
        }
        return root;
    }

    // Formatowanie, jakie dostaje tekst wstawiony w miejsce pola: pierwszy run
    // wyniku z tekstem (Word COM: Field.Result.Text = ... zachowuje formatowanie
    // wyniku), w ostatecznosci run z fldChar begin.
    public static RunProperties? ResultFormatting(ComplexField field)
    {
        var withText = field.ResultRuns.FirstOrDefault(r => r.Elements<Text>().Any());
        var source = withText ?? field.ResultRuns.FirstOrDefault() ?? field.BeginRun;
        return source.RunProperties?.CloneNode(true) as RunProperties;
    }

    // Tekst -> runy (miekki enter dla znakow nowej linii z komorek Excela).
    public static List<Run> MakeTextRuns(string value, RunProperties? props)
    {
        var runs = new List<Run>();
        if (string.IsNullOrEmpty(value)) return runs;
        var run = new Run();
        if (props is not null) run.RunProperties = (RunProperties)props.CloneNode(true);
        var lines = value.Replace("\r\n", "\n").Replace('\r', '\n').Split('\n');
        for (var i = 0; i < lines.Length; i++)
        {
            if (i > 0) run.AppendChild(new Break());
            if (lines[i].Length > 0) run.AppendChild(new Text(lines[i]) { Space = SpaceProcessingModeValues.Preserve });
        }
        runs.Add(run);
        return runs;
    }

    // Zastepuje cale pole (begin..end) podanymi elementami - odpowiednik
    // Word COM: Result.Text = wartosc; Unlink().
    public static void ReplaceComplexField(ComplexField field, IEnumerable<OpenXmlElement> replacement)
    {
        var anchor = field.BeginRun;
        if (anchor.Parent is null) return;
        foreach (var e in replacement) anchor.InsertBeforeSelf(e);
        foreach (var r in field.Runs) r.Remove();
    }
}
