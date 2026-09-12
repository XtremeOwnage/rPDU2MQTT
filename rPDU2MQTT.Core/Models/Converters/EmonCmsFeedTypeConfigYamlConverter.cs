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
        public bool? Enabled { get; set; }
        public EmonCmsCalculation? Calculation { get; set; }
        public bool? CalculateWithEmonCms { get; set; }
        public string? Prefix { get; set; }
        public string? Suffix { get; set; }
        public string? Units { get; set; }
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
            return EmonCmsFeedTypeConfig.For(string.IsNullOrWhiteSpace(scalar.Value) ? "realpower" : scalar.Value);
        }

        var dto = (Dto?)rootDeserializer(typeof(Dto)) ?? new Dto();
        var cfg = EmonCmsFeedTypeConfig.For(string.IsNullOrWhiteSpace(dto.Type) ? "realpower" : dto.Type!);
        if (dto.Enabled is { } e) cfg.Enabled = e;
        if (dto.Calculation is { } calc) cfg.Calculation = calc;
        // The v1 boolean: false meant this bridge's own reading and nothing derived.
        else if (dto.CalculateWithEmonCms is false) cfg.Calculation = EmonCmsCalculation.ForceLocal;
        if (dto.Prefix is not null) cfg.Prefix = dto.Prefix;
        if (!string.IsNullOrWhiteSpace(dto.Suffix)) cfg.Suffix = dto.Suffix!;
        if (!string.IsNullOrWhiteSpace(dto.Units)) cfg.Units = dto.Units!;
        if (dto.Engine is { } en) cfg.Engine = en;
        if (dto.IntervalSeconds is { } i) cfg.IntervalSeconds = i;
        return cfg;
    }

    public void WriteYaml(IEmitter emitter, object? value, Type type, ObjectSerializer serializer)
    {
        var v = (EmonCmsFeedTypeConfig)value!;
        serializer(new Dto
        {
            Type = v.Type,
            Enabled = v.Enabled,
            Calculation = v.Calculation,
            Prefix = v.Prefix,
            Suffix = v.Suffix,
            Units = v.Units,
            Engine = v.Engine,
            IntervalSeconds = v.IntervalSeconds,
        }, typeof(Dto));
    }
}
