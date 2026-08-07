using System.Drawing;
using System.Threading;
using System.Windows.Forms;

namespace Scyzoryk.Launcher;

public interface ITrayIconHost
{
    /// <summary>
    /// Probuje zostac REZYDENTNYM wlascicielem ikony w zasobniku - tylko jeden
    /// proces naraz moze nia byc (patrz InstallPaths.TrayMutexName). Jesli sie uda,
    /// BLOKUJE wywolujacy watek wlasna petla komunikatow Windows az do wybrania
    /// "Zamknij Scyzoryka" z menu (onQuit jest wywolywane tuz przed powrotem).
    /// Jesli inny rezydentny proces juz ma ikone, wraca NATYCHMIAST bez blokowania.
    /// </summary>
    /// <returns>true jesli ten proces byl wlascicielem ikony (i wlasnie ja zamknieto);
    /// false jesli ikone ma juz inny rezydentny proces.</returns>
    bool TryRunResident(Action onOpenPanel, Action onQuit);
}

/// <summary>
/// Ikona w zasobniku systemowym ("ukryte ikony") - widoczny znak, ze Scyzoryk
/// dziala, z prostym menu do otwarcia panelu albo calkowitego zamkniecia.
/// Wlasny, DEDYKOWANY muteks (nie ten sam co arbitraz startu node.exe) - trzymany
/// przez cala rezydentna zywotnosc procesu, wiec musi byc osobny obiekt, inaczej
/// blokowalby tez pozniejsze proby wznowienia serwera po awarii (patrz komentarz
/// przy InstallPaths.TrayMutexName).
/// </summary>
public sealed class NotifyIconTrayHost : ITrayIconHost
{
    private readonly string _trayMutexName;
    private readonly ILauncherLogger _logger;

    public NotifyIconTrayHost(string trayMutexName, ILauncherLogger logger)
    {
        _trayMutexName = trayMutexName;
        _logger = logger;
    }

    public bool TryRunResident(Action onOpenPanel, Action onQuit)
    {
        using var mutex = new Mutex(initiallyOwned: false, name: _trayMutexName);
        bool acquired;
        try
        {
            // Natychmiastowa proba, bez czekania - jesli inny proces juz ma ikone,
            // ten proces po prostu konczy dzialanie normalnie (tak jak przed
            // wprowadzeniem ikony), nie ma powodu blokowac.
            acquired = mutex.WaitOne(TimeSpan.Zero);
        }
        catch (AbandonedMutexException)
        {
            // Poprzedni rezydentny proces padl trzymajac muteks - przejmujemy ikone.
            acquired = true;
        }

        if (!acquired) return false;

        try
        {
            RunTrayLoop(onOpenPanel, onQuit);
        }
        finally
        {
            try { mutex.ReleaseMutex(); } catch (ApplicationException) { }
        }

        return true;
    }

    private void RunTrayLoop(Action onOpenPanel, Action onQuit)
    {
        var (icon, ownsIcon) = ResolveIcon();
        try
        {
            using var notifyIcon = new NotifyIcon
            {
                Icon = icon,
                Text = "Scyzoryk Projektowy",
                Visible = true
            };
            using var menu = new ContextMenuStrip();
            menu.Items.Add("Otwórz panel", null, (_, _) => SafeInvoke(onOpenPanel, "otwarcie panelu z zasobnika"));
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add("Zamknij Scyzoryka", null, (_, _) =>
            {
                SafeInvoke(onQuit, "zamkniecie Scyzoryka z zasobnika");
                Application.ExitThread();
            });
            notifyIcon.ContextMenuStrip = menu;
            notifyIcon.DoubleClick += (_, _) => SafeInvoke(onOpenPanel, "otwarcie panelu (dwuklik ikony)");

            _logger.Log(LogLevel.Info, "Ikona w zasobniku aktywna.");
            try
            {
                Application.Run();
            }
            finally
            {
                // Ikona musi zniknac natychmiast, nie dopiero po najechaniu mysza -
                // Visible=false PRZED Dispose (samo Dispose bez tego czasem zostawia
                // "duszka" widocznego az do odswiezenia paska zadan przez Windows).
                notifyIcon.Visible = false;
                _logger.Log(LogLevel.Info, "Ikona w zasobniku zamknieta.");
            }
        }
        finally
        {
            // SystemIcons.Application (fallback ponizej) jest WSPOLDZIELONA, cachowana
            // instancja - Dispose() na niej moglby zepsuc inny kod, ktory jeszcze jej
            // uzywa. Tylko ikone faktycznie WYCIAGNIETA z pliku .exe (ownsIcon=true)
            // zwalniamy sami.
            if (ownsIcon) icon.Dispose();
        }
    }

    private void SafeInvoke(Action action, string what)
    {
        try
        {
            action();
        }
        catch (Exception ex)
        {
            _logger.Log(LogLevel.Error, $"Blad podczas obslugi akcji z zasobnika ({what}).", new Dictionary<string, string>
            {
                ["exception"] = ex.ToString(),
            });
        }
    }

    private static (Icon Icon, bool Owned) ResolveIcon()
    {
        try
        {
            var extracted = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
            if (extracted is not null) return (extracted, true);
        }
        catch
        {
            // Spadamy do systemowej ikony ponizej - brak ikony w zasobniku nie moze
            // wywalic calego rezydentnego trybu.
        }
        return (SystemIcons.Application, false);
    }
}
