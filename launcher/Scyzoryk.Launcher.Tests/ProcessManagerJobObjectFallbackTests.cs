using System.Diagnostics;
using System.Runtime.InteropServices;
using Xunit;

namespace Scyzoryk.Launcher.Tests;

/// <summary>
/// Sprawdza fallback dodany po incydencie z 2026-08-12 (StopOwnedProcesses
/// pominal glowny proces-nadzorce server.js podczas prawdziwej aktualizacji na
/// produkcji - dokladna przyczyna niedeterministyczna, patrz KillProcessById
/// w ProcessManager.cs dla wlasciwej, gwarantowanej siatki bezpieczenstwa).
/// Ten test pokazuje jedna KONKRETNA sytuacje, w ktorej proc.Kill(entireProcessTree:
/// true) moze rzucic Win32Exception - proces juz przypisany do obcego Job
/// Object bez prawa zagniezdzenia - i potwierdza, ze mimo to proces zostaje
/// zabity dzieki fallbackowi na zwykle Kill(), zamiast cicho przezyc.
/// </summary>
public sealed class ProcessManagerJobObjectFallbackTests
{
    [Fact]
    public void StopOwnedProcesses_KillsProcessEvenWhenTreeKillFailsDueToExistingJobObject()
    {
        var nodeExe = ResolveRealNodeExePath();

        using var proc = Process.Start(new ProcessStartInfo
        {
            FileName = nodeExe,
            ArgumentList = { "-e", "setInterval(() => {}, 1000);" },
            UseShellExecute = false,
            CreateNoWindow = true,
        }) ?? throw new InvalidOperationException("Nie udalo sie uruchomic testowego procesu node.exe.");

        var jobHandle = NativeMethods.CreateJobObject(IntPtr.Zero, null);
        Assert.NotEqual(IntPtr.Zero, jobHandle);
        try
        {
            // Bez JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK/BREAKAWAY_OK - dokladnie to,
            // co powoduje konflikt przy proznie zagniezdzenia w drugim jobie.
            var assigned = NativeMethods.AssignProcessToJobObject(jobHandle, proc.Handle);
            Assert.True(assigned, "Nie udalo sie przypisac testowego procesu do Job Object - test nie odtwarza scenariusza.");

            var stopped = new ProcessManager().StopOwnedProcesses(nodeExe);

            Assert.Contains(proc.Id, stopped);
            Assert.True(proc.WaitForExit(5000), "Proces powinien zostac zabity mimo konfliktu Job Object (fallback na Kill()).");
        }
        finally
        {
            NativeMethods.CloseHandle(jobHandle);
            try { if (!proc.HasExited) proc.Kill(); } catch { /* juz martwy - ok */ }
        }
    }

    private static string ResolveRealNodeExePath()
    {
        var fromPath = Environment.GetEnvironmentVariable("PATH")?.Split(Path.PathSeparator)
            .Select(dir => Path.Combine(dir, "node.exe"))
            .FirstOrDefault(File.Exists);
        return fromPath ?? throw new InvalidOperationException("node.exe nie znaleziony w PATH - test wymaga prawdziwego node.exe.");
    }

    private static class NativeMethods
    {
        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        public static extern IntPtr CreateJobObject(IntPtr jobAttributes, string? name);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool CloseHandle(IntPtr handle);
    }
}
