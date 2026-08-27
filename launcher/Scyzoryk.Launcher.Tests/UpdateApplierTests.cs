using System.Text.Json;
using Scyzoryk.Launcher.Tests.Fakes;
using Xunit;

namespace Scyzoryk.Launcher.Tests;

/// <summary>
/// UpdateApplier zastepuje dawny scripts\run-update.ps1 (patrz komentarz w
/// LauncherApp.RunApplyUpdateAsync dla pelnego uzasadnienia). Testy tutaj
/// pokrywaja wylacznie orkiestracje (kolejnosc krokow, kontrakt plikowy
/// last-result.json/update-*.log, ktory czyta lib/updateService.js) - nigdy
/// nie odpalaja prawdziwego instalatora. Zamiast tego uzywaja jako
/// "InstallerPath" malego, prawdziwego pliku wykonywalnego z ustalonym kodem
/// wyjscia (dotnet/cmd nie sa potrzebne - wystarczy dowolny .exe z PATH).
/// </summary>
public sealed class UpdateApplierTests
{
    // Uzywamy cmd.exe /c exit <kod> jako "instalatora" - jedyny w pelni
    // przenosny sposob na kontrolowany kod wyjscia bez budowania wlasnego
    // pomocniczego .exe. UpdateApplier i tak przekazuje dodatkowe /VERYSILENT
    // itd. argumenty, ktore cmd.exe po prostu ignoruje (cmd /c bierze TYLKO
    // pierwszy "argument" po /c jako komende, reszta to argumenty do niej -
    // zamiast tego uzywamy wrappera .cmd, ktory sam wywoluje "exit").
    private static string WriteFakeInstaller(string dir, int exitCode)
    {
        var path = Path.Combine(dir, "fake-installer.cmd");
        File.WriteAllText(path, $"@exit /b {exitCode}\r\n");
        return path;
    }

    private sealed class IsolatedRoots : IDisposable
    {
        public string UpdateRoot { get; }
        public string DataRoot { get; }
        private readonly string? _previousUpdateRoot;
        private readonly string? _previousDataRoot;

        public IsolatedRoots()
        {
            var baseDir = Path.Combine(Path.GetTempPath(), "scyzoryk-updateapplier-tests-" + Guid.NewGuid().ToString("N"));
            UpdateRoot = Path.Combine(baseDir, "Updates");
            DataRoot = Path.Combine(baseDir, "Data");
            Directory.CreateDirectory(UpdateRoot);
            Directory.CreateDirectory(DataRoot);

            _previousUpdateRoot = Environment.GetEnvironmentVariable("SCYZORYK_UPDATE_ROOT");
            _previousDataRoot = Environment.GetEnvironmentVariable("SCYZORYK_DATA_ROOT");
            Environment.SetEnvironmentVariable("SCYZORYK_UPDATE_ROOT", UpdateRoot);
            Environment.SetEnvironmentVariable("SCYZORYK_DATA_ROOT", DataRoot);
        }

        public void Dispose()
        {
            Environment.SetEnvironmentVariable("SCYZORYK_UPDATE_ROOT", _previousUpdateRoot);
            Environment.SetEnvironmentVariable("SCYZORYK_DATA_ROOT", _previousDataRoot);
            try { Directory.Delete(Path.GetDirectoryName(UpdateRoot)!, recursive: true); } catch { }
        }
    }

    private static JsonElement ReadLastResult(string updateRoot)
    {
        var json = File.ReadAllText(Path.Combine(updateRoot, "last-result.json"));
        return JsonDocument.Parse(json).RootElement.Clone();
    }

    [Fact]
    public async Task Success_InstallerExitsZero_HealthReportsExpectedVersion_WritesOkResult()
    {
        using var dir = new TempInstallDir();
        using var roots = new IsolatedRoots();
        var paths = InstallPaths.FromInstallDir(dir.Path);
        var installerPath = WriteFakeInstaller(roots.UpdateRoot, exitCode: 0);

        var process = new FakeProcessManager();
        var health = new FakeHealthChecker { RespondOnceResult = true, AlreadyRunningResult = true, RunningVersionResult = "1.2.3" };
        var applier = new UpdateApplier(process, health, paths, new FakeLauncherLogger());

        var exitCode = await applier.ApplyAsync(installerPath, "1.2.3");

        Assert.Equal(0, exitCode);
        Assert.Equal(1, process.StopOwnedProcessesCallCount);
        Assert.Equal(1, process.StartServerCallCount);
        // Rezydentna ikona w zasobniku (jesli aktywna) musi byc zamknieta PRZED
        // uruchomieniem instalatora, inaczej trzymalaby otwarty wlasny Scyzoryk.exe,
        // ktory instalator wlasnie probuje nadpisac.
        Assert.Equal(1, process.StopResidentTrayProcessesCallCount);
        Assert.Equal(paths.ScyzorykExePath, process.LastExpectedScyzorykExeFullPath);

        var result = ReadLastResult(roots.UpdateRoot);
        Assert.True(result.GetProperty("ok").GetBoolean());
        Assert.Equal("1.2.3", result.GetProperty("version").GetString());
        Assert.Equal(0, result.GetProperty("exitCode").GetInt32());

        var logFiles = Directory.GetFiles(Path.Combine(roots.UpdateRoot, "logs"), "update-*.log");
        Assert.Single(logFiles);
        Assert.True(new FileInfo(logFiles[0]).Length > 0);
    }

