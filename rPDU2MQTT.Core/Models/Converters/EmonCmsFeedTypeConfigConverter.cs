using System.Text.Json;
using System.Text.Json.Serialization;

namespace rPDU2MQTT.Models.Config;

/// <summary>
/// Reads an <see cref="EmonCmsFeedTypeConfig"/> from either a bare string (the v1 form,
/// <c>Types: ["realpower", "energy"]</c>) or the object form, filling anything absent from the type's
/// own defaults. <c>Daily</c> and <c>DailyIntervalSeconds</c> are read and discarded: daily energy is a
/// type of its own now.
/// </summary>
public sealed class EmonCmsFeedTypeConfigConverter : JsonConverter<EmonCmsFeedTypeConfig>
{
    // A plain surrogate with the same fields but no converter, so deserializing it doesn't recurse.
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

    public override EmonCmsFeedTypeConfig Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
    {
        if (reader.TokenType == JsonTokenType.String)
            return EmonCmsFeedTypeConfig.For(reader.GetString() ?? "realpower");

        var dto = JsonSerializer.Deserialize<Dto>(ref reader, options) ?? new Dto();
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

    public override void Write(Utf8JsonWriter writer, EmonCmsFeedTypeConfig value, JsonSerializerOptions options)
        => JsonSerializer.Serialize(writer, new Dto
        {
            Type = value.Type,
            Enabled = value.Enabled,
            Calculation = value.Calculation,
            Prefix = value.Prefix,
            Suffix = value.Suffix,
            Units = value.Units,
            Engine = value.Engine,
            IntervalSeconds = value.IntervalSeconds,
        }, options);
}
