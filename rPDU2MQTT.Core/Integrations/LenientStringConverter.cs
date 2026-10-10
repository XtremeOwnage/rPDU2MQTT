using System.Text.Json;
using System.Text.Json.Serialization;

namespace rPDU2MQTT.Core.Integrations;

/// <summary>
/// Reads a number or true/false into a text field. A YAML scalar such as a room named 2 reaches a plugin as a
/// number, and one such field must not make the whole section unreadable.
/// </summary>
public sealed class LenientStringConverter : JsonConverter<string>
{
    public override string? Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options) => reader.TokenType switch
    {
        JsonTokenType.String => reader.GetString(),
        JsonTokenType.Number => reader.TryGetInt64(out var whole)
            ? whole.ToString(System.Globalization.CultureInfo.InvariantCulture)
            : reader.GetDouble().ToString("R", System.Globalization.CultureInfo.InvariantCulture),
        JsonTokenType.True => "true",
        JsonTokenType.False => "false",
        JsonTokenType.Null => null,
        _ => throw new JsonException($"Expected text, found {reader.TokenType}."),
    };

    public override void Write(Utf8JsonWriter writer, string value, JsonSerializerOptions options) => writer.WriteStringValue(value);
}
