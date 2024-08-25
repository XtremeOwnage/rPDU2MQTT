using rPDU2MQTT.Models.HomeAssistant;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace rPDU2MQTT.Models.Converters;

/// <summary>
/// Serializes <see cref="DiscoveryDevice"/> to <see cref="DiscoveryDevice.UniqueIdentifier"/>
/// </summary>
public class DeviceToUniqueIdentifierConverter : JsonConverter<DiscoveryDevice?>
{
    public override DiscoveryDevice? Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
    {
        throw new NotImplementedException("This serializer only writes. Never reads.");
    }

    public override void Write(Utf8JsonWriter writer, DiscoveryDevice? value, JsonSerializerOptions options)
    {
        if (value is null)
        {
            writer.WriteNullValue();
            return;
        }

        var identifer = value.UniqueIdentifier;

        if (!string.IsNullOrEmpty(identifer))
            writer.WriteStringValue(identifer);
        else
            writer.WriteNullValue();
    }
}