    [Fact]
    public async Task InstallerFails_NonZeroExitCode_WritesFailedResult_StillRestarts()
    {
        using var dir = new TempInstallDir();
        using var roots = new IsolatedRoots();
        var paths = InstallPaths.FromInstallDir(dir.Path);
        var installerPath = WriteFakeInstaller(roots.UpdateRoot, exitCode: 5);

        var process = new FakeProcessManager();
        var health = new FakeHealthChecker { RespondOnceResult = true, AlreadyRunningResult = true, RunningVersionResult = "1.0.0" };
        // installRetryDelay skrocone - ten fake installer ZAWSZE zwraca 5, wiec
        // retry (patrz RunInstallerWithRetryAsync) i tak wyczerpie obie proby.
        var applier = new UpdateApplier(process, health, paths, new FakeLauncherLogger(),
            installRetryDelay: TimeSpan.FromMilliseconds(10));

        var exitCode = await applier.ApplyAsync(installerPath, "1.2.3");

        Assert.Equal(5, exitCode);
        Assert.Equal(1, process.StartServerCallCount); // restart dzieje sie NIEZALEZNIE od wyniku, dopiero po wyczerpaniu prob

        var result = ReadLastResult(roots.UpdateRoot);
        Assert.False(result.GetProperty("ok").GetBoolean());
        Assert.Equal(5, result.GetProperty("exitCode").GetInt32());
    }

    // =====================================================================
    // Audyt na zywo 2026-08-10: prawdziwa awaria produkcyjna ("aktualizacja
    // sie wyjebala jak zawsze") - instalator zwrocil kod 5 (Inno Setup:
    // przerwane kopiowanie, cicho "potwierdzone" jako Abort przez
    // /SUPPRESSMSGBOXES), zostawiajac cala nowa apke (apps\formularze-varmero,
    // wraz z node_modules) NIESKOPIOWANA, mimo ze exitCode/build-info.json
    // sugerowaly czesciowy postep. Reczny retry TEGO SAMEGO instalatora
    // zadzialal od razu. Testy nizej pokrywaja automatyzacje tego retry +
    // weryfikacje integralnosci po kopiowaniu (RunInstallerWithRetryAsync/
    // DescribeIntegrityIssue w UpdateApplier.cs).
    // =====================================================================

    [Fact]
    public async Task TransientInstallerFailure_AutoRetrySucceeds_ReportsOkFromSecondAttempt()
    {
        using var dir = new TempInstallDir();
        using var roots = new IsolatedRoots();
        var paths = InstallPaths.FromInstallDir(dir.Path);

        // "Instalator", ktory za PIERWSZYM razem zawodzi (kod 5), a za drugim
        // (gdy plik-znacznik juz istnieje) konczy sie sukcesem - symuluje
        // przejsciowa blokade pliku/skan antywirusa, dokladnie to, co
        // naprawil reczny retry na produkcji.
        var marker = Path.Combine(roots.UpdateRoot, "flaky-marker.txt");
        var installerPath = Path.Combine(roots.UpdateRoot, "fake-flaky-installer.cmd");
        File.WriteAllText(installerPath,
            "@echo off\r\n" +
            $"if exist \"{marker}\" (\r\n" +
            "  exit /b 0\r\n" +
            ") else (\r\n" +
            $"  type nul > \"{marker}\"\r\n" +
            "  exit /b 5\r\n" +
            ")\r\n");

        var process = new FakeProcessManager();
        var health = new FakeHealthChecker { RespondOnceResult = true, AlreadyRunningResult = true, RunningVersionResult = "1.2.3" };
        var applier = new UpdateApplier(process, health, paths, new FakeLauncherLogger(),
            installRetryDelay: TimeSpan.FromMilliseconds(10));

        var exitCode = await applier.ApplyAsync(installerPath, "1.2.3");

        Assert.Equal(0, exitCode); // kod z DRUGIEJ (udanej) proby
        var result = ReadLastResult(roots.UpdateRoot);
        Assert.True(result.GetProperty("ok").GetBoolean());
        // Restart Scyzoryka i tak dzieje sie dokladnie raz, dopiero PO
        // wyczerpaniu prob instalacji - nie po kazdej probie z osobna.
        Assert.Equal(1, process.StartServerCallCount);
        // Zatrzymanie procesow: raz przed pierwsza proba, raz przed retry.
        Assert.Equal(2, process.StopOwnedProcessesCallCount);
    }

