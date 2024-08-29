using rPDU2MQTT.Helpers;
using rPDU2MQTT.Interfaces;
using rPDU2MQTT.Models.Config;
using rPDU2MQTT.Models.PDU.basePDU;
using rPDU2MQTT.Models.PDU.DummyDevices;

namespace rPDU2MQTT.Extensions;

public static class EntityWithName_Overrides
{
    /// <summary>
    /// This method will both apply any overides specified for entity_id, and name. And, it will return if this entity is enabled or not.
    /// </summary>
    /// <typeparam name="TEntity"></typeparam>
    /// <typeparam name="Key"></typeparam>
    /// <param name="entity"></param>
    /// <param name="key"></param>
    /// <param name="Overrides"></param>
    /// <returns></returns>
    public static void ApplyOverrides<TEntity>(this TEntity entity, string key, TypeOverride Overrides, string? DefaultName = null, string? DefaultDisplayName = null)
        where TEntity : NamedEntity
    {
        entity.Entity_Name = entity.GetOverrideOrDefault(key, Overrides.ID, FormatAsName: true, DefaultValue: DefaultName);
        entity.Entity_DisplayName = entity.GetOverrideOrDefault(key, Overrides.Name, FormatAsName: false, DefaultValue: DefaultDisplayName);
        entity.Entity_Enabled = tryGetValue(Overrides.Enabled, key, out bool enabled, DefaultValue: true) ? enabled : true;
    }

    /// <summary>
    /// This calculates the name of an entity, based on a collection of overrides.
    /// </summary>
    /// <remarks>
    /// Suppose you could always do String1 ?? String2 ?? String3 ?? "Default. 
    /// But- this was funner. also- this checks for empty/whitespace strings.
    /// </remarks>
    /// <param name="entity"></param>
    /// <param name="Key"></param>
    /// <param name="Overrides"></param>
    public static string GetOverrideOrDefault<T>(this T entity, string? key, Dictionary<string, string> Overrides, string? DefaultValue = null, bool FormatAsName = false)
        where T : NamedEntity
    {
        string formatIfNeeded(string input) => FormatAsName switch
        {
            true => input.FormatName(),
            false => input
        };

        if (string.IsNullOrEmpty(key))
            throw new NullReferenceException("Key is null");

        if (Overrides.TryGetValue(key, out string overrideValue))
            return formatIfNeeded(overrideValue);

        if (!string.IsNullOrEmpty(DefaultValue))
            return formatIfNeeded(DefaultValue);

        if (entity is EntityWithNameAndLabel entityWithNameAndLabel)
            return formatIfNeeded(entityWithNameAndLabel.Label ?? entityWithNameAndLabel.Name);

        else
            throw new Exception("Unable to determine suitable name.");
    }

    /// <summary>
    /// Multi-type lookup. Does case-insensitive compare for strings.
    /// </summary>
    /// <typeparam name="TKey"></typeparam>
    /// <param name="dictionary"></param>
    /// <param name="key"></param>
    /// <param name="Result"></param>
    /// <returns></returns>
    private static bool tryGetValue<TKey, TValue>(this Dictionary<TKey, TValue> dictionary, TKey? key, out TValue Result, TValue DefaultValue)
        where TKey : notnull
    {
        if (key is null)
        {
            Result = DefaultValue;
            return false;
        }
        if (key is string sKey && dictionary is Dictionary<string, TValue> stringDictionary)
            return caseInsensitiveLookup<TValue>(stringDictionary, sKey, out Result, DefaultValue);

        if (dictionary.ContainsKey(key))
        {
            Result = dictionary[key];
            return true;
        }

        Result = DefaultValue;
        return false;
    }


    private static bool caseInsensitiveLookup<TValue>(this Dictionary<string, TValue> Dictionary, string Key, out TValue Result, TValue DefaultValue)
    {
        var match = Dictionary.Keys.FirstOrDefault(o => string.Equals(o, Key, StringComparison.OrdinalIgnoreCase));
        if (match is null)
        {
            Result = DefaultValue;
            return false;
        }

        Result = Dictionary[match];

        if (Result is null)
            return false;
        if (Result is string s)
            return !string.IsNullOrWhiteSpace(s);
        return Result is not null;
    }

    /// <summary>
    /// Sets all properties of <see cref="IMQTTKey"/>.
    /// </summary>
    /// <remarks>
    /// <see cref="IMQTTKey.Record_Key"/> is set to key from device.
    /// </remarks>
    /// <typeparam name="T"></typeparam>
    /// <param name="Items"></param>
    /// <param name="Parent"></param>
    public static void SetParentAndIdentifier<T>(this Dictionary<string, T> Items, IMQTTKey Parent) where T : BaseEntity
    {
        foreach (var (key, item) in Items)
        {
            item.Record_Parent = Parent;
            item.Record_Key = key;
            item.Entity_Identifier = Parent.CreateChildIdentifier(key);
        }
    }

}