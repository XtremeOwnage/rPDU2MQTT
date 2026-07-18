namespace rPDU2MQTT.Core.Flow;

/// <summary>
/// Decodes raw Modbus holding/input registers into a number (#129). Kept transport-free so the register
/// maths — data types and 32-bit word order, the parts that actually vary between devices — are testable
/// without a socket, exactly like the MQTT payload parsing is. Byte order within each 16-bit register is
/// the Modbus-standard big-endian and handled by the client; only the word order across a 32-bit pair is a
/// per-device choice we expose here.
/// </summary>
public static class ModbusDecode
{
    /// <summary>How many 16-bit registers a data type spans.</summary>
    public static int RegisterCount(string? dataType) => Normalize(dataType) switch
    {
        "int32" or "uint32" or "float32" => 2,
        _ => 1,   // int16 / uint16
    };

    /// <summary>
    /// Combine <paramref name="registers"/> (in device/register order) into a value per
    /// <paramref name="dataType"/>. For 32-bit types, <paramref name="wordOrder"/> "big" reads the high word
    /// first (ABCD) and "little" the low word first (CDAB, the common word-swapped layout).
    /// </summary>
    public static double Decode(ushort[] registers, string? dataType, string? wordOrder)
    {
        if (registers is null || registers.Length == 0) return 0;
        switch (Normalize(dataType))
        {
            case "int16": return (short)registers[0];
            case "uint16": return registers[0];
        }
        if (registers.Length < 2) return registers[0];   // asked for 32-bit but only got one register

        var little = string.Equals(wordOrder, "little", StringComparison.OrdinalIgnoreCase);
        uint high = little ? registers[1] : registers[0];
        uint low = little ? registers[0] : registers[1];
        var combined = (high << 16) | low;

        return Normalize(dataType) switch
        {
            "int32" => unchecked((int)combined),
            "float32" => BitConverter.Int32BitsToSingle(unchecked((int)combined)),
            _ => combined,   // uint32
        };
    }

    private static string Normalize(string? dataType) => string.IsNullOrWhiteSpace(dataType) ? "uint16" : dataType.Trim().ToLowerInvariant();
}
