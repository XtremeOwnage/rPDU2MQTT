using System.Net.Sockets;
using rPDU2MQTT.Core.Integrations;

namespace rPDU2MQTT.Plugin.Tigo;

/// <summary>One TCP session to a TAP gateway, held under the single-owner lease.</summary>
internal sealed class TigoConnectionRunner
{
    public TigoConnection Settings { get; }
    public TigoBus Bus { get; }
    public bool Connected { get; private set; }
    /// <summary>Another process owns this gateway.</summary>
    public bool Standby { get; private set; }
    public string? LastError { get; private set; }
    public long BytesReceived => Interlocked.Read(ref bytes);
    public double? SilentSeconds(DateTime nowUtc)
        => Connected && quietSince is { } q && nowUtc - q >= Silence ? Math.Round((nowUtc - q).TotalSeconds) : null;

    private static readonly TimeSpan SessionLength = TimeSpan.FromMinutes(5);
    private static readonly TimeSpan Silence = TimeSpan.FromSeconds(60);
    private long bytes;
    private DateTime? quietSince;

    private readonly CancellationTokenSource stop = new();
    private Task? loop;

    public TigoConnectionRunner(TigoConnection settings)
    {
        Settings = settings;
        Bus = new TigoBus(settings.Kind, settings.Gateway, settings.AmpsScale);
    }

    /// <summary>Settings that require a restart when changed.</summary>
    public static string Fingerprint(TigoConnection c)
        => $"{c.Host}|{c.Port}|{c.Mode}|{c.GatewayId}|{c.PollIntervalMs}|{c.AmpsScale}|{c.Enabled}";

    public void Start(ISingleOwnerLease lease) => loop ??= Task.Run(() => Run(lease, stop.Token));

    public async Task StopAsync()
    {
        stop.Cancel();
        if (loop is not null) { try { await loop; } catch { /* stopping */ } }
    }

    private async Task Run(ISingleOwnerLease lease, CancellationToken ct)
    {
        var backoff = TimeSpan.FromSeconds(2);
        while (!ct.IsCancellationRequested)
        {
            var failed = false;
            try
            {
                var owned = await lease.RunIfOwnerAsync($"tigo:{Settings.Host}:{Settings.Port}", async c =>
                {
                    Standby = false;
                    try { await Session(c); backoff = TimeSpan.FromSeconds(2); LastError = null; }
                    catch (Exception ex) when (ex is not OperationCanceledException || !c.IsCancellationRequested)
                    {
                        LastError = ex.Message;
                        failed = true;
                    }
                }, ct);
                Standby = !owned;
                if (!owned) failed = true;
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested) { return; }
            catch (Exception ex) { LastError = ex.Message; failed = true; }
            Connected = false;
            if (!failed) continue;
            quietSince = null;
            try { await Task.Delay(backoff, ct); } catch (OperationCanceledException) { return; }
            backoff = TimeSpan.FromSeconds(Math.Min(30, backoff.TotalSeconds * 2));
        }
    }

    private async Task Session(CancellationToken outer)
    {
        using var session = CancellationTokenSource.CreateLinkedTokenSource(outer);
        session.CancelAfter(SessionLength);
        using var client = new TcpClient { NoDelay = true };
        using (var connect = CancellationTokenSource.CreateLinkedTokenSource(session.Token))
        {
            connect.CancelAfter(TimeSpan.FromSeconds(5));
            try { await client.ConnectAsync(Settings.Host, Settings.Port, connect.Token); }
            catch (OperationCanceledException) when (!session.IsCancellationRequested)
            {
                throw new TimeoutException($"No answer from {Settings.Host}:{Settings.Port} in 5 s.");
            }
        }
        quietSince ??= DateTime.UtcNow;
        Connected = true;
        var stream = client.GetStream();
        var framer = new TapFramer();

        var writer = Settings.Kind == TigoMode.Poll ? Task.Run(() => Write(stream, session.Token)) : Task.CompletedTask;
        var buffer = new byte[4096];
        try
        {
            while (!session.IsCancellationRequested)
            {
                int n;
                try { n = await stream.ReadAsync(buffer, session.Token); }
                catch (OperationCanceledException) when (session.IsCancellationRequested) { return; }
                if (n == 0) throw new IOException("The gateway closed the connection.");
                var now = DateTime.UtcNow;
                Interlocked.Add(ref bytes, n);
                quietSince = now;
                foreach (var frame in framer.Push(buffer.AsSpan(0, n))) Bus.OnFrame(frame, now);
            }
        }
        finally
        {
            session.Cancel();
            try { await writer; } catch { /* the session is over either way */ }
        }
    }

    private async Task Write(NetworkStream stream, CancellationToken ct)
    {
        var every = TimeSpan.FromMilliseconds(Math.Max(200, Settings.PollIntervalMs));
        while (!ct.IsCancellationRequested)
        {
            if (Bus.NextTransmit(DateTime.UtcNow, every) is { } bytes) await stream.WriteAsync(bytes, ct);
            await Task.Delay(25, ct);
        }
    }
}
