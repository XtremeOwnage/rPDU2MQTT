using System.Text.Json;
using System.Text.Json.Serialization;

namespace rPDU2MQTT.Models.Converters;

/// <summary>
/// Converts a nullable timespan to number of seconds. If timespan is null, will write null.
/// </summary>
public class TimeSpanToSecondsConverter : JsonConverter<TimeSpan?>
{
    public override void Write(Utf8JsonWriter writer, TimeSpan? value, JsonSerializerOptions options)
    {
        if (value.HasValue)
        {
            writer.WriteNumberValue(value.Value.TotalSeconds);
        }
        else
        {
            writer.WriteNullValue();
        }
    }

    public override TimeSpan? Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
    {
        throw new NotSupportedException("This converter only supports writing.");
    }
}
