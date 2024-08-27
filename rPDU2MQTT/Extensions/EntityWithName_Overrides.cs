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
    public static string GetOverrideOrDefault<T>(this T entity, string key, Dictionary<int, string> Overrides, string Default = null, bool FormatName = false)
        where T : NamedEntity
    {
        string formatIfNeeded(string input) => FormatName switch
        {
            true => input.FormatName(),
            false => input
        };

        if (int.TryParse(key, out int num) && Overrides.ContainsKey(num + 1))
        {
            var value = Overrides[num + 1];
            return formatIfNeeded(value);
        }

        if (Default is not null)
            return formatIfNeeded(Default);

        if (entity is EntityWithNameAndLabel entityWithNameAndLabel)
            return formatIfNeeded(entityWithNameAndLabel.Label ?? entityWithNameAndLabel.Name);

        else
            throw new Exception("Unable to determine suitable name.");
    }
}