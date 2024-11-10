using rPDU2MQTT.Extensions;
using rPDU2MQTT.Interfaces;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace rPDU2MQTT.Models.Converters;

/// <summary>
/// This will take a dictionary of <typeparamref name="TObject"/>, with Key of type <typeparamref name="TKey"/>, and convert to a <see cref="List{T}"/>.
/// 
/// The Dictionary's key will be copied to <see cref="IDictionaryKey{TKeyType}.Key"/> on <see cref="TObject"/>
/// </summary>
/// <typeparam name="TObject"></typeparam>
/// <typeparam name="TKey"></typeparam>
public sealed class DictionaryToListConverter<TObject, TKey> : JsonConverter<List<TObject>?>
    where TKey : notnull
    where TObject : IDictionaryKey<TKey>, new()
{
    public override List<TObject>? Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
    {
        Type expectedType = typeof(Dictionary<TKey, TObject>);
        Console.WriteLine(reader.ToJsonString());
        var newDictionary = JsonSerializer.Deserialize(ref reader, expectedType, options) as Dictionary<TKey, TObject>;

        if (newDictionary is null)
            return null;

        foreach (var (key, item) in newDictionary)
        {
            item.Key = key;
        }

        return newDictionary.Values.ToList();
    }

    public override void Write(Utf8JsonWriter writer, List<TObject>? value, JsonSerializerOptions options)
    {
        throw new NotSupportedException();
    }
}
