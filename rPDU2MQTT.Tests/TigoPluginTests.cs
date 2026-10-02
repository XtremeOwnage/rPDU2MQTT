using System.Net;
using System.Net.Sockets;
using rPDU2MQTT.Classes;
using rPDU2MQTT.Core.Integrations;
using rPDU2MQTT.Models.Config;
using rPDU2MQTT.Plugin.Tigo;
using Xunit;

namespace rPDU2MQTT.Tests;

/// <summary>
/// The Tigo TAP plugin: the RS485 protocol between a controller and a TAP, the bus state in both modes, and
/// the plugin end to end against a pretend RS485-to-Ethernet gateway.
/// </summary>
public class TigoPluginTests
{
    private static readonly DateTime T0 = new(2026, 10, 1, 12, 0, 0, DateTimeKind.Utc);
    private const ushort Gw = 0x1209;

    // --- Frames -------------------------------------------------------------------------------------------

    [Fact]
    public void TheCrcMatchesOpenTapToX()
        // openTAPtoX's own regression vector.
        => Assert.Equal(0x1A06, TapFrames.Crc(Convert.FromHexString("00000014372492661235")));

    [Fact]
    public void AFrameSurvivesTheRoundTrip_WithEveryEscapedByteInIt()
    {
        byte[] payload = [0x7E, 0x24, 0x23, 0x25, 0xA4, 0xA3, 0xA5, 0x00, 0x08, 0x07];
        var wire = TapFrames.Encode(Gw, TapFrames.PollResponse, payload, fromTap: true);
        Assert.Equal([0x00, 0xFF, 0xFF, 0x7E, 0x07], wire[..5]);
        Assert.Equal([0x7E, 0x08], wire[^2..]);
        // No unescaped 0x7E between the markers.
        var inner = wire[5..^2];
        for (var i = 0; i < inner.Length; i++)
            if (inner[i] == 0x7E) { Assert.InRange(inner[i + 1], 0, 6); i++; }

        var frame = Assert.Single(new TapFramer().Push(wire));
        Assert.True(frame.FromTap);
        Assert.Equal(Gw, frame.GatewayId);
        Assert.Equal(TapFrames.PollResponse, frame.Type);
        Assert.Equal(payload, frame.Payload);
    }

    [Fact]
    public void TheFramer_JoinsSplitReads_DropsAHalfFrameAndRejectsABadCrc()
    {
        var a = TapFrames.Encode(Gw, TapFrames.Poll, TapPackets.PollPayload(0x1234));
        var b = TapFrames.Encode(Gw, TapFrames.PollResponse, [0xFF, 0xFF, 0x01, 0x00, 0x05], fromTap: true);
        var bad = TapFrames.Encode(Gw, TapFrames.Poll, TapPackets.PollPayload(1));
        bad[^4] ^= 0x01;   // flip a bit of the CRC

        var framer = new TapFramer();
        var stream = a[7..].Concat(a).Concat(bad).Concat(b).ToArray();   // joined mid-frame, then three frames
        var got = new List<TapFrame>();
        foreach (var chunk in stream.Chunk(3)) got.AddRange(framer.Push(chunk));

        Assert.Equal([TapFrames.Poll, TapFrames.PollResponse], got.Select(f => f.Type));
        Assert.True(framer.Rejected >= 1);
    }

    // --- Packets ------------------------------------------------------------------------------------------

    /// <summary>A 0x31 power report from raw counts.</summary>
    private static byte[] PowerData(int vin, int vout, int duty, int iin, int temp, int rssi = 180, int slot = 7) =>
    [
        (byte)(vin >> 4), (byte)(((vin & 0xF) << 4) | (vout >> 8)), (byte)vout, (byte)duty,
        (byte)(iin >> 4), (byte)(((iin & 0xF) << 4) | (temp >> 8)), (byte)temp,
        0, 0, 0, (byte)(slot >> 8), (byte)slot, (byte)rssi,
    ];

    [Fact]
    public void APowerReportDecodes_InputPowerFromInputVoltsAndAmps()
    {
        // 38.2 V in, 40.1 V out, 8.12 A in (1450 counts × 0.0056), 41.7 °C.
        var r = TapPackets.Power(PowerData(764, 401, 128, 1450, 417))!;
        Assert.Equal(38.2, r.VoltsIn, 3);
        Assert.Equal(40.1, r.VoltsOut, 3);
        Assert.Equal(8.12, r.AmpsIn, 3);
        Assert.Equal(41.7, r.TemperatureC, 3);
        Assert.Equal(38.2 * 8.12, r.Watts, 2);
        Assert.Equal(180, r.Rssi);
        Assert.Null(TapPackets.Power(new byte[12]));
    }

