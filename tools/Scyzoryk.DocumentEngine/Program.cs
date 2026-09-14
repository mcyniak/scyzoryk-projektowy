using System.Text;
using System.Text.Json;
using Scyzoryk.DocumentEngine.Commands;

namespace Scyzoryk.DocumentEngine;

// CLI wywolywane przez lib/documentEngine.js (Node) - jeden plik JSON UTF-8
// bez BOM na wejsciu, jeden na wyjsciu (sekcja 2 promptu migracji: "Node ma
// uruchamiac helper przez pliki JSON UTF-8 bez BOM, nie przez duze argumenty
// CLI"). Diagnostyka techniczna idzie na stderr (po polsku, jak wszedzie w
// repo), stdout jest zarezerwowany na krotki komunikat "OK"/"BLAD" - caly
// prawdziwy wynik jest w pliku OutputJson (machine-readable).
//
// Uzycie: Scyzoryk.DocumentEngine.exe <command> <inputJsonPath> <outputJsonPath>
public static class Program
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        WriteIndented = false,
    };

    public static int Main(string[] args)
    {
        try { Console.OutputEncoding = Encoding.UTF8; } catch { /* ignore - np. gdy stdout jest przekierowany do pliku bez konsoli */ }

        if (args.Length != 3)
        {
            Console.Error.WriteLine("Uzycie: Scyzoryk.DocumentEngine <command> <inputJsonPath> <outputJsonPath>");
            Console.Error.WriteLine("Dostepne polecenia: scan-palette, scan-candidates, build-template");
            return 1;
        }

        var command = args[0];
        var inputPath = args[1];
        var outputPath = args[2];

        try
        {
            switch (command)
            {
                case "scan-palette":
                {
                    var input = ReadInput<ScanPaletteInput>(inputPath);
                    var output = ScanTemplateCommand.RunPalette(input);
                    WriteOutput(outputPath, output);
                    return output.Ok ? 0 : 1;
                }
                case "scan-candidates":
                {
                    var input = ReadInput<ScanCandidatesInput>(inputPath);
                    var output = ScanTemplateCommand.RunCandidates(input);
                    WriteOutput(outputPath, output);
                    return output.Ok ? 0 : 1;
                }
                case "build-template":
                {
                    var input = ReadInput<BuildTemplateInput>(inputPath);
                    var output = BuildTemplateCommand.Run(input);
                    WriteOutput(outputPath, output);
                    return output.Ok ? 0 : 1;
                }
                default:
                    Console.Error.WriteLine($"Nieznane polecenie: {command}");
                    return 1;
            }
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"Nieoczekiwany blad: {ex}");
            try
            {
                WriteOutput(outputPath, new { ok = false, message = $"Nieoczekiwany blad silnika dokumentow: {ex.Message}" });
            }
            catch { /* nawet zapis bledu sie nie udal - stderr powyzej to jedyna diagnostyka */ }
            return 1;
        }
    }

    private static T ReadInput<T>(string path)
    {
        var json = File.ReadAllText(path, Encoding.UTF8);
        return JsonSerializer.Deserialize<T>(json, JsonOptions)
            ?? throw new InvalidOperationException($"Nie udalo sie odczytac wejscia JSON: {path}");
    }

    private static void WriteOutput<T>(string path, T value)
    {
        var json = JsonSerializer.Serialize(value, JsonOptions);
        // UTF8Encoding(false) = bez BOM, zgodnie z konwencja calego repo
        // (patrz lib/hardening.js#writeJsonFileNoBom) - Node's JSON.parse
        // dlawi sie na BOM na poczatku pliku.
        File.WriteAllText(path, json, new UTF8Encoding(false));
    }
}
