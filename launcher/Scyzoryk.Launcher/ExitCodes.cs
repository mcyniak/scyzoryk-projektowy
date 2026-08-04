namespace Scyzoryk.Launcher;

public static class ExitCodes
{
    public const int Ok = 0;
    public const int HealthNotResponding = 1;
    public const int UnknownArgument = 2;
    public const int MissingFile = 3;
    public const int StartupFailed = 4;
    public const int UnhandledException = 10;
}