    [Fact]
    public void AnAnswerIsReadOnlyWhenItsPacketsAddUp()
    {
        var packet = Packet(0x31, 5, PowerData(700, 700, 100, 1000, 300));
        Assert.Single(TapPackets.Split(packet)!);
        Assert.Null(TapPackets.Split([.. packet, 0x31, 0x00]));   // a torn tail: the whole answer is not read
    }

    private static byte[] Packet(byte type, ushort node, byte[] data) =>
        [type, (byte)(node >> 8), (byte)node, 0x00, 0x05, 0x01, (byte)data.Length, .. data];

    private static byte[] NodeTable(ushort start, params (string Serial, ushort Node)[] entries)
    {
        var d = new List<byte> { (byte)(start >> 8), (byte)start, (byte)(entries.Length >> 8), (byte)entries.Length };
        foreach (var (serial, node) in entries) { d.AddRange(Convert.FromHexString(serial)); d.Add((byte)(node >> 8)); d.Add((byte)node); }
        return [.. d];
    }

    /// <summary>A 0x0149 answer: all optional status fields absent but the counter, then the packets.</summary>
    private static byte[] Answer(ushort echoed, params byte[][] packets)
        => [0x00, 0x0F, (byte)(echoed >> 8), (byte)echoed, 0x00, 0x10, .. packets.SelectMany(p => p)];

    private static TapFrame FromTap(ushort type, byte[] payload) => new(true, Gw, type, payload);

    // --- The bus ------------------------------------------------------------------------------------------

    [Fact]
    public void Listening_NamesEachOptimizerBySerial_EvenWhenItReportedBeforeTheTableArrived()
    {
        var bus = new TigoBus(TigoMode.Listen, startedUtc: T0);
        bus.OnFrame(new TapFrame(false, Gw, TapFrames.Poll, TapPackets.PollPayload(0x10)), T0);   // the CCA polling
        bus.OnFrame(FromTap(TapFrames.PollResponse, Answer(0x10, Packet(0x31, 5, PowerData(764, 401, 128, 1450, 417)))), T0);
        Assert.Equal(TigoBus.Unnamed(Gw, 5), Assert.Single(bus.Optimizers).Serial);

        bus.OnFrame(FromTap(TapFrames.PollResponse, Answer(0x11, Packet(0x27, 0, NodeTable(0, ("04C05B4000ABCDEF", 5), ("04C05B4000ABCD00", 6))))), T0);
        var named = Assert.Single(bus.Optimizers);
        Assert.Equal("04C05B4000ABCDEF", named.Serial);
        Assert.Equal(38.2 * 8.12, named.Report.Watts, 2);
        Assert.Equal(Gw, bus.GatewayId);   // learned from the traffic
        Assert.Null(bus.NextTransmit(T0.AddMinutes(1), TimeSpan.FromSeconds(1)));   // listening never transmits
    }