    [Fact]
    public async Task InstallerReportsSuccess_ButExpectedAppNeverAppearsOnDisk_TreatedAsFailureAfterRetries()
    {
        // Wariant integralnosci: instalator sam w sobie zglasza kod 0 (nie 5),
        // ale caly katalog nowej aplikacji z apps\* nigdy sie nie pojawia -
        // server.js (jedyne prawdziwe zrodlo listy aplikacji) juz o niej wie.
        using var dir = new TempInstallDir();
        File.WriteAllText(Path.Combine(dir.Path, "server.js"),
            "const apps = [{ slug: 'testapp', dir: path.join(ROOT, 'apps', 'testapp') }];");
        using var roots = new IsolatedRoots();
        var paths = InstallPaths.FromInstallDir(dir.Path);
        var installerPath = WriteFakeInstaller(roots.UpdateRoot, exitCode: 0);

        var process = new FakeProcessManager();
        var health = new FakeHealthChecker { RespondOnceResult = true, AlreadyRunningResult = true, RunningVersionResult = "1.2.3" };
        var applier = new UpdateApplier(process, health, paths, new FakeLauncherLogger(),
            installRetryDelay: TimeSpan.FromMilliseconds(10));

        var exitCode = await applier.ApplyAsync(installerPath, "1.2.3");

        Assert.Equal(0, exitCode); // sam instalator "twierdzi" ze sukces
        var result = ReadLastResult(roots.UpdateRoot);
        Assert.False(result.GetProperty("ok").GetBoolean());
        Assert.Contains("testapp", result.GetProperty("message").GetString());
    }

    [Fact]
    public async Task IntegrityIssueOnFirstAttempt_FixedBySecondAttempt_ReportsOk()
    {
        // Lustrzane odbicie powyzszego: pierwsza proba zostawia "testapp" bez
        // node_modules (integrity fail mimo exitCode 0), druga proba (ten sam
        // instalator, ale symulujacy ze tym razem kopiowanie sie udalo)
        // faktycznie tworzy node_modules - koncowy wynik musi byc sukcesem.
        using var dir = new TempInstallDir();
        File.WriteAllText(Path.Combine(dir.Path, "server.js"),
            "const apps = [{ slug: 'testapp', dir: path.join(ROOT, 'apps', 'testapp') }];");
        using var roots = new IsolatedRoots();
        var paths = InstallPaths.FromInstallDir(dir.Path);

        var marker = Path.Combine(roots.UpdateRoot, "attempt-marker.txt");
        var nodeModulesDir = Path.Combine(dir.Path, "apps", "testapp", "node_modules");
        var installerPath = Path.Combine(roots.UpdateRoot, "fake-integrity-installer.cmd");
        File.WriteAllText(installerPath,
            "@echo off\r\n" +
            $"if exist \"{marker}\" (\r\n" +
            $"  mkdir \"{nodeModulesDir}\"\r\n" +
            $"  type nul > \"{Path.Combine(nodeModulesDir, "pkg.txt")}\"\r\n" +
            "  exit /b 0\r\n" +
            ") else (\r\n" +
            $"  type nul > \"{marker}\"\r\n" +
            "  exit /b 0\r\n" +
            ")\r\n");

        var process = new FakeProcessManager();
        var health = new FakeHealthChecker { RespondOnceResult = true, AlreadyRunningResult = true, RunningVersionResult = "1.2.3" };
        var applier = new UpdateApplier(process, health, paths, new FakeLauncherLogger(),
            installRetryDelay: TimeSpan.FromMilliseconds(10));

        var exitCode = await applier.ApplyAsync(installerPath, "1.2.3");

        Assert.Equal(0, exitCode);
        var result = ReadLastResult(roots.UpdateRoot);
        Assert.True(result.GetProperty("ok").GetBoolean());
        Assert.True(Directory.Exists(nodeModulesDir));
    }

    [Fact]
    public async Task InstallerExitsZero_ButOldVersionStillRunningAfterRestart_TreatedAsFailure()
    {
        // Audyt v1.0.4, P0-8: Restart Manager potrafi po cichu pominac
        // zablokowany plik, dajac exitCode 0 mimo braku faktycznej podmiany.
        using var dir = new TempInstallDir();
        using var roots = new IsolatedRoots();
        var paths = InstallPaths.FromInstallDir(dir.Path);
        var installerPath = WriteFakeInstaller(roots.UpdateRoot, exitCode: 0);

        var process = new FakeProcessManager();
        var health = new FakeHealthChecker { RespondOnceResult = true, AlreadyRunningResult = true, RunningVersionResult = "1.1.0" }; // stara wersja
        var applier = new UpdateApplier(process, health, paths, new FakeLauncherLogger());

        var exitCode = await applier.ApplyAsync(installerPath, "1.2.3");

        Assert.Equal(0, exitCode); // kod wyjscia instalatora zostaje, ale...
        var result = ReadLastResult(roots.UpdateRoot);
        Assert.False(result.GetProperty("ok").GetBoolean()); // ...ok jest false
        Assert.Contains("1.1.0", result.GetProperty("message").GetString());
    }

