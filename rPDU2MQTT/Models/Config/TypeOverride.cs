using rPDU2MQTT.Models.Converters;
using System.Text.Json.Serialization;

namespace rPDU2MQTT.Models.Config;

/// <summary>
/// This defines the schema for overrides for a specific section.
/// </summary>
/// <typeparam name="string">This is the type of key used.</typeparam>
public class TypeOverride
{
    [JsonConverter(typeof(CaseInsensitiveDictionaryConverter<string>))]
    [JsonPropertyName("ID")]
    /// <summary>
    /// Allows overriding the generated EntityName.
    /// </summary>
    /// <remarks>
    /// This maps to <see cref="Models.HomeAssistant.baseClasses.baseEntity.Name"/>, ie, "object_id"
    /// </remarks>
    public Dictionary<string, string> ID { get; set; } = new();

    [JsonConverter(typeof(CaseInsensitiveDictionaryConverter<string>))]
    [JsonPropertyName("Name")]
    /// <summary>
    /// Allows overriding the Name / Display Name.
    /// </summary>
    /// <remarks>
    /// This maps to <see cref="Models.HomeAssistant.baseClasses.baseEntity.DisplayName"/>, ie, "name"
    /// </remarks>
    public Dictionary<string, string> Name { get; set; } = new();

    [JsonConverter(typeof(CaseInsensitiveDictionaryConverter<bool>))]
    [JsonPropertyName("Enabled")]
    /// <summary>
    /// Allows enabling, or disabling specific entities.
    /// </summary>
    public Dictionary<string, bool> Enabled { get; set; } = new();

    /// <summary>
    /// Remove any entites which are marked as disabled.
    /// </summary>
    /// <typeparam name="TEntity"></typeparam>
    /// <param name="Entities"></param>
    public void RemoveDisabledRecords<TEntity>(Dictionary<string, TEntity> Entities, Func<TEntity, string>? KeyFunc = null)
    {
        //Remove any disabled entities.
        foreach (var item in Entities.ToList())
        {
            string Key = KeyFunc is null ? item.Key : KeyFunc.Invoke(item.Value);
            if (Enabled.TryGetValue(Key, out bool IsEnabled) && IsEnabled == false)
            {
                Entities.Remove(item.Key);
            }
        }
    }
}
