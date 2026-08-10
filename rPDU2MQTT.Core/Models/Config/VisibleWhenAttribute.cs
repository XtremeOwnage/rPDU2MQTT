namespace rPDU2MQTT.Models.Config;

/// <summary>
/// Marks a setting that only applies when a sibling setting has one of the given values — the Prometheus
/// URL under History, which means nothing when the provider is EmonCMS.
///
/// </summary>
[AttributeUsage(AttributeTargets.Property)]
public sealed class VisibleWhenAttribute : Attribute
{
    public VisibleWhenAttribute(string key, params string[] values)
    {
        Key = key;
        Values = values;
    }

    /// <summary>The sibling property (its model name) whose value decides.</summary>
    public string Key { get; }

    /// <summary>The values of that sibling this setting applies to.</summary>
    public string[] Values { get; }
}
