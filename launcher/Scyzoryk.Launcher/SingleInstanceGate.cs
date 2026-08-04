using System.Threading;

namespace Scyzoryk.Launcher;

public interface ISingleInstanceGate : IDisposable
{
    /// <summary>Probuje przejac odpowiedzialnosc za "start serwera" na okreslony czas.
    /// Zwraca false, jesli inny launcher juz trzyma ten muteks po uplywie timeoutu -
    /// wtedy WYWOLUJACY nie powinien odpalac wlasnego node.exe, tylko poczekac na
    /// health.</summary>
    bool TryAcquire(TimeSpan timeout);

    void Release();
}

/// <summary>
/// Nazwany muteks Windows (Local\...) budowany z hasha znormalizowanej sciezki
/// instalacji (patrz InstallPaths.MutexName), zeby dwie rozne instalacje na tym
/// samym komputerze nigdy nie kolidowaly o jeden globalny obiekt. Chroni WYLACZNIE
/// krok "odpal node.exe" - nie jest trzymany przez cala reszte dzialania launchera.
/// </summary>
public sealed class SingleInstanceGate : ISingleInstanceGate
{
    private readonly Mutex _mutex;
    private bool _acquired;

    public SingleInstanceGate(string mutexName)
    {
        _mutex = new Mutex(initiallyOwned: false, name: mutexName);
    }

    public bool TryAcquire(TimeSpan timeout)
    {
        try
        {
            _acquired = _mutex.WaitOne(timeout);
        }
        catch (AbandonedMutexException)
        {
            // Poprzedni proces launchera zakonczyl sie (np. padl) w trakcie trzymania
            // muteksu - to NIE jest powod do odmowy startu, po prostu przejmujemy go.
            _acquired = true;
        }

        return _acquired;
    }

    public void Release()
    {
        if (!_acquired) return;
        try
        {
            _mutex.ReleaseMutex();
        }
        catch (ApplicationException)
        {
            // Muteks nie byl (juz) nasz wlasnosciowo - nic do zrobienia.
        }
        finally
        {
            _acquired = false;
        }
    }

    public void Dispose()
    {
        Release();
        _mutex.Dispose();
    }
}