    [Fact]
    public async Task InstallerThrows_RestartStillHappens_ResultWritten()
    {
        using var dir = new TempInstallDir();
        using var roots = new IsolatedRoots();
        var paths = InstallPaths.FromInstallDir(dir.Path);
        var missingInstaller = Path.Combine(roots.UpdateRoot, "does-not-exist.exe");

        var process = new FakeProcessManager();
        var health = new FakeHealthChecker { RespondOnceResult = false };
        var applier = new UpdateApplier(process, health, paths, new FakeLauncherLogger());

        var exitCode = await applier.ApplyAsync(missingInstaller, "1.2.3");

        Assert.Equal(-1, exitCode);
        Assert.Equal(1, process.StartServerCallCount); // restart w finally, mimo wyjatku

        var result = ReadLastResult(roots.UpdateRoot);
        Assert.False(result.GetProperty("ok").GetBoolean());
    }

    [Fact]
    public async Task StaleDeadPidPrintLock_DoesNotBlockInstallation()
    {
        using var dir = new TempInstallDir();
        using var roots = new IsolatedRoots();
        var paths = InstallPaths.FromInstallDir(dir.Path);
        var installerPath = WriteFakeInstaller(roots.UpdateRoot, exitCode: 0);

        var lockDir = Path.Combine(roots.DataRoot, "runtime", "printing");
        Directory.CreateDirectory(lockDir);
        // PID praktycznie na pewno nie odpowiadajacy zadnemu zywemu procesowi.
        File.WriteAllText(Path.Combine(lockDir, "active.lock"), "{\"pid\": 999999}");

        var process = new FakeProcessManager();
        var health = new FakeHealthChecker { RespondOnceResult = true, AlreadyRunningResult = true, RunningVersionResult = "1.2.3" };
        var applier = new UpdateApplier(process, health, paths, new FakeLauncherLogger());

        var exitCode = await applier.ApplyAsync(installerPath, "1.2.3");

        Assert.Equal(0, exitCode);
        Assert.Equal(1, process.StopOwnedProcessesCallCount);
    }

    // =====================================================================
    // Audyt rozdz. 26, P0/P1: dawny run-update.ps1 (i jego pierwszy port na
    // C#) po limicie oczekiwania na koniec druku WYMUSZAL aktualizacje -
    // zatrzymywal procesy i instalowal mimo aktywnego druku. Testy nizej
    // uzywaja krotkiego, wstrzykniętego limitu/interwalu (konstruktor
    // UpdateApplier), zeby nie czekac realnych 30s na kazde uruchomienie.
    // =====================================================================

    [Fact]
    public async Task PrintingStillActiveAfterTimeout_DefersUpdate_NeverStopsOrInstalls()
    {
        using var dir = new TempInstallDir();
        using var roots = new IsolatedRoots();
        var paths = InstallPaths.FromInstallDir(dir.Path);
        var installerPath = WriteFakeInstaller(roots.UpdateRoot, exitCode: 0);

        var lockDir = Path.Combine(roots.DataRoot, "runtime", "printing");
        Directory.CreateDirectory(lockDir);
        // Wlasny PID procesu testowego - gwarantowanie "zywy" proces przez caly test.
        File.WriteAllText(Path.Combine(lockDir, "active.lock"), $"{{\"pid\": {Environment.ProcessId}}}");

        var process = new FakeProcessManager();
        var health = new FakeHealthChecker { RespondOnceResult = true, AlreadyRunningResult = true, RunningVersionResult = "1.2.3" };
        var applier = new UpdateApplier(process, health, paths, new FakeLauncherLogger(),
            printWaitTimeout: TimeSpan.FromMilliseconds(50), printPollInterval: TimeSpan.FromMilliseconds(10));

        var exitCode = await applier.ApplyAsync(installerPath, "1.2.3");

        Assert.Equal(-1, exitCode);
        Assert.Equal(0, process.StopOwnedProcessesCallCount); // NIGDY nie zatrzymano procesow Scyzoryka
        Assert.Equal(0, process.StartServerCallCount); // NIGDY nie uruchomiono ponownie - nic nie bylo zatrzymywane

        var result = ReadLastResult(roots.UpdateRoot);
        Assert.False(result.GetProperty("ok").GetBoolean());
        Assert.Contains("odlozona", result.GetProperty("message").GetString());
    }

    [Fact]
    public async Task UnreadableCorruptedPrintLock_TreatedConservativelyAsActive_DefersUpdate()
    {
        using var dir = new TempInstallDir();
        using var roots = new IsolatedRoots();
        var paths = InstallPaths.FromInstallDir(dir.Path);
        var installerPath = WriteFakeInstaller(roots.UpdateRoot, exitCode: 0);

        var lockDir = Path.Combine(roots.DataRoot, "runtime", "printing");
        Directory.CreateDirectory(lockDir);
        File.WriteAllText(Path.Combine(lockDir, "active.lock"), "{niepoprawny json");

        var process = new FakeProcessManager();
        var health = new FakeHealthChecker { RespondOnceResult = true, AlreadyRunningResult = true, RunningVersionResult = "1.2.3" };
        var applier = new UpdateApplier(process, health, paths, new FakeLauncherLogger(),
            printWaitTimeout: TimeSpan.FromMilliseconds(50), printPollInterval: TimeSpan.FromMilliseconds(10));

        var exitCode = await applier.ApplyAsync(installerPath, "1.2.3");

        Assert.Equal(-1, exitCode);
        Assert.Equal(0, process.StopOwnedProcessesCallCount);
    }

