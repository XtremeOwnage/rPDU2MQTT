using System.Text.Json;
using System.Text.Json.Serialization;

namespace rPDU2MQTT.Models.Converters;

public sealed class CaseInsensitiveDictionaryConverter<TValue> : JsonConverter<Dictionary<string, TValue>>
{
    public override Dictionary<string, TValue> Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
    {
        var newDictionary = (Dictionary<string, TValue>)JsonSerializer.Deserialize(ref reader, typeToConvert, options);
        return new Dictionary<string, TValue>(newDictionary, StringComparer.OrdinalIgnoreCase);
    }

    public override void Write(Utf8JsonWriter writer, Dictionary<string, TValue> value, JsonSerializerOptions options)
    {
        JsonSerializer.Serialize(writer, value, value.GetType(), options);
    }
}
