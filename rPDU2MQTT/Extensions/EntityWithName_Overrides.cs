using rPDU2MQTT.Helpers;
using rPDU2MQTT.Models.PDU.basePDU;
using rPDU2MQTT.Models.PDU.DummyDevices;

namespace rPDU2MQTT.Extensions;

public static class EntityWithName_Overrides
{
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
    public static string GetOverrideOrDefault<T, Key>(this T entity, Key? key, Dictionary<Key, string> Overrides, string Default = null, bool FormatName = false)
        where Key : notnull
        where T : NamedEntity
    {
        string formatIfNeeded(string input) => FormatName switch
        {
            true => input.FormatName(),
            false => input
        };

        if (tryGetValue(Overrides, key, out string val))
            return formatIfNeeded(val);

        if (Default is not null)
            return formatIfNeeded(Default);

        if (entity is EntityWithNameAndLabel entityWithNameAndLabel)
            return formatIfNeeded(entityWithNameAndLabel.Label ?? entityWithNameAndLabel.Name);

        else
            throw new Exception("Unable to determine suitable name.");
    }

    /// <summary>
    /// Multi-type lookup. Does case-insensitive compare for strings.
    /// </summary>
    /// <typeparam name="T"></typeparam>
    /// <param name="dictionary"></param>
    /// <param name="key"></param>
    /// <param name="Result"></param>
    /// <returns></returns>
    private static bool tryGetValue<T>(this Dictionary<T, string> dictionary, T? key, out string Result)
        where T : notnull
    {
        if (key is null)
        {
            Result = string.Empty;
            return false;
        }
        if (key is string sKey && dictionary is Dictionary<string, string> stringDictionary)
            return tryGetStringValue(stringDictionary, sKey, out Result);

        if (dictionary.ContainsKey(key))
        {
            Result = dictionary[key];
            return true;
        }

        Result = string.Empty;
        return false;
    }


    private static bool tryGetStringValue(this Dictionary<string, string> Dictionary, string Key, out string Result)
    {
        var match = Dictionary.Keys.FirstOrDefault(o => string.Equals(o, Key, StringComparison.OrdinalIgnoreCase));
        if (match is null)
        {
            Result = string.Empty;
            return false;
        }

        Result = Dictionary[match];
        return !string.IsNullOrWhiteSpace(Result);
    }

}