    [Fact]
    public void Polling_ListensFirst_ReadsTheNodeTable_ThenPollsAndFollowsTheTapsCursor()
    {
        var bus = new TigoBus(TigoMode.Poll, gatewayId: Gw, startedUtc: T0);
        Assert.Null(bus.NextTransmit(T0.AddSeconds(1), TimeSpan.FromSeconds(1)));   // listening first

        var t = T0 + TigoBus.ListenFirst;
        var first = Assert.Single(new TapFramer().Push(bus.NextTransmit(t, TimeSpan.FromSeconds(1))!));
        Assert.Equal(TapFrames.Command, first.Type);
        Assert.Equal(0x0026, TapPackets.Command(first.Payload)!.Value.Subcommand);

        // The node table answer arrives as a 0x0B10 with sub-command 0x27: one page, then an empty one.
        var dsn = TapPackets.Command(first.Payload)!.Value.Dsn;
        bus.OnFrame(FromTap(TapFrames.CommandResponse, [0x00, 0x05, 0x00, 0x27, dsn, .. NodeTable(0, ("04C05B4000ABCDEF", 5))]), t);
        var page2 = Assert.Single(new TapFramer().Push(bus.NextTransmit(t, TimeSpan.FromSeconds(1))!));
        Assert.Equal(TapFrames.Command, page2.Type);
        bus.OnFrame(FromTap(TapFrames.CommandResponse, [0x00, 0x05, 0x00, 0x27, 2, .. NodeTable(1)]), t);

        // Now the receive queue, from packet 0; the TAP answers at 0x0040 with two packets, so the next poll asks for 0x0042.
        var poll = Assert.Single(new TapFramer().Push(bus.NextTransmit(t, TimeSpan.FromSeconds(1))!));
        Assert.Equal(TapFrames.Poll, poll.Type);
        Assert.Equal(TapPackets.PollPayload(0), poll.Payload);
        bus.OnFrame(FromTap(TapFrames.PollResponse, Answer(0x0040,
            Packet(0x31, 5, PowerData(764, 401, 128, 1450, 417)), Packet(0x18, 5, new byte[3]))), t);
        Assert.Equal("04C05B4000ABCDEF", Assert.Single(bus.Optimizers).Serial);

        var next = Assert.Single(new TapFramer().Push(bus.NextTransmit(t.AddSeconds(1), TimeSpan.FromSeconds(1))!));
        Assert.Equal(TapPackets.PollPayload(0x0042), next.Payload);

        // No answer: given up on after the timeout and counted, then polled again.
        Assert.Null(bus.NextTransmit(t.AddSeconds(1.5), TimeSpan.FromSeconds(1)));
        Assert.NotNull(bus.NextTransmit(t.AddSeconds(3), TimeSpan.FromSeconds(1)));
        Assert.Equal(1, bus.Unanswered);
    }

    [Fact]
    public void Polling_StandsDown_WhenItHearsAnotherController()
    {
        var bus = new TigoBus(TigoMode.Poll, gatewayId: Gw, startedUtc: T0);
        bus.OnFrame(new TapFrame(false, Gw, TapFrames.Poll, TapPackets.PollPayload(0x99)), T0.AddSeconds(2));
        Assert.True(bus.OtherController);
        Assert.Null(bus.NextTransmit(T0.AddMinutes(5), TimeSpan.FromSeconds(1)));
    }

    // --- The plugin, end to end ----------------------------------------------------------------------------

    [Fact]
    public async Task ThePlugin_ReadsAGateway_AndSuppliesBoundNodes()
    {
        using var gateway = new TcpListener(IPAddress.Loopback, 0);
        gateway.Start();
        var port = ((IPEndPoint)gateway.LocalEndpoint).Port;

        var cfg = new Config();
        cfg.Plugins["tigo"] = new Dictionary<string, object?>
        {
            ["Enabled"] = true,
            ["Connections"] = new List<object?> { new Dictionary<string, object?> { ["Id"] = "roof", ["Host"] = "127.0.0.1", ["Port"] = port } },
        };
        var plugin = new TigoPlugin();
        Assert.True(plugin.Enabled(cfg));
        Assert.Null(plugin.Misconfigured(cfg));

        var source = new EnergyFlowSource { Type = "tigo", Metric = "realpower", Settings = new() { ["Optimizer"] = "04C05B4000ABCDEF" } };
        var volts = new EnergyFlowSource { Type = "tigo", Metric = "voltage", Settings = new() { ["Optimizer"] = "04C05B4000ABCDEF" } };
        await plugin.ReconcileAsync(cfg, [new SourceBinding("panel_a1", "realpower", source), new SourceBinding("panel_a1", "voltage", volts)], default);

        using var accepted = await gateway.AcceptTcpClientAsync().WaitAsync(TimeSpan.FromSeconds(10));
        var wire = accepted.GetStream();
        await wire.WriteAsync(TapFrames.Encode(Gw, TapFrames.PollResponse,
            Answer(1, Packet(0x27, 0, NodeTable(0, ("04C05B4000ABCDEF", 5))), Packet(0x31, 5, PowerData(764, 401, 128, 1450, 417))), fromTap: true));

        var deadline = DateTime.UtcNow.AddSeconds(10);
        double watts = 0;
        while (DateTime.UtcNow < deadline && !plugin.TryGetValue("panel_a1", "realpower", out watts)) await Task.Delay(50);
        Assert.Equal(38.2 * 8.12, watts, 2);
        Assert.True(plugin.TryGetValue("panel_a1", "voltage", out var v));
        Assert.Equal(38.2, v, 3);
        Assert.False(plugin.TryGetValue("panel_a2", "realpower", out _));   // nothing bound there

        // Offered for adoption by serial, with what it reads.
        var found = Assert.Single(await plugin.DiscoverAsync(cfg, null, default));
        Assert.Equal("04C05B4000ABCDEF", found.Key);
        Assert.Equal(HealthLevel.Good, plugin.Status(cfg).Level);

        // Switching it off stops the bus.
        ((Dictionary<string, object?>)cfg.Plugins["tigo"]!)["Enabled"] = false;
        await plugin.ReconcileAsync(cfg, [], default);
        Assert.Equal(HealthLevel.Off, plugin.Status(cfg).Level);
    }

