namespace Scyzoryk.Launcher;

/// <summary>
/// Wszystkie budzety czasowe uzyte przez LauncherApp, wydzielone z klasy - testy
/// jednostkowe podstawiaja tu wartosci milisekundowe, zeby caly test scenariusza
/// "timeout startu" nie trwal naprawde ~4.5 minuty.
/// </summary>
public sealed record LauncherTimings(
    int ProbeAttempts,
    TimeSpan ProbeAttemptTimeout,
    TimeSpan ProbeDelayBetween,
    TimeSpan OwnerAcquireTimeout,
    TimeSpan BaseStartupTimeout,
    TimeSpan ExtendedStartupTimeout,
    TimeSpan WaiterTopUpTimeout,
    TimeSpan HealthCommandTimeout)
{
    /// <summary>
    /// Wartosci produkcyjne - odzwierciedlaja dzisiejsze is-panel-alive.ps1 (6x2s/500ms)
    /// i wait-and-open-panel.ps1 (baza 30s + rozszerzenie do 240s = ~270s razem).
    /// OwnerAcquireTimeout jest ustawiony nieco powyzej tego calkowitego budzetu, zeby
    /// druga (rownolegla) instancja launchera normalnie doczekala sie zwolnienia
    /// muteksu przez pierwsza, zamiast wpadac we wlasna, odrebna sciezke bledu.
    /// </summary>
    public static LauncherTimings Production { get; } = new(
        ProbeAttempts: 6,
        ProbeAttemptTimeout: TimeSpan.FromSeconds(2),
        ProbeDelayBetween: TimeSpan.FromMilliseconds(500),
        OwnerAcquireTimeout: TimeSpan.FromSeconds(275),
        BaseStartupTimeout: TimeSpan.FromSeconds(90),
        ExtendedStartupTimeout: TimeSpan.FromSeconds(180),
        WaiterTopUpTimeout: TimeSpan.FromSeconds(15),
        HealthCommandTimeout: TimeSpan.FromSeconds(3));
}
