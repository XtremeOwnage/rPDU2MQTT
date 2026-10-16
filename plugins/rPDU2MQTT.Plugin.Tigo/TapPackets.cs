// Ported from openTAPtoX (https://github.com/jontubs/openTAPtoX), MIT License,
// Copyright (c) 2026 openTAPtoX contributors. Unofficial.
namespace rPDU2MQTT.Plugin.Tigo;

/// <summary>Status head of a 0x0149 answer.</summary>
public sealed record RxStatus(ushort Flags, byte? PacketCounterHigh, byte PacketCounterLow, ushort SlotCounter);

/// <param name="Type">0x31 power report, 0x27 node table page, 0x09 topology report.</param>
public sealed record PvPacket(byte Type, ushort NodeId, ushort ShortAddress, byte Dsn, byte[] Data);

/// <summary>Power is input-side: only input current is measured.</summary>
public sealed record PowerReport(double VoltsIn, double VoltsOut, double AmpsIn, double TemperatureC, double DutyPercent, int Rssi, ushort SlotCounter)
{
    public double Watts => VoltsIn * AmpsIn;
}

/// <summary>Serial is the 64-bit long address printed on the optimizer's label.</summary>
public sealed record NodeTableEntry(string Serial, ushort NodeId, bool Pending);

public static class TapPackets
{
    public const double DefaultAmpsScale = 0.0056;

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

    /// <summary>Null unless the queue divides exactly into packets.</summary>
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

    /// <summary>0x31 layout: 12-bit vin/vout, duty, 12-bit iin/temp, ..., slot counter, RSSI.</summary>
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

    /// <summary>Start index, count, then ten bytes per entry.</summary>
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

    public static NodeTableEntry? Topology(byte[] d)
        => d.Length == 23 ? new NodeTableEntry(Convert.ToHexString(d, 8, 8), (ushort)(((d[2] << 8) | d[3]) & 0x7FFF), false) : null;

    /// <summary>Flags, sub-command, sequence number, body.</summary>
    public static (ushort Subcommand, byte Dsn, byte[] Body)? Command(byte[] payload)
        => payload.Length < 5 ? null : ((ushort)((payload[2] << 8) | payload[3]), payload[4], payload[5..]);

    public static byte[] PollPayload(ushort packetNumber) => [0x00, 0x01, (byte)(packetNumber >> 8), (byte)packetNumber, 0x04];

    public static byte[] NodeTableRequest(byte dsn, ushort startIndex) => [0x00, 0x00, 0x00, 0x26, dsn, (byte)(startIndex >> 8), (byte)startIndex];
}