    [Fact]
    public async Task InstallerSucceeds_ButHealthCheckNeverResponds_TreatedAsFailure()
    {
        using var dir = new TempInstallDir();
        using var roots = new IsolatedRoots();
        var paths = InstallPaths.FromInstallDir(dir.Path);
        var installerPath = WriteFakeInstaller(roots.UpdateRoot, exitCode: 0);

        var process = new FakeProcessManager();
        var health = new FakeHealthChecker { RespondOnceResult = false };
        var applier = new UpdateApplier(process, health, paths, new FakeLauncherLogger());

        var exitCode = await applier.ApplyAsync(installerPath, "1.2.3");

        Assert.Equal(0, exitCode); // kod wyjscia instalatora zostaje 0...
        var result = ReadLastResult(roots.UpdateRoot);
        Assert.False(result.GetProperty("ok").GetBoolean()); // ...ale ok jest false, bo panel nie odpowiedzial
    }

    [Fact]
    public async Task ProcessSurvivesFirstStopAttempt_RetriesUntilConfirmedGone_RealBugCaughtLiveOnProduction()
    {
        // Audyt v1.1.7: zlapane realnie na produkcji - stary proces server.js
        // przetrwal pojedyncze StopOwnedProcesses (byl akurat w trakcie
        // obslugi TEGO WLASNIE requestu /api/update/install), instalator i
        // tak ruszyl dalej, a stary proces zostal sierota ze STARYM kodem
        // (m.in. bez poprawki drukowania) obok swiezo zainstalowanej wersji.
        // Fake symuluje: pierwsza proba znajduje 1 "uparty" proces node.exe,
        // druga juz nic (naprawde umarl) - StopAllOwnedProcessesUntilConfirmedAsync
        // musi ZAPYTAC PONOWNIE zamiast zaufac pierwszemu (nieprawdziwemu)
        // "zero pozostalych".
        using var dir = new TempInstallDir();
        using var roots = new IsolatedRoots();
        var paths = InstallPaths.FromInstallDir(dir.Path);
        var installerPath = WriteFakeInstaller(roots.UpdateRoot, exitCode: 0);

        var process = new FakeProcessManager
        {
            StopResultSequence = new Queue<IReadOnlyList<int>>(new IReadOnlyList<int>[] { new[] { 4242 }, Array.Empty<int>() })
        };
        var health = new FakeHealthChecker { RespondOnceResult = true, AlreadyRunningResult = true, RunningVersionResult = "1.2.3" };
        var applier = new UpdateApplier(process, health, paths, new FakeLauncherLogger(),
            stopConfirmTimeout: TimeSpan.FromSeconds(5), stopConfirmPollInterval: TimeSpan.FromMilliseconds(10));

        var exitCode = await applier.ApplyAsync(installerPath, "1.2.3");

        Assert.Equal(0, exitCode);
        // Dokladnie 2 proby: pierwsza znalazla "uparty" proces, druga
        // potwierdzila zero pozostalych - petla NIE moze zatrzymac sie po
        // pierwszej (falszywie "udanej", bo cos jednak zostalo znalezione i
        // dopiero co zabite) probie.
        Assert.Equal(2, process.StopOwnedProcessesCallCount);

        var result = ReadLastResult(roots.UpdateRoot);
        Assert.True(result.GetProperty("ok").GetBoolean());
    }

    [Fact]
    public async Task ProcessNeverConfirmedGone_ContinuesAnywayAfterTimeout_NeverHangsForever()
    {
        using var dir = new TempInstallDir();
        using var roots = new IsolatedRoots();
        var paths = InstallPaths.FromInstallDir(dir.Path);
        var installerPath = WriteFakeInstaller(roots.UpdateRoot, exitCode: 0);

        // Proces "wiecznie uparty" - kazda proba wciaz go znajduje.
        var process = new FakeProcessManager { StopResultToReturn = new[] { 4242 } };
        var health = new FakeHealthChecker { RespondOnceResult = true, AlreadyRunningResult = true, RunningVersionResult = "1.2.3" };
        var applier = new UpdateApplier(process, health, paths, new FakeLauncherLogger(),
            stopConfirmTimeout: TimeSpan.FromMilliseconds(50), stopConfirmPollInterval: TimeSpan.FromMilliseconds(10));

        var exitCode = await applier.ApplyAsync(installerPath, "1.2.3");

        // Limit czasu potwierdzenia minal, ale aktualizacja i tak KONTYNUUJE
        // (nie wisi w nieskonczonosc) - lepiej sprobowac zainstalowac, niz
        // nigdy nie skonczyc.
        Assert.Equal(0, exitCode);
        Assert.Equal(1, process.StartServerCallCount);
    }

