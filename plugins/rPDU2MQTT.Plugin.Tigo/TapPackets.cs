// What a TAP's answers carry: the optimizers' power reports and the table that names them.
//
// Ported from openTAPtoX (https://github.com/jontubs/openTAPtoX), MIT License,
// Copyright (c) 2026 openTAPtoX contributors. Reverse-engineered and unofficial.
namespace rPDU2MQTT.Plugin.Tigo;

/// <summary>
/// The head of a 0x0149 answer: which fields are present is said by a flags word, and the packet number the
/// TAP echoes tells the controller where its receive queue now stands.
/// </summary>
/// <param name="PacketCounterHigh">The high byte of the echoed packet number, when the TAP sent one.</param>
/// <param name="PacketCounterLow">The low byte of the echoed packet number.</param>
public sealed record RxStatus(ushort Flags, byte? PacketCounterHigh, byte PacketCounterLow, ushort SlotCounter);

/// <summary>One radio packet relayed by the TAP from an optimizer.</summary>
/// <param name="Type">0x31 a power report, 0x27 a page of the node table, 0x09 a topology report.</param>
/// <param name="NodeId">The optimizer's node id on this TAP (the top bit, "pending", already removed).</param>
public sealed record PvPacket(byte Type, ushort NodeId, ushort ShortAddress, byte Dsn, byte[] Data);

/// <summary>
/// One optimizer's electrical reading. Power is the input side, volts in times amps in: the optimizer
/// measures its input current only, so an "output power" from output volts would be a guess.
/// </summary>
public sealed record PowerReport(double VoltsIn, double VoltsOut, double AmpsIn, double TemperatureC, double DutyPercent, int Rssi, ushort SlotCounter)
{
    public double Watts => VoltsIn * AmpsIn;
}

/// <summary>A node table entry: the optimizer's serial (its 64-bit long address, as printed on its label) and its node id.</summary>
public sealed record NodeTableEntry(string Serial, ushort NodeId, bool Pending);

public static class TapPackets
{
    /// <summary>Amps per count of the input-current field. openTAPtoX's calibration.</summary>
    public const double DefaultAmpsScale = 0.0056;

    /// <summary>The status head of a 0x0149 payload, and the packet queue after it; null when it is short.</summary>
    public static (RxStatus Status, byte[] Packets)? ParseResponse(byte[] payload)
    {
        if (payload.Length < 5) return null;
        var flags = (ushort)((payload[0] << 8) | payload[1]);
        var idx = 2;
        bool Skip(int n) { if (idx + n > payload.Length) return false; idx += n; return true; }
        // A clear bit means the field is present.
        if ((flags & 0x0001) == 0 && !Skip(1)) return null;   // receive buffers used
        if ((flags & 0x0002) == 0 && !Skip(1)) return null;   // transmit buffers free
        if ((flags & 0x0004) == 0 && !Skip(2)) return null;
        if ((flags & 0x0008) == 0 && !Skip(2)) return null;
        byte? high = null;
        if ((flags & 0x0010) == 0) { if (idx + 1 > payload.Length) return null; high = payload[idx++]; }
        if (idx + 3 > payload.Length) return null;
        var low = payload[idx++];
        var slot = (ushort)((payload[idx] << 8) | payload[idx + 1]);
        idx += 2;
        return (new RxStatus(flags, high, low, slot), payload[idx..]);
    }

    /// <summary>
    /// The packets in a queue. Returns null when the queue does not divide exactly into packets: a torn
    /// answer is not read at all, rather than read up to the tear.
    /// </summary>
    public static IReadOnlyList<PvPacket>? Split(byte[] queue)
    {
        var packets = new List<PvPacket>();
        var idx = 0;
        while (idx + 7 <= queue.Length)
        {
            var len = queue[idx + 6];
            var end = idx + 7 + len;
            if (end > queue.Length) return null;
            packets.Add(new PvPacket(queue[idx], (ushort)(((queue[idx + 1] << 8) | queue[idx + 2]) & 0x7FFF),
                (ushort)((queue[idx + 3] << 8) | queue[idx + 4]), queue[idx + 5], queue[(idx + 7)..end]));
            idx = end;
        }
        return idx == queue.Length ? packets : null;
    }

    /// <summary>A 0x31 packet's 13 bytes: three 12-bit fields packed across bytes 0-6, then duty, slot counter and RSSI.</summary>
    public static PowerReport? Power(byte[] d, double ampsScale = DefaultAmpsScale)
    {
        if (d.Length != 13) return null;
        var vin = ((d[0] << 4) | (d[1] >> 4)) & 0x0FFF;
        var vout = (((d[1] & 0x0F) << 8) | d[2]) & 0x0FFF;
        var iin = ((d[4] << 4) | (d[5] >> 4)) & 0x0FFF;
        var temp = (((d[5] & 0x0F) << 8) | d[6]) & 0x0FFF;
        return new PowerReport(vin * 0.05, vout * 0.10, iin * ampsScale, temp * 0.10, d[3] / 255.0 * 100.0, d[12],
            (ushort)((d[10] << 8) | d[11]));
    }

    /// <summary>A page of the node table: start index, count, then ten bytes per entry.</summary>
    public static IReadOnlyList<NodeTableEntry>? NodeTable(byte[] d)
    {
        if (d.Length < 4) return null;
        var count = (d[2] << 8) | d[3];
        if (d.Length != 4 + count * 10) return null;
        var entries = new List<NodeTableEntry>(count);
        for (var i = 0; i < count; i++)
        {
            var at = 4 + i * 10;
            var raw = (ushort)((d[at + 8] << 8) | d[at + 9]);
            entries.Add(new NodeTableEntry(Convert.ToHexString(d, at, 8), (ushort)(raw & 0x7FFF), (raw & 0x8000) != 0));
        }
        return entries;
    }

    /// <summary>A 0x09 topology report names one optimizer: its node id and serial.</summary>
    public static NodeTableEntry? Topology(byte[] d)
        => d.Length == 23 ? new NodeTableEntry(Convert.ToHexString(d, 8, 8), (ushort)(((d[2] << 8) | d[3]) & 0x7FFF), false) : null;

    /// <summary>A 0x0B0F/0x0B10 payload: flags, sub-command, sequence number, body.</summary>
    public static (ushort Subcommand, byte Dsn, byte[] Body)? Command(byte[] payload)
        => payload.Length < 5 ? null : ((ushort)((payload[2] << 8) | payload[3]), payload[4], payload[5..]);

    /// <summary>A poll for the TAP's receive queue from <paramref name="packetNumber"/> on.</summary>
    public static byte[] PollPayload(ushort packetNumber) => [0x00, 0x01, (byte)(packetNumber >> 8), (byte)packetNumber, 0x04];

    /// <summary>A request for the page of the node table starting at <paramref name="startIndex"/> (sub-command 0x26).</summary>
    public static byte[] NodeTableRequest(byte dsn, ushort startIndex) => [0x00, 0x00, 0x00, 0x26, dsn, (byte)(startIndex >> 8), (byte)startIndex];
}
