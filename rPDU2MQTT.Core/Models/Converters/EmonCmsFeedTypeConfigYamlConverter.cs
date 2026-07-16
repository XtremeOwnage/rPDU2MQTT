using YamlDotNet.Core;
using YamlDotNet.Core.Events;
using YamlDotNet.Serialization;

namespace rPDU2MQTT.Models.Config;

/// <summary>
/// YAML counterpart to <see cref="EmonCmsFeedTypeConfigConverter"/>: reads an
/// <see cref="EmonCmsFeedTypeConfig"/> from either a bare scalar (the v1 form,
/// <c>Types: [realpower, energy]</c>) or a mapping, so existing YAML configs keep loading after the
/// per-type rework (#163) rather than failing to deserialize on startup.
/// </summary>
public sealed class EmonCmsFeedTypeConfigYamlConverter : IYamlTypeConverter
{
    // A plain surrogate (no converter) so deserializing the mapping doesn't recurse into this converter.
    private sealed class Dto
    {
        public string? Type { get; set; }
        public EmonCmsFeedEngine? Engine { get; set; }
        public int? IntervalSeconds { get; set; }
        public bool? Daily { get; set; }
        public int? DailyIntervalSeconds { get; set; }
    }

    public bool Accepts(Type type) => type == typeof(EmonCmsFeedTypeConfig);

    public object ReadYaml(IParser parser, Type type, ObjectDeserializer rootDeserializer)
    {
        if (parser.Current is Scalar)
        {
            var scalar = parser.Consume<Scalar>();
            return new EmonCmsFeedTypeConfig { Type = string.IsNullOrWhiteSpace(scalar.Value) ? "realpower" : scalar.Value };
        }

        var dto = (Dto?)rootDeserializer(typeof(Dto)) ?? new Dto();
        var cfg = new EmonCmsFeedTypeConfig { Engine = dto.Engine, IntervalSeconds = dto.IntervalSeconds };
        if (!string.IsNullOrWhiteSpace(dto.Type)) cfg.Type = dto.Type!;
        if (dto.Daily is { } d) cfg.Daily = d;
        if (dto.DailyIntervalSeconds is { } di) cfg.DailyIntervalSeconds = di;
        return cfg;
    }

    public void WriteYaml(IEmitter emitter, object? value, Type type, ObjectSerializer serializer)
    {
        var v = (EmonCmsFeedTypeConfig)value!;
        serializer(new Dto
        {
            Type = v.Type,
            Engine = v.Engine,
            IntervalSeconds = v.IntervalSeconds,
            Daily = v.Daily,
            DailyIntervalSeconds = v.DailyIntervalSeconds,
        }, typeof(Dto));
    }
}