    [Fact]
    public async Task InstallerSucceeds_HealthRespondsButNoVersion_TreatedAsFailure()
    {
        using var dir = new TempInstallDir();
        using var roots = new IsolatedRoots();
        var paths = InstallPaths.FromInstallDir(dir.Path);
        var installerPath = WriteFakeInstaller(roots.UpdateRoot, exitCode: 0);

        var process = new FakeProcessManager();
        var health = new FakeHealthChecker { RespondOnceResult = true, AlreadyRunningResult = true, RunningVersionResult = null };
        var applier = new UpdateApplier(process, health, paths, new FakeLauncherLogger());

        var exitCode = await applier.ApplyAsync(installerPath, "1.2.3");

        Assert.Equal(0, exitCode);
        var result = ReadLastResult(roots.UpdateRoot);
        Assert.False(result.GetProperty("ok").GetBoolean());
    }

    // Audyt 2026-08-12 (zlapane live na produkcji): StopOwnedProcesses dopasowuje
    // procesy WYLACZNIE po nazwie+sciezce i przy realnej aktualizacji jednorazowo
    // pominal glowny proces-nadzorce server.js mimo identycznej sciezki jak jego
    // dzieci - instalator probowal nadpisac pliki pod dzialajacym procesem. parentPid
    // to gwarantowana, jawnie znana siatka bezpieczenstwa niezalezna od tego skanu -
    // patrz EnsureParentProcessStopped w UpdateApplier.cs.
    [Fact]
    public async Task ParentPidStillAlive_AfterStopOwnedProcesses_IsKilledExplicitlyByPid()
    {
        using var dir = new TempInstallDir();
        using var roots = new IsolatedRoots();
        var paths = InstallPaths.FromInstallDir(dir.Path);
        var installerPath = WriteFakeInstaller(roots.UpdateRoot, exitCode: 0);

        var process = new FakeProcessManager { ProcessAliveResult = true, KillProcessByIdResult = true };
        var health = new FakeHealthChecker { RespondOnceResult = true, AlreadyRunningResult = true, RunningVersionResult = "1.2.3" };
        var applier = new UpdateApplier(process, health, paths, new FakeLauncherLogger());

        var exitCode = await applier.ApplyAsync(installerPath, "1.2.3", parentPid: "4242");

        Assert.Equal(0, exitCode);
        Assert.Equal(1, process.KillProcessByIdCallCount);
        Assert.Contains(4242, process.KilledPids);
    }

    [Fact]
    public async Task ParentPidAlreadyDead_AfterStopOwnedProcesses_KillProcessByIdIsNotCalled()
    {
        using var dir = new TempInstallDir();
        using var roots = new IsolatedRoots();
        var paths = InstallPaths.FromInstallDir(dir.Path);
        var installerPath = WriteFakeInstaller(roots.UpdateRoot, exitCode: 0);

        var process = new FakeProcessManager { ProcessAliveResult = false };
        var health = new FakeHealthChecker { RespondOnceResult = true, AlreadyRunningResult = true, RunningVersionResult = "1.2.3" };
        var applier = new UpdateApplier(process, health, paths, new FakeLauncherLogger());

        var exitCode = await applier.ApplyAsync(installerPath, "1.2.3", parentPid: "4242");

        Assert.Equal(0, exitCode);
        Assert.Equal(0, process.KillProcessByIdCallCount);
    }

    [Fact]
    public async Task NoParentPidProvided_BackwardCompatible_KillProcessByIdIsNotCalled()
    {
        using var dir = new TempInstallDir();
        using var roots = new IsolatedRoots();
        var paths = InstallPaths.FromInstallDir(dir.Path);
        var installerPath = WriteFakeInstaller(roots.UpdateRoot, exitCode: 0);

        var process = new FakeProcessManager { ProcessAliveResult = true };
        var health = new FakeHealthChecker { RespondOnceResult = true, AlreadyRunningResult = true, RunningVersionResult = "1.2.3" };
        var applier = new UpdateApplier(process, health, paths, new FakeLauncherLogger());

        var exitCode = await applier.ApplyAsync(installerPath, "1.2.3");

        Assert.Equal(0, exitCode);
        Assert.Equal(0, process.KillProcessByIdCallCount);
    }

