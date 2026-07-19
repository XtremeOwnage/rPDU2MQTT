using System.Net;
using FluentModbus;
using Microsoft.Extensions.Hosting;
using rPDU2MQTT.Classes;
using rPDU2MQTT.Core.Flow;
using rPDU2MQTT.Models.Config;

namespace rPDU2MQTT.Services;

/// <summary>
/// Feeds energy-flow nodes from Modbus TCP devices (#129) — inverters, meters, PLCs — by polling the
/// registers bound in <c>EnergyFlow.Nodes[].Sources</c> with Type 'modbus' and keeping the latest value per
/// (node, metric). Shares the <see cref="IFlowValueSource"/> seam with the MQTT ingest (via
/// <see cref="CompositeFlowValueSource"/>), so a Modbus-sourced node rolls up, exports and appears in Home
/// Assistant exactly like an MQTT- or PDU-sourced one.
///
/// Each connection is polled on its own interval; connections + bindings are re-read every tick, so editing
/// them in the GUI takes effect without a restart. A device is opened per poll (connect → read → close),
/// which is simplest and robust for the seconds-scale cadence energy monitoring needs.
/// </summary>
public sealed class EnergyFlowModbusSourceService : BackgroundService, IFlowValueSource
{
    private readonly Config cfg;
    private readonly FlowValueCache latest = new();
    private readonly Dictionary<string, DateTime> lastPolled = new(StringComparer.Ordinal);

    public EnergyFlowModbusSourceService(Config cfg) => this.cfg = cfg;

