using System.Net.Sockets;
using rPDU2MQTT.Core.Integrations;

namespace rPDU2MQTT.Plugin.Tigo;

/// <summary>
/// Keeps one TCP session open to a TAP bus's gateway: reads what is on the bus into a <see cref="TigoBus"/>
/// and, in Poll mode, writes what the bus says to send. Reconnects on its own after a failure.
///
/// <para>
/// Run under the cluster's single-owner lease, keyed by the gateway's address: many RS485-to-Ethernet
/// gateways take one TCP client, and two pollers on one bus would collide. The lease is re-checked every
/// few minutes by ending the session and asking again.
/// </para>
/// </summary>
internal sealed class TigoConnectionRunner
{
    public TigoConnection Settings { get; }
    public TigoBus Bus { get; }
    public bool Connected { get; private set; }
    /// <summary>Another process owns this gateway, so this one is not reading it.</summary>
    public bool Standby { get; private set; }
    public string? LastError { get; private set; }

    private static readonly TimeSpan SessionLength = TimeSpan.FromMinutes(5);
    /// <summary>A bus with nothing on it this long is a dead session, not a quiet one: the TAP is polled several times a second.</summary>
    private static readonly TimeSpan Silence = TimeSpan.FromSeconds(60);

    private readonly CancellationTokenSource stop = new();
    private Task? loop;

    public TigoConnectionRunner(TigoConnection settings)
    {
        Settings = settings;
        Bus = new TigoBus(settings.Kind, settings.Gateway, settings.AmpsScale);
    }

    /// <summary>What a change of settings has to restart for.</summary>
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
                    try { await Session(c); backoff = TimeSpan.FromSeconds(2); LastError = null; }
                    catch (Exception ex) when (ex is not OperationCanceledException || !c.IsCancellationRequested)
                    {
                        LastError = ex is OperationCanceledException ? "No data from the gateway for a minute." : ex.Message;
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
            await client.ConnectAsync(Settings.Host, Settings.Port, connect.Token);
        }
        Connected = true;
        var stream = client.GetStream();
        var framer = new TapFramer();

        var writer = Settings.Kind == TigoMode.Poll ? Task.Run(() => Write(stream, session.Token)) : Task.CompletedTask;
        var buffer = new byte[4096];
        try
        {
            while (!session.IsCancellationRequested)
            {
                using var idle = CancellationTokenSource.CreateLinkedTokenSource(session.Token);
                idle.CancelAfter(Silence);
                int n;
                try { n = await stream.ReadAsync(buffer, idle.Token); }
                catch (OperationCanceledException) when (session.IsCancellationRequested) { return; }
                if (n == 0) throw new IOException("The gateway closed the connection.");
                var now = DateTime.UtcNow;
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