    // Audyt 2026-08-17 (zlapane live na produkcji, dwie proby aktualizacji 1.1.10->1.1.15
    // pod rzad, obie exitCode 5 - "Scyzoryk.exe wciaz w uzyciu"): StopResidentTrayProcesses
    // (ten sam skan po nazwie+sciezce co StopOwnedProcesses) zglosil ZERO trafien mimo
    // ze rezydentna ikona realnie zyla i naprawde blokowala plik (potwierdzone niezaleznie
    // przez RestartManager w logu Inno Setup). residentTrayPid to ta sama, gwarantowana
    // siatka bezpieczenstwa co parentPid powyzej - w odroznieniu od parentPid (ufany
    // bezwarunkowo), tu PID pochodzi z pliku (patrz InstallPaths.ResidentTrayPidFilePath)
    // i jest weryfikowany po nazwie+sciezce (KillProcessByIdIfPathMatches), nie samym
    // KillProcessById - dlatego test sprawdza WYWOLANIE weryfikowanej wersji.
    [Fact]
    public async Task ResidentTrayPidStillAlive_AfterNameScanFindsNothing_IsKilledExplicitlyByVerifiedPid()
    {
        using var dir = new TempInstallDir();
        using var roots = new IsolatedRoots();
        var paths = InstallPaths.FromInstallDir(dir.Path);
        var installerPath = WriteFakeInstaller(roots.UpdateRoot, exitCode: 0);

        // Dokladnie odtworzona rzeczywista awaria: skan po nazwie zwraca PUSTA liste
        // (jak dwukrotnie na produkcji), ale IsProcessStillAlive potwierdza, ze PID z
        // pliku wciaz zyje.
        var process = new FakeProcessManager
        {
            StopResidentTrayResultToReturn = Array.Empty<int>(),
            ProcessAliveResult = true,
            KillProcessByIdIfPathMatchesResult = true
        };
        var health = new FakeHealthChecker { RespondOnceResult = true, AlreadyRunningResult = true, RunningVersionResult = "1.2.3" };
        var applier = new UpdateApplier(process, health, paths, new FakeLauncherLogger());

        var exitCode = await applier.ApplyAsync(installerPath, "1.2.3", residentTrayPid: "16204");

        Assert.Equal(0, exitCode);
        Assert.Equal(1, process.KillProcessByIdIfPathMatchesCallCount);
        Assert.Equal(0, process.KillProcessByIdCallCount); // to NIE jest bezwarunkowe zabicie
        var call = Assert.Single(process.KillIfPathMatchesCalls);
        Assert.Equal(16204, call.Pid);
        Assert.Equal(paths.ScyzorykExePath, call.ExpectedFullPath);
    }

    [Fact]
    public async Task ResidentTrayPidAlreadyDead_KillProcessByIdIfPathMatchesIsNotCalled()
    {
        using var dir = new TempInstallDir();
        using var roots = new IsolatedRoots();
        var paths = InstallPaths.FromInstallDir(dir.Path);
        var installerPath = WriteFakeInstaller(roots.UpdateRoot, exitCode: 0);

        var process = new FakeProcessManager { ProcessAliveResult = false };
        var health = new FakeHealthChecker { RespondOnceResult = true, AlreadyRunningResult = true, RunningVersionResult = "1.2.3" };
        var applier = new UpdateApplier(process, health, paths, new FakeLauncherLogger());

        var exitCode = await applier.ApplyAsync(installerPath, "1.2.3", residentTrayPid: "16204");

        Assert.Equal(0, exitCode);
        Assert.Equal(0, process.KillProcessByIdIfPathMatchesCallCount);
    }

    [Fact]
    public async Task NoResidentTrayPidProvided_BackwardCompatible_KillProcessByIdIfPathMatchesIsNotCalled()
    {
        using var dir = new TempInstallDir();
        using var roots = new IsolatedRoots();
        var paths = InstallPaths.FromInstallDir(dir.Path);
        var installerPath = WriteFakeInstaller(roots.UpdateRoot, exitCode: 0);

        var process = new FakeProcessManager { ProcessAliveResult = true };
        var health = new FakeHealthChecker { RespondOnceResult = true, AlreadyRunningResult = true, RunningVersionResult = "1.2.3" };
        var applier = new UpdateApplier(process, health, paths, new FakeLauncherLogger());

        var exitCode = await applier.ApplyAsync(installerPath, "1.2.3");

        Assert.Equal(0, exitCode);
        Assert.Equal(0, process.KillProcessByIdIfPathMatchesCallCount);
    }

