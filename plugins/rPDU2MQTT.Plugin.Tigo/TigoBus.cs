namespace rPDU2MQTT.Plugin.Tigo;

public enum TigoMode
{
    /// <summary>Read-only beside a CCA; never transmits.</summary>
    Listen,

    /// <summary>Polls the TAP in place of a CCA; no commissioning or RSD release.</summary>
    Poll,
}

public sealed record OptimizerReading(string Serial, ushort GatewayId, ushort NodeId, PowerReport Report, DateTime AtUtc, long Reports);

/// <summary>Protocol state for one TAP bus; no I/O.</summary>
public sealed class TigoBus
{
    private readonly TigoMode mode;
    private readonly double ampsScale;
    private readonly object gate = new();
    private readonly Dictionary<(ushort Gw, ushort Node), string> serials = new();
    private readonly Dictionary<string, OptimizerReading> readings = new(StringComparer.OrdinalIgnoreCase);

    // Poll mode state.
    private ushort nextPacket;
    private ushort requestedPacket;
    private DateTime awaitingSince = DateTime.MinValue;
    private DateTime lastPoll = DateTime.MinValue;
    private DateTime lastNodeTable = DateTime.MinValue;
    private ushort? nodeTablePage;
    private byte dsn;

    public TigoBus(TigoMode mode, ushort? gatewayId = null, double ampsScale = TapPackets.DefaultAmpsScale, DateTime? startedUtc = null)
    {
        this.mode = mode;
        this.ampsScale = ampsScale;
        GatewayId = gatewayId;
        StartedUtc = startedUtc ?? DateTime.UtcNow;
    }

    public TigoMode Mode => mode;
    public DateTime StartedUtc { get; }

    /// <summary>Configured, or learned from the bus.</summary>
    public ushort? GatewayId { get; private set; }

    public long Frames { get; private set; }
    public long PowerReports { get; private set; }
    public long Polls { get; private set; }
    public long Unanswered { get; private set; }
    public DateTime? LastFrameUtc { get; private set; }
    public DateTime? LastAnswerUtc { get; private set; }

    /// <summary>Poll mode listens this long before transmitting.</summary>
    public static readonly TimeSpan ListenFirst = TimeSpan.FromSeconds(5);
    public static readonly TimeSpan AnswerTimeout = TimeSpan.FromMilliseconds(800);
    public static readonly TimeSpan NodeTableEvery = TimeSpan.FromMinutes(10);

    /// <summary>Another controller is polling; Poll mode stands down.</summary>
    public bool OtherController { get; private set; }

    public IReadOnlyList<OptimizerReading> Optimizers { get { lock (gate) return readings.Values.ToList(); } }

    public IReadOnlyList<(ushort Gw, ushort Node, string Serial)> Serials
    {
        get { lock (gate) return serials.Select(kv => (kv.Key.Gw, kv.Key.Node, kv.Value)).ToList(); }
    }

    /// <summary>Seed from a store after a restart; what the bus has already said wins.</summary>
    public void Restore(IEnumerable<(ushort Gw, ushort Node, string Serial)> names, IEnumerable<OptimizerReading> saved)
    {
        lock (gate)
        {
            foreach (var r in saved)
                if (!readings.ContainsKey(r.Serial)) readings[r.Serial] = r;
            foreach (var (gw, node, serial) in names)
                if (!serials.ContainsKey((gw, node))) Name(gw, new NodeTableEntry(serial, node, false));
        }
    }

    public void OnFrame(TapFrame frame, DateTime nowUtc)
    {
        lock (gate)
        {
            Frames++;
            LastFrameUtc = nowUtc;
            // A poll the bridge did not send.
            if (!frame.FromTap && mode == TigoMode.Poll && frame.Type == TapFrames.Poll && awaitingSince == DateTime.MinValue
                && nowUtc - lastPoll > TimeSpan.FromSeconds(1))
                OtherController = true;
            // Enumeration frames carry address 0.
            if (frame.Type is TapFrames.Poll or TapFrames.PollResponse && frame.GatewayId != 0)
                GatewayId = mode == TigoMode.Poll ? GatewayId ?? frame.GatewayId : frame.GatewayId;
            if (!frame.FromTap || (mode == TigoMode.Poll && frame.GatewayId != GatewayId)) return;

            if (frame.Type == TapFrames.PollResponse) Answer(frame, nowUtc);
            else if (frame.Type == TapFrames.CommandResponse && TapPackets.Command(frame.Payload) is { } cmd)
            {
                var paging = nodeTablePage is not null;
                if (cmd.Subcommand == 0x0027 && TapPackets.NodeTable(cmd.Body) is { } page) NodeTablePage(frame.GatewayId, cmd.Body, page);
                if (paging && cmd.Subcommand == 0x0027) awaitingSince = DateTime.MinValue;
            }
        }
    }

