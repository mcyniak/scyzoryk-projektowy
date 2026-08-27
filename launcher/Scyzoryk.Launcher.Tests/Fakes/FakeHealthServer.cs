using System.Net;
using System.Net.Sockets;
using System.Threading;

namespace Scyzoryk.Launcher.Tests.Fakes;

/// <summary>
/// Prawdziwy lokalny serwer HTTP (HttpListener) zamiast mockowania HttpClienta -
/// "http://localhost:PORT/" nie wymaga uprawnien administratora/rezerwacji netsh
/// (w przeciwienstwie do "http://+:PORT/"), wiec dziala w normalnej sesji.
/// </summary>
internal sealed class FakeHealthServer : IDisposable
{
    private readonly HttpListener _listener = new();
    private readonly CancellationTokenSource _cts = new();

    public int Port { get; }
    public int StatusCodeToReturn { get; set; } = 200;
    // Uzywamy literalnego 127.0.0.1 zamiast "localhost" - na niektorych
    // runnerach CI rozwiazywanie "localhost" do IPv4/IPv6 dual-stack bywa
    // zauwazalnie wolniejsze lub nieterministyczne, co powodowalo flaky
    // fail testow HealthChecker (zlapane na zywo przy release v1.3.3).
    public string HealthUrl => $"http://127.0.0.1:{Port}/api/health";

    public FakeHealthServer()
    {
        Port = GetFreePort();
        _listener.Prefixes.Add($"http://127.0.0.1:{Port}/");
        _listener.Start();
        _ = Task.Run(AcceptLoopAsync);
    }

    private async Task AcceptLoopAsync()
    {
        while (!_cts.IsCancellationRequested)
        {
            HttpListenerContext ctx;
            try
            {
                ctx = await _listener.GetContextAsync().ConfigureAwait(false);
            }
            catch
            {
                return;
            }

            try
            {
                ctx.Response.StatusCode = StatusCodeToReturn;
                ctx.Response.Close();
            }
            catch
            {
                // Klient mogl juz zamknac polaczenie (np. timeout testu) - nieistotne.
            }
        }
    }

    public static int GetFreePort()
    {
        using var socket = new Socket(AddressFamily.InterNetwork, SocketType.Stream, ProtocolType.Tcp);
        socket.Bind(new IPEndPoint(IPAddress.Loopback, 0));
        return ((IPEndPoint)socket.LocalEndPoint!).Port;
    }

    public void Dispose()
    {
        _cts.Cancel();
        try { _listener.Stop(); } catch { /* best effort */ }
        _listener.Close();
    }
}
