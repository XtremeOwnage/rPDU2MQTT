using System.Text.Json;
using System.Text.Json.Nodes;
using YamlDotNet.Core;
using YamlDotNet.Serialization;

namespace rPDU2MQTT.Models.Config;

/// <summary>
/// Writes JSON values held in free-form config bags (<c>Config.Plugins</c>, a source's <c>Settings</c>, an
/// entity's <c>Ext</c>) as plain YAML. A config saved from the GUI holds them as <see cref="JsonElement"/>,
/// which YamlDotNet otherwise writes as its own properties (<c>ValueKind: Object</c>), losing the content.
/// </summary>
public sealed class JsonYamlConverter : IYamlTypeConverter
{
    public bool Accepts(Type type) => type == typeof(JsonElement) || typeof(JsonNode).IsAssignableFrom(type);

    public object ReadYaml(IParser parser, Type type, ObjectDeserializer rootDeserializer)
        => throw new NotSupportedException("JSON values are only written, never read, as YAML.");

    public void WriteYaml(IEmitter emitter, object? value, Type type, ObjectSerializer serializer)
    {
        var plain = value switch
        {
            JsonElement e => Plain(e),
            JsonNode n => Plain(JsonSerializer.SerializeToElement(n)),
            _ => null,
        };
        serializer(plain, plain?.GetType() ?? typeof(object));
    }

    private static object? Plain(JsonElement e) => e.ValueKind switch
    {
        JsonValueKind.Object => e.EnumerateObject().ToDictionary(p => p.Name, p => Plain(p.Value)),
        JsonValueKind.Array => e.EnumerateArray().Select(Plain).ToList(),
        JsonValueKind.String => e.GetString(),
        JsonValueKind.Number => e.TryGetInt64(out var n) ? n : e.GetDouble(),
        JsonValueKind.True => true,
        JsonValueKind.False => false,
        _ => null,
    };
}