    private sealed class SomeoneElse : ISingleOwnerLease
    {
        public int Asked;
        public Task<bool> RunIfOwnerAsync(string key, Func<CancellationToken, Task> work, CancellationToken ct) { Asked++; return Task.FromResult(false); }
    }

    [Fact]
    public async Task AGatewayOwnedByAnotherProcess_IsNotOpenedHere()
    {
        // Many RS485 gateways take one TCP client, and two pollers on a bus collide: the lease decides.
        using var gateway = new TcpListener(IPAddress.Loopback, 0);
        gateway.Start();
        var cfg = new Config();
        cfg.Plugins["tigo"] = new Dictionary<string, object?>
        {
            ["Enabled"] = "true",
            ["Connections"] = new List<object?> { new Dictionary<string, object?> { ["Id"] = "roof", ["Host"] = "127.0.0.1", ["Port"] = ((IPEndPoint)gateway.LocalEndpoint).Port.ToString(), ["Mode"] = "Poll" } },
        };
        var lease = new SomeoneElse();
        var plugin = new TigoPlugin();
        plugin.UseLease(lease);
        await plugin.ReconcileAsync(cfg, [], default);

        var deadline = DateTime.UtcNow.AddSeconds(5);
        while (DateTime.UtcNow < deadline && plugin.Status(cfg).Summary != "Standby") await Task.Delay(50);
        Assert.Equal("Standby", plugin.Status(cfg).Summary);
        Assert.True(lease.Asked > 0);
        Assert.False(gateway.Pending());   // nobody connected

        ((Dictionary<string, object?>)cfg.Plugins["tigo"]!)["Enabled"] = "false";
        await plugin.ReconcileAsync(cfg, [], default);
    }

    [Fact]
    public void TheBridgeShipsThePlugin_AndTheLoaderFindsIt()
    {
        var dir = Path.Combine(AppContext.BaseDirectory, "plugins");
        // The test host is not the bridge, so point the loader at the bridge's own build output.
        var bridge = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "rPDU2MQTT", "bin"));
        var built = Directory.Exists(bridge)
            ? Directory.EnumerateFiles(bridge, "rPDU2MQTT.Plugin.Tigo.dll", SearchOption.AllDirectories).FirstOrDefault(f => f.Contains(Path.Combine("plugins", "tigo")))
            : null;
        Assert.True(built is not null, "the bridge's build did not copy the Tigo plugin into plugins/tigo/");
        var loaded = Plugins.PluginLoader.Load(Path.GetDirectoryName(built));
        Assert.Contains(loaded.SelectMany(p => p.Integrations), i => i.Id == "tigo");
    }
}

/// <summary>The plugin's settings page is generated from its settings class, so the schema is what the operator sees.</summary>
public class TigoSettingsSchemaTests
{
    [Fact]
    public void TheSettingsPage_HasConnections_WithAModePicker_AndNoComputedFields()
    {
        var plugin = new rPDU2MQTT.Plugin.Tigo.TigoPlugin();
        var schema = rPDU2MQTT.Services.Gui.ConfigSchema.Build([(plugin.Id, plugin.DisplayName, plugin.ConfigType, "Sources")]);
        var section = Assert.Single(schema, n => n.Key == "tigo");
        var connections = Assert.Single(section.Properties!, p => p.Key == "Connections");
        Assert.Equal("list", connections.Type);
        var fields = connections.ValueSchema!.Properties!;
        var mode = Assert.Single(fields, p => p.Key == "Mode");
        Assert.Equal(["Listen", "Poll"], mode.EnumValues!);
        Assert.DoesNotContain(fields, p => p.Key is "Kind" or "Gateway");
        Assert.Contains(fields, p => p.Key == "Host");
    }
}
