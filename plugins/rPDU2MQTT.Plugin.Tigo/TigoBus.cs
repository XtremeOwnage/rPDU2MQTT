namespace rPDU2MQTT.Plugin.Tigo;

/// <summary>How the bridge takes part on a TAP's bus.</summary>
public enum TigoMode
{
    /// <summary>
    /// Read-only, beside a Tigo CCA that does the polling. Nothing is ever transmitted, so nothing the
    /// bridge does can disturb the TAP, and the CCA carries on reporting to Tigo.
    /// </summary>
    Listen,

    /// <summary>
    /// The bridge polls the TAP itself, in place of a CCA. The TAP must already know its optimizers:
    /// commissioning and RSD release are not done here.
    /// </summary>
    Poll,
}

/// <summary>One optimizer's latest reading, and where it came from.</summary>
public sealed record OptimizerReading(string Serial, ushort GatewayId, ushort NodeId, PowerReport Report, DateTime AtUtc, long Reports);

/// <summary>
/// One TAP bus's state, fed frames as they are read. No I/O: the connection hands it frames and asks it what
/// to send, so the protocol can be exercised without a gateway.
/// </summary>
public sealed class TigoBus
{
    private readonly TigoMode mode;
    private readonly double ampsScale;
    private readonly object gate = new();
    /// <summary>Optimizer serial by (gateway, node id), learned from the node table and topology reports.</summary>
    private readonly Dictionary<(ushort Gw, ushort Node), string> serials = new();
    private readonly Dictionary<string, OptimizerReading> readings = new(StringComparer.OrdinalIgnoreCase);

    // Poll mode: where the receive queue stands, and the one request that may be outstanding.
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

    /// <summary>The TAP's gateway id: configured, or learned from the frames on the bus.</summary>
    public ushort? GatewayId { get; private set; }

    public long Frames { get; private set; }
    public long PowerReports { get; private set; }
    public long Polls { get; private set; }
    public long Unanswered { get; private set; }
    public DateTime? LastFrameUtc { get; private set; }
    /// <summary>When the TAP last answered a poll — whoever polled it.</summary>
    public DateTime? LastAnswerUtc { get; private set; }

    /// <summary>How long Poll mode listens before transmitting, to learn the gateway id and to notice a CCA.</summary>
    public static readonly TimeSpan ListenFirst = TimeSpan.FromSeconds(5);
    /// <summary>A request with no answer in this long is given up on.</summary>
    public static readonly TimeSpan AnswerTimeout = TimeSpan.FromMilliseconds(800);
    /// <summary>How often Poll mode re-reads the node table, so a re-learned optimizer is named.</summary>
    public static readonly TimeSpan NodeTableEvery = TimeSpan.FromMinutes(10);

    /// <summary>Another controller was heard polling the TAP: Poll mode stands down rather than fight it.</summary>
    public bool OtherController { get; private set; }

    public IReadOnlyList<OptimizerReading> Optimizers { get { lock (gate) return readings.Values.ToList(); } }

    /// <summary>Take in one frame from the bus.</summary>
    public void OnFrame(TapFrame frame, DateTime nowUtc)
    {
        lock (gate)
        {
            Frames++;
            LastFrameUtc = nowUtc;
            // A frame the bridge did not send, addressed to a TAP: someone else is polling.
            if (!frame.FromTap && mode == TigoMode.Poll && frame.Type == TapFrames.Poll && awaitingSince == DateTime.MinValue
                && nowUtc - lastPoll > TimeSpan.FromSeconds(1))
                OtherController = true;
            GatewayId ??= frame.GatewayId;
            if (!frame.FromTap || frame.GatewayId != GatewayId) return;

            if (frame.Type == TapFrames.PollResponse) Answer(frame, nowUtc);
            else if (frame.Type == TapFrames.CommandResponse && TapPackets.Command(frame.Payload) is { } cmd)
            {
                var paging = nodeTablePage is not null;
                if (cmd.Subcommand == 0x0027 && TapPackets.NodeTable(cmd.Body) is { } page) NodeTablePage(frame.GatewayId, cmd.Body, page);
                // The page asked for has come: the next request may go.
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
            // An answer behind what was asked for is a duplicate of one already taken in.
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

    /// <summary>The key a reading is held under until the node table says whose it is.</summary>
    public static string Unnamed(ushort gatewayId, ushort nodeId) => $"node-{gatewayId:X4}-{nodeId}";

    private void NodeTablePage(ushort gatewayId, byte[] raw, IReadOnlyList<NodeTableEntry> page)
    {
        foreach (var entry in page) Name(gatewayId, entry);
        // Poll mode pages through the table until a page comes back empty.
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
        // A reading taken before the node was named moves to its serial.
        var unnamed = Unnamed(gatewayId, entry.NodeId);
        if (readings.Remove(unnamed, out var r)) readings[entry.Serial] = r with { Serial = entry.Serial };
    }

    /// <summary>
    /// Poll mode: the next frame to transmit, or null when nothing is due. Listen mode never transmits.
    /// </summary>
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

            // The node table first, and again now and then: without it the readings have no serials.
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
