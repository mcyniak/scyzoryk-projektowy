using System.Net.Http;
using System.Threading;

namespace Scyzoryk.Launcher;

public enum HealthWaitOutcome
{
    Healthy,
    TimedOutProcessDead,
    TimedOutProcessAlive,
}

public interface IHealthChecker
{
    /// <summary>Jedno zapytanie GET /api/health. Uzywane przez tryb --health - ma byc
    /// szybkie i szczere co do stanu "teraz", nie maskowac wciaz-startujacego serwera
    /// jako zdrowego.</summary>
    Task<bool> IsRespondingOnceAsync(string healthUrl, TimeSpan timeout, CancellationToken ct = default);

    /// <summary>Kilka krotkich prob z przerwa - odpowiednik is-panel-alive.ps1 (domyslnie
    /// ~6x2s/500ms), do sprawdzenia "czy panel juz zyje" przed decyzja o starcie.</summary>
    Task<bool> ProbeAlreadyRunningAsync(string healthUrl, int attempts, TimeSpan attemptTimeout, TimeSpan delayBetween, CancellationToken ct = default);

    /// <summary>Czeka na zdrowy /api/health po wlasnie odpalonym serwerze - odpowiednik
    /// wait-and-open-panel.ps1 (baza + rozszerzenie, jesli spawnowany proces wciaz zyje).</summary>
    Task<HealthWaitOutcome> WaitForHealthyAsync(string healthUrl, TimeSpan baseTimeout, TimeSpan extendedTimeout, Func<bool> isSpawnedProcessAlive, CancellationToken ct = default);
}

/// <summary>
/// Odpytuje /api/health przez HttpClient (nigdy PowerShell/curl.exe). Kazdy blad
/// sieciowy (polaczenie odrzucone, serwer jeszcze nie sluchajacy) jest traktowany
/// jako "jeszcze nie zdrowy", nie jako wyjatek do propagacji dalej.
/// </summary>
public sealed class HealthChecker : IHealthChecker
{
    private static readonly HttpClient Http = new();
    private static readonly TimeSpan PollInterval = TimeSpan.FromMilliseconds(500);

    public async Task<bool> IsRespondingOnceAsync(string healthUrl, TimeSpan timeout, CancellationToken ct = default)
    {
        using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        cts.CancelAfter(timeout);
        try
        {
            using var response = await Http.GetAsync(healthUrl, cts.Token).ConfigureAwait(false);
            return response.IsSuccessStatusCode;
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
        {
            return false;
        }
        catch (HttpRequestException)
        {
            return false;
        }
    }

    public async Task<bool> ProbeAlreadyRunningAsync(string healthUrl, int attempts, TimeSpan attemptTimeout, TimeSpan delayBetween, CancellationToken ct = default)
    {
        for (var i = 0; i < attempts; i++)
        {
            ct.ThrowIfCancellationRequested();
            if (await IsRespondingOnceAsync(healthUrl, attemptTimeout, ct).ConfigureAwait(false)) return true;
            if (i < attempts - 1) await Task.Delay(delayBetween, ct).ConfigureAwait(false);
        }

        return false;
    }

    public async Task<HealthWaitOutcome> WaitForHealthyAsync(string healthUrl, TimeSpan baseTimeout, TimeSpan extendedTimeout, Func<bool> isSpawnedProcessAlive, CancellationToken ct = default)
    {
        var deadline = DateTime.UtcNow + baseTimeout;
        var extendedDeadline = deadline;
        var extended = false;

        while (true)
        {
            ct.ThrowIfCancellationRequested();

            if (await IsRespondingOnceAsync(healthUrl, TimeSpan.FromSeconds(3), ct).ConfigureAwait(false))
            {
                return HealthWaitOutcome.Healthy;
            }

            var now = DateTime.UtcNow;
            if (now >= deadline)
            {
                if (!extended)
                {
                    // Baza minela - rozszerzamy TYLKO jesli wlasnie spawnowany proces wciaz
                    // zyje (np. wciaz instaluje zaleznosci przy pierwszym starcie) -
                    // dokladnie logika wait-and-open-panel.ps1.
                    if (!isSpawnedProcessAlive()) return HealthWaitOutcome.TimedOutProcessDead;

                    extended = true;
                    extendedDeadline = deadline + extendedTimeout;
                }

                if (now >= extendedDeadline)
                {
                    return isSpawnedProcessAlive() ? HealthWaitOutcome.TimedOutProcessAlive : HealthWaitOutcome.TimedOutProcessDead;
                }
            }

            await Task.Delay(PollInterval, ct).ConfigureAwait(false);
        }
    }
}
