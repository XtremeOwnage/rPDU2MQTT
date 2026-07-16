using System.Text.Json;
using System.Text.Json.Serialization;

namespace rPDU2MQTT.Models.Config;

/// <summary>
/// Reads an <see cref="EmonCmsFeedTypeConfig"/> from either a bare string (the original v1 form,
/// <c>Types: ["realpower", "energy"]</c>) or the full object form. Keeps existing persisted config
/// loadable after the per-type rework (#163) instead of crashing on startup.
/// </summary>
public sealed class EmonCmsFeedTypeConfigConverter : JsonConverter<EmonCmsFeedTypeConfig>
{
    // A plain surrogate with the same fields but no converter, so deserializing it doesn't recurse.
    private sealed class Dto
    {
        public string? Type { get; set; }
        public EmonCmsFeedEngine? Engine { get; set; }
        public int? IntervalSeconds { get; set; }
        public bool? Daily { get; set; }
        public int? DailyIntervalSeconds { get; set; }
    }

    public override EmonCmsFeedTypeConfig Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
    {
        if (reader.TokenType == JsonTokenType.String)
            return new EmonCmsFeedTypeConfig { Type = reader.GetString() ?? "realpower" };

        var dto = JsonSerializer.Deserialize<Dto>(ref reader, options) ?? new Dto();
        var cfg = new EmonCmsFeedTypeConfig();
        if (!string.IsNullOrWhiteSpace(dto.Type)) cfg.Type = dto.Type!;
        if (dto.Engine is { } e) cfg.Engine = e;
        if (dto.IntervalSeconds is { } i) cfg.IntervalSeconds = i;
        if (dto.Daily is { } d) cfg.Daily = d;
        if (dto.DailyIntervalSeconds is { } di) cfg.DailyIntervalSeconds = di;
        return cfg;
    }

    public override void Write(Utf8JsonWriter writer, EmonCmsFeedTypeConfig value, JsonSerializerOptions options)
        => JsonSerializer.Serialize(writer, new Dto
        {
            Type = value.Type,
            Engine = value.Engine,
            IntervalSeconds = value.IntervalSeconds,
            Daily = value.Daily,
            DailyIntervalSeconds = value.DailyIntervalSeconds,
        }, options);
}
