namespace Scyzoryk.Launcher.Tests.Fakes;

public sealed class FakeLauncherLogger : ILauncherLogger
{
    public List<(LogLevel Level, string Message)> Entries { get; } = new();

    public void Log(LogLevel level, string message, IReadOnlyDictionary<string, string>? fields = null)
    {
        Entries.Add((level, message));
    }

    public bool HasEntryAt(LogLevel level) => Entries.Any(e => e.Level == level);
}