    private void Answer(TapFrame frame, DateTime nowUtc)
    {
        if (TapPackets.ParseResponse(frame.Payload) is not { } parsed) return;
        if (TapPackets.Split(parsed.Packets) is not { } packets) return;
        LastAnswerUtc = nowUtc;

        if (mode == TigoMode.Poll && awaitingSince != DateTime.MinValue && nodeTablePage is null)
        {
            var high = parsed.Status.PacketCounterHigh ?? (byte)(requestedPacket >> 8);
            var echoed = (ushort)((high << 8) | parsed.Status.PacketCounterLow);
            // Behind the requested packet: a duplicate.
            if ((ushort)(echoed - requestedPacket) >= 0x8000) return;
            nextPacket = (ushort)(echoed + packets.Count);
            awaitingSince = DateTime.MinValue;
        }

        foreach (var p in packets)
        {
            switch (p.Type)
            {
                case 0x31 when TapPackets.Power(p.Data, ampsScale) is { } power:
                    PowerReports++;
                    var serial = serials.TryGetValue((frame.GatewayId, p.NodeId), out var s) ? s : Unnamed(frame.GatewayId, p.NodeId);
                    var count = readings.TryGetValue(serial, out var prev) ? prev.Reports + 1 : 1;
                    readings[serial] = new OptimizerReading(serial, frame.GatewayId, p.NodeId, power, nowUtc, count);
                    break;
                case 0x27 when TapPackets.NodeTable(p.Data) is { } page:
                    NodeTablePage(frame.GatewayId, p.Data, page);
                    break;
                case 0x09 when TapPackets.Topology(p.Data) is { } named:
                    Name(frame.GatewayId, named);
                    break;
            }
        }
    }

    /// <summary>Key for a reading whose serial is not yet known.</summary>
    public static string Unnamed(ushort gatewayId, ushort nodeId) => $"node-{gatewayId:X4}-{nodeId}";

    private void NodeTablePage(ushort gatewayId, byte[] raw, IReadOnlyList<NodeTableEntry> page)
    {
        foreach (var entry in page) Name(gatewayId, entry);
        if (nodeTablePage is not null)
        {
            var start = (ushort)((raw[0] << 8) | raw[1]);
            nodeTablePage = page.Count == 0 || page.Count > 64 ? null : (ushort)(start + page.Count);
            if (nodeTablePage is null) lastNodeTable = LastFrameUtc ?? DateTime.UtcNow;
        }
    }

    private void Name(ushort gatewayId, NodeTableEntry entry)
    {
        serials[(gatewayId, entry.NodeId)] = entry.Serial;
        var unnamed = Unnamed(gatewayId, entry.NodeId);
        if (readings.Remove(unnamed, out var r)) readings[entry.Serial] = r with { Serial = entry.Serial };
    }

    /// <summary>The next frame to transmit, or null.</summary>
    public byte[]? NextTransmit(DateTime nowUtc, TimeSpan pollEvery)
    {
        if (mode != TigoMode.Poll) return null;
        lock (gate)
        {
            if (OtherController || GatewayId is not { } gw) return null;
            if (nowUtc - StartedUtc < ListenFirst) return null;
            if (awaitingSince != DateTime.MinValue)
            {
                if (nowUtc - awaitingSince < AnswerTimeout) return null;
                Unanswered++;
                awaitingSince = DateTime.MinValue;
                if (nodeTablePage is not null) { nodeTablePage = null; lastNodeTable = nowUtc; }
            }

            if (nodeTablePage is null && nowUtc - lastNodeTable >= NodeTableEvery) nodeTablePage = 0;
            if (nodeTablePage is { } start)
            {
                awaitingSince = nowUtc;
                dsn = (byte)(dsn is 0 or 0xFE ? 1 : dsn + 1);
                return TapFrames.Encode(gw, TapFrames.Command, TapPackets.NodeTableRequest(dsn, start));
            }

            if (nowUtc - lastPoll < pollEvery) return null;
            lastPoll = nowUtc;
            awaitingSince = nowUtc;
            requestedPacket = nextPacket;
            Polls++;
            return TapFrames.Encode(gw, TapFrames.Poll, TapPackets.PollPayload(nextPacket));
        }
    }
}