    public bool TryGetValue(string nodeId, string metric, out double value)
        => latest.TryGetValue(nodeId, metric, out value);

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        try
        {
            // A 1s base tick; each connection fires on its own PollIntervalSeconds.
            using var timer = new PeriodicTimer(TimeSpan.FromSeconds(1));
            do
            {
                try { Reconcile(DateTime.UtcNow); }
                catch (OperationCanceledException) { return; }
                catch (Exception ex) { Log.Warning($"Energy-flow Modbus: {ex.Message}"); }
            }
            while (await timer.WaitForNextTickAsync(stoppingToken));
        }
        catch (OperationCanceledException) { /* shutting down */ }
    }

    /// <summary>Poll each due connection, and drop cached readings whose binding has gone away.</summary>
    private void Reconcile(DateTime nowUtc)
    {
        var bindings = BuildBindings(cfg.EnergyFlow.Nodes);

        // Prune readings no longer produced by any current modbus binding (a removed/retyped source).
        var live = bindings.Values.SelectMany(v => v).Select(b => (b.NodeId, b.Source.Metric)).ToHashSet();
        foreach (var key in latest.Keys.Where(k => !live.Contains((k.Node, k.Metric))).ToList())
            latest.Remove(key.Node, key.Metric);

        foreach (var conn in cfg.Modbus.Connections)
        {
            if (!conn.Enabled || string.IsNullOrWhiteSpace(conn.Id) || string.IsNullOrWhiteSpace(conn.Host)) continue;
            if (!bindings.TryGetValue(conn.Id, out var forConn) || forConn.Count == 0) continue;

            var interval = TimeSpan.FromSeconds(Math.Max(1, conn.PollIntervalSeconds));
            if (lastPolled.TryGetValue(conn.Id, out var last) && nowUtc - last < interval) continue;
            lastPolled[conn.Id] = nowUtc;

            try { Poll(conn, forConn, nowUtc); }
            catch (Exception ex) { Log.Warning($"Energy-flow Modbus: {conn.Name ?? conn.Id} ({conn.Host}:{conn.Port}) — {ex.Message}"); }
        }
    }

    private void Poll(ModbusConnection conn, List<(string NodeId, EnergyFlowSource Source)> forConn, DateTime nowUtc)
    {
        var nodeOf = new Dictionary<EnergyFlowSource, string>(ReferenceEqualityComparer.Instance);
        foreach (var (nodeId, src) in forConn) nodeOf[src] = nodeId;

        ReadBatch(conn.Host, conn.Port, conn.UnitId, conn.Framing, forConn.Select(f => f.Source).ToList(),
            onValue: (src, value) => latest.Set(nodeOf[src], src.Metric, value, src.StaleAfterSeconds, nowUtc),
            onError: (src, msg) => Log.Debug($"Energy-flow Modbus: node '{nodeOf[src]}' register {src.Register} on {conn.Id} — {msg}"));
    }

    /// <summary>True for the RTU-over-TCP framing most RS485-to-Ethernet gateways / serial dongles use.</summary>
    private static bool IsRtuOverTcp(string? framing)
        => framing is not null && (framing.Equals("rtu-over-tcp", StringComparison.OrdinalIgnoreCase) || framing.Equals("rtu", StringComparison.OrdinalIgnoreCase));

    /// <summary>Read + decode one source's register(s), then normalise the unit and apply Scale (same pipeline as MQTT).</summary>
    private static double ReadValue(ModbusClient client, int unitId, EnergyFlowSource src)
    {
        var count = ModbusDecode.RegisterCount(src.DataType);
        var regs = string.Equals(src.RegisterType, "input", StringComparison.OrdinalIgnoreCase)
            ? client.ReadInputRegisters<ushort>(unitId, src.Register, count).ToArray()
            : client.ReadHoldingRegisters<ushort>(unitId, src.Register, count).ToArray();
        return ModbusDecode.Decode(regs, src.DataType, src.WordOrder) * FlowUnits.ToCanonicalFactor(src.Metric, src.Unit) * src.Scale;
    }

    /// <summary>
    /// Read a batch of sources on one connection, reconnecting on a read error before the next register. A
    /// failed read (an exception response, or cross-talk on a serial gateway shared by another master) can
    /// leave the TCP stream misaligned, so the following reads come back as *another* register's data — a
    /// silent-corruption risk. Reconnecting after any error closes that window and retries the register once.
    /// Throws only if the initial connect fails (so callers can report "unreachable").
    /// </summary>
    private static void ReadBatch(string host, int port, int unitId, string? framing, IReadOnlyList<EnergyFlowSource> items,
        Action<EnergyFlowSource, double> onValue, Action<EnergyFlowSource, string>? onError = null)
    {
        var endpoint = new IPEndPoint(ResolveHost(host), port);
        var rtu = IsRtuOverTcp(framing);
        ModbusClient? client = null;
        void Reconnect()
        {
            (client as IDisposable)?.Dispose();
            if (rtu)
            {
                var c = new ModbusRtuOverTcpClient { ReadTimeout = 3000, WriteTimeout = 3000 };
                c.Connect(endpoint, ModbusEndianness.BigEndian);
                client = c;
            }
            else
            {
                var c = new ModbusTcpClient { ReadTimeout = 3000, WriteTimeout = 3000 };
                c.Connect(endpoint, ModbusEndianness.BigEndian);
                client = c;
            }
        }

        try
        {
            Reconnect();   // an initial-connect failure propagates to the caller
            foreach (var src in items)
            {
                for (var attempt = 0; ; attempt++)
                {
                    try { onValue(src, ReadValue(client!, unitId, src)); break; }
                    catch (Exception ex)
                    {
                        if (attempt >= 1) { onError?.Invoke(src, ex.Message); break; }
                        try { Reconnect(); } catch { onError?.Invoke(src, ex.Message); break; }  // reconnect + retry once
                    }
                }
            }
        }
        finally { (client as IDisposable)?.Dispose(); }
    }

    /// <summary>One probed register value (or the error hit reading it), in the request's item order.</summary>
    public sealed record ModbusReading(int Register, string Metric, double? Value, string? Error);

    /// <summary>
    /// Connect to a device once and (optionally) read a set of register specs — powers the GUI's "Test
    /// connection" button and the live per-binding value display, so a mapping can be verified before it's
    /// wired into the flow. Read-only; opens and closes a throwaway connection.
    /// </summary>
    public static (bool Ok, string Message, List<ModbusReading> Readings) Probe(string host, int port, int unitId, string? framing, IReadOnlyList<EnergyFlowSource>? items)
    {
        var readings = new List<ModbusReading>();
        try
        {
            ReadBatch(host, port, unitId, framing, items ?? Array.Empty<EnergyFlowSource>(),
                onValue: (src, value) => readings.Add(new ModbusReading(src.Register, src.Metric, value, null)),
                onError: (src, msg) => readings.Add(new ModbusReading(src.Register, src.Metric, null, msg)));
        }
        catch (Exception ex) { return (false, $"Could not connect to {host}:{port} — {ex.Message}", readings); }

        var okCount = readings.Count(r => r.Error is null);
        var suffix = readings.Count > 0 ? $" Read {okCount}/{readings.Count} register(s)." : "";
        return (true, $"Connected to {host}:{port}.{suffix}", readings);
    }

    private static IPAddress ResolveHost(string host)
        => IPAddress.TryParse(host, out var ip)
            ? ip
            : Dns.GetHostAddresses(host).FirstOrDefault(a => a.AddressFamily == System.Net.Sockets.AddressFamily.InterNetwork)
              ?? Dns.GetHostAddresses(host).First();

    /// <summary>Group the nodes' Modbus-type bindings by connection id for the poller. Testable without a device.</summary>
    internal static Dictionary<string, List<(string NodeId, EnergyFlowSource Source)>> BuildBindings(IEnumerable<EnergyFlowNode> nodes)
    {
        var byConn = new Dictionary<string, List<(string, EnergyFlowSource)>>(StringComparer.Ordinal);
        foreach (var node in nodes)
        {
            if (string.IsNullOrWhiteSpace(node.Id)) continue;
            foreach (var src in node.AllSources())
            {
                if (!string.Equals(src.Type, "modbus", StringComparison.OrdinalIgnoreCase)) continue;
                if (string.IsNullOrWhiteSpace(src.Connection) || string.IsNullOrWhiteSpace(src.Metric)) continue;
                var conn = src.Connection.Trim();
                if (!byConn.TryGetValue(conn, out var list)) byConn[conn] = list = new();
                list.Add((node.Id.Trim(), src));
            }
        }
        return byConn;
    }
}
