// The wire format of the RS485 bus between a Tigo controller (the CCA, or this bridge) and a TAP.
//
// Ported from openTAPtoX (https://github.com/jontubs/openTAPtoX), MIT License,
// Copyright (c) 2026 openTAPtoX contributors. The protocol is reverse-engineered and unofficial; it is not
// affiliated with or endorsed by Tigo.
//
//   00 FF FF | 7E 07 | address:u16be | type:u16be | payload | crc16:u16le | 7E 08
//
// Inside the start and end markers, 0x7E is an escape: 7E 00..06 stand for 7E 24 23 25 A4 A3 A5. The
// address's top bit is set on frames from the TAP; the other fifteen bits are the gateway id.
namespace rPDU2MQTT.Plugin.Tigo;

/// <summary>One frame off the bus, checked.</summary>
/// <param name="FromTap">Sent by the TAP (the address's top bit), rather than by the controller polling it.</param>
/// <param name="GatewayId">The id the controller addresses the TAP by.</param>
/// <param name="Type">What the frame is: 0x0148 a poll, 0x0149 its answer, 0x0B0F/0x0B10 a command and its answer.</param>
public sealed record TapFrame(bool FromTap, ushort GatewayId, ushort Type, byte[] Payload);

public static class TapFrames
{
    public const ushort Poll = 0x0148;
    public const ushort PollResponse = 0x0149;
    public const ushort Command = 0x0B0F;
    public const ushort CommandResponse = 0x0B10;

    private static readonly byte[] Unescaped = [0x7E, 0x24, 0x23, 0x25, 0xA4, 0xA3, 0xA5];
    private static readonly ushort[] CrcTable = BuildCrcTable();

    private static ushort[] BuildCrcTable()
    {
        var table = new ushort[256];
        for (var value = 0; value < 256; value++)
        {
            var crc = value;
            for (var bit = 0; bit < 8; bit++) crc = (crc & 1) != 0 ? (crc >> 1) ^ 0x8408 : crc >> 1;
            table[value] = (ushort)crc;
        }
        return table;
    }

    /// <summary>Tigo's CRC-16: the reflected CCITT polynomial, seeded with 0x8408 rather than the usual 0xFFFF.</summary>
    public static ushort Crc(ReadOnlySpan<byte> data)
    {
        ushort crc = 0x8408;
        foreach (var b in data) crc = (ushort)((crc >> 8) ^ CrcTable[(crc ^ b) & 0xFF]);
        return crc;
    }

    /// <summary>The bytes to put on the bus for one frame from the controller (or, for a test, from the TAP).</summary>
    public static byte[] Encode(ushort gatewayId, ushort type, ReadOnlySpan<byte> payload, bool fromTap = false)
    {
        var body = new byte[4 + payload.Length + 2];
        var address = (ushort)((gatewayId & 0x7FFF) | (fromTap ? 0x8000 : 0));
        body[0] = (byte)(address >> 8); body[1] = (byte)address;
        body[2] = (byte)(type >> 8); body[3] = (byte)type;
        payload.CopyTo(body.AsSpan(4));
        var crc = Crc(body.AsSpan(0, 4 + payload.Length));
        body[^2] = (byte)crc; body[^1] = (byte)(crc >> 8);

        var wire = new List<byte>(body.Length + 12) { 0x00, 0xFF, 0xFF, 0x7E, 0x07 };
        foreach (var b in body)
        {
            var escaped = Array.IndexOf(Unescaped, b);
            if (escaped >= 0) { wire.Add(0x7E); wire.Add((byte)escaped); }
            else wire.Add(b);
        }
        wire.Add(0x7E); wire.Add(0x08);
        return [.. wire];
    }

    /// <summary>A frame's body between its markers, unescaped and checked; null when it does not hold together.</summary>
    public static TapFrame? Decode(ReadOnlySpan<byte> escaped)
    {
        var body = new List<byte>(escaped.Length);
        for (var i = 0; i < escaped.Length; i++)
        {
            if (escaped[i] != 0x7E) { body.Add(escaped[i]); continue; }
            if (i + 1 >= escaped.Length || escaped[i + 1] >= Unescaped.Length) return null;
            body.Add(Unescaped[escaped[++i]]);
        }
        if (body.Count < 6) return null;
        var data = body.Take(body.Count - 2).ToArray();
        var crc = (ushort)(body[^2] | (body[^1] << 8));
        if (crc != Crc(data)) return null;
        var address = (ushort)((data[0] << 8) | data[1]);
        return new TapFrame((address & 0x8000) != 0, (ushort)(address & 0x7FFF), (ushort)((data[2] << 8) | data[3]), data[4..]);
    }
}

/// <summary>
/// Turns a byte stream into frames. Bytes arrive in whatever chunks the gateway sends them; a frame can span
/// two reads, and a stream joined mid-frame starts with half of one, which is dropped.
/// </summary>
public sealed class TapFramer
{
    private readonly List<byte> buffer = [];

    /// <summary>Frames whose CRC or escaping did not check, since the framer was made.</summary>
    public long Rejected { get; private set; }

    /// <summary>Add what was read and take out every frame now complete.</summary>
    public IReadOnlyList<TapFrame> Push(ReadOnlySpan<byte> bytes)
    {
        buffer.AddRange(bytes.ToArray());
        var frames = new List<TapFrame>();
        while (true)
        {
            var start = Find(0x07, 0);
            if (start < 0)
            {
                // Keep a trailing 0x7E: it may be the first half of the next start marker.
                var keep = buffer.Count > 0 && buffer[^1] == 0x7E ? 1 : 0;
                buffer.RemoveRange(0, buffer.Count - keep);
                return frames;
            }
            if (start > 0) buffer.RemoveRange(0, start);
            var end = Find(0x08, 2);
            if (end < 0)
            {
                // A frame that never ends is noise; do not let it grow without bound.
                if (buffer.Count > 4096) buffer.RemoveRange(0, 2);
                return frames;
            }
            // A second start before the end means the first frame was cut off; resync on the second.
            var restart = Find(0x07, 2);
            if (restart >= 0 && restart < end) { buffer.RemoveRange(0, restart); Rejected++; continue; }

            var frame = TapFrames.Decode(buffer.GetRange(2, end - 2).ToArray());
            buffer.RemoveRange(0, end + 2);
            if (frame is null) Rejected++;
            else frames.Add(frame);
        }
    }

    /// <summary>Where 7E followed by <paramref name="marker"/> is, from <paramref name="from"/>, or -1.</summary>
    private int Find(byte marker, int from)
    {
        for (var i = from; i + 1 < buffer.Count; i++)
        {
            if (buffer[i] != 0x7E) continue;
            if (buffer[i + 1] == marker) return i;
            i++;   // an escape pair: its second byte is never a marker
        }
        return -1;
    }
}
