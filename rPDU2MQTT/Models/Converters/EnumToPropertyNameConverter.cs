using System.Reflection;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace rPDU2MQTT.Models.Converters;

public class EnumToPropertyNameConverter: JsonConverter<object>
{
    public override bool CanConvert(Type typeToConvert)
    {
        Type? underlyingType = Nullable.GetUnderlyingType(typeToConvert);
        if (underlyingType is not null)
            return underlyingType.IsEnum;

        return typeToConvert.IsEnum;
    }

    public override void Write(Utf8JsonWriter writer, object value, JsonSerializerOptions options)
    {
        var field = value.GetType().GetField(value.ToString());
        var attribute = field?.GetCustomAttribute<JsonPropertyNameAttribute>();

        if (!string.IsNullOrEmpty(attribute?.Name))
        {
            writer.WriteStringValue(attribute.Name);
        }
        else
        {
            // The expected [JsonPropertyName] attribute should always be attached to enum members.
            Log.Warning($"Enum value '{value}' ({value.GetType().Name}) has no JsonPropertyName attribute; writing null.");
            writer.WriteNullValue();
        }
    }

    public override object Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
    {
        throw new Exception($"Reading... is unsupported.");
    }
}
