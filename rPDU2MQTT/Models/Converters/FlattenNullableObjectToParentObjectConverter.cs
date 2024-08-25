using System.Text.Json;
using System.Text.Json.Serialization;

namespace rPDU2MQTT.Models.Converters;

/// <summary>
/// If entity is not null, its contents will be serialized into the PARENT object. (Not a child object!)
/// Flattens the properties of the specified object into the parent object during serialization.
/// </summary>
public class FlattenNullableObjectToParentObjectConverter : JsonConverter<object?>
{
    public override bool CanConvert(Type typeToConvert)
    {
        return true;
    }
    public override object Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
    {
        // Implement the Read method if deserialization is needed.
        throw new NotImplementedException();
    }

    public override void Write(Utf8JsonWriter writer, object? value, JsonSerializerOptions options)
    {
        if (value == null)
        {
            return;
        }

        // Serialize the object to JSON
        var jsonString = JsonSerializer.Serialize(value, options);
        using var jsonDoc = JsonDocument.Parse(jsonString);

        foreach (var property in jsonDoc.RootElement.EnumerateObject())
        {
            property.WriteTo(writer);
        }
    }
}