    // Audyt 2026-08-17: OBIE proby instalatora padly identycznie na produkcji (exitCode 5
    // dwa razy pod rzad), bo zabezpieczenie istnialo tylko przed PIERWSZA proba. Test
    // pilnuje, ze retry (RunInstallerWithRetryAsync) tez wola EnsureResidentTrayStopped,
    // nie tylko poczatkowy StopAllOwnedProcessesUntilConfirmedAsync.
    [Fact]
    public async Task ResidentTrayPidStillAlive_OnRetryAfterFirstAttemptFails_IsKilledAgainOnRetry()
    {
        using var dir = new TempInstallDir();
        using var roots = new IsolatedRoots();
        var paths = InstallPaths.FromInstallDir(dir.Path);
        // Kazde apps\* w stagingu potrzebuje niepustego node_modules, zeby
        // DescribeIntegrityIssue nie zglosilo problemu integralnosci niezaleznie
        // od exitCode - tu celowo uzywamy TempInstallDir bez apps\*, wiec
        // integrityIssue bedzie null, a jedynym powodem retry jest exitCode != 0.
        var installerPath = WriteFakeInstaller(roots.UpdateRoot, exitCode: 5);

        var process = new FakeProcessManager
        {
            StopResidentTrayResultToReturn = Array.Empty<int>(),
            ProcessAliveResult = true,
            KillProcessByIdIfPathMatchesResult = true
        };
        var health = new FakeHealthChecker { RespondOnceResult = true, AlreadyRunningResult = true, RunningVersionResult = "1.2.3" };
        var applier = new UpdateApplier(process, health, paths, new FakeLauncherLogger(),
            installRetryDelay: TimeSpan.FromMilliseconds(1));

        await applier.ApplyAsync(installerPath, "1.2.3", residentTrayPid: "16204");

        // Raz przed pierwsza proba, raz przed druga (retry) - dokladnie to, czego
        // zabraklo na produkcji.
        Assert.Equal(2, process.KillProcessByIdIfPathMatchesCallCount);
    }

    // =====================================================================
    // Audyt 2026-08-27: falszywy "aktualizacja sie nie udała" przy recznym
    // zimnym starcie z oknem postepu - proces czekajacy w LauncherApp.cs
    // trzymal otwarty installDir\Scyzoryk.exe, przez co instalator Inno Setup
    // dostawal kod 5 (DeleteFile: plik w uzyciu) i rollbackowal. Rename pliku
    // .old-* przed instalatorem rozwiazuje problem niezaleznie od tego, kto
    // trzyma uchwyt. Testy ponizej pokrywaja rename + sprzatanie/przywracanie.
    // =====================================================================

    private static void CreateDummyScyzorykExe(string installDir)
    {
        // Nie potrzebujemy prawdziwego PE - wystarczy plik o tej nazwie,
        // zeby SwapOutRunningExe mialo cos przeniesc.
        File.WriteAllText(Path.Combine(installDir, "Scyzoryk.exe"), "dummy");
    }

    [Fact]
    public async Task ScyzorykExeExistsAndInUse_RenamedBeforeInstaller_SucceedsAndCleansUpOldCopy()
    {
        using var dir = new TempInstallDir();
        CreateDummyScyzorykExe(dir.Path);
        using var roots = new IsolatedRoots();
        var paths = InstallPaths.FromInstallDir(dir.Path);
        var installerPath = WriteFakeInstaller(roots.UpdateRoot, exitCode: 0);

        // Symulacja "plik w uzyciu" z jednoczesnym pozwoleniem na rename
        // (FileShare.Delete) - na Windows uruchomiony .exe da sie zazwyczaj
        // zmienic nazwe, mimo ze DeleteFile/nadpisanie pada.
        using var locked = new FileStream(paths.ScyzorykExePath, FileMode.Open, FileAccess.Read, FileShare.Read | FileShare.Delete);

        var process = new FakeProcessManager();
        var health = new FakeHealthChecker { RespondOnceResult = true, AlreadyRunningResult = true, RunningVersionResult = "1.2.3" };
        var applier = new UpdateApplier(process, health, paths, new FakeLauncherLogger());

        var exitCode = await applier.ApplyAsync(installerPath, "1.2.3");

        Assert.Equal(0, exitCode);
        var result = ReadLastResult(roots.UpdateRoot);
        Assert.True(result.GetProperty("ok").GetBoolean());
        // Po sukcesie kopia .old-* powinna zostac posprzatana.
        Assert.False(Directory.GetFiles(dir.Path, "Scyzoryk.exe.old-*").Any());
    }

    [Fact]
    public async Task ScyzorykExeRenamed_InstallerFailsAndDoesNotRecreate_RestoresOriginalExe()
    {
        using var dir = new TempInstallDir();
        CreateDummyScyzorykExe(dir.Path);
        using var roots = new IsolatedRoots();
        var paths = InstallPaths.FromInstallDir(dir.Path);
        var installerPath = WriteFakeInstaller(roots.UpdateRoot, exitCode: 5);

        var process = new FakeProcessManager();
        var health = new FakeHealthChecker { RespondOnceResult = true, AlreadyRunningResult = true, RunningVersionResult = "1.0.0" };
        var applier = new UpdateApplier(process, health, paths, new FakeLauncherLogger(),
            installRetryDelay: TimeSpan.FromMilliseconds(1));

        var exitCode = await applier.ApplyAsync(installerPath, "1.2.3");

        Assert.Equal(5, exitCode);
        var result = ReadLastResult(roots.UpdateRoot);
        Assert.False(result.GetProperty("ok").GetBoolean());

        // Instalator (fake) nie odtworzyl Scyzoryk.exe - oryginalny plik
        // musi byc przywrocony, zeby uzytkownik nie zostal bez launchera.
        Assert.True(File.Exists(paths.ScyzorykExePath));
        Assert.False(Directory.GetFiles(dir.Path, "Scyzoryk.exe.old-*").Any());
    }
}
