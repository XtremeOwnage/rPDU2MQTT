namespace rPDU2MQTT.Models.Config;

/// <summary>
/// Marks a setting that only applies when a sibling setting has one of the given values — the Prometheus
/// URL under History, which means nothing when the provider is EmonCMS.
///
/// <para>
/// The form hides it the rest of the time. Declared on the model rather than decided in the form, because
/// the form has no way to know which settings belong to which provider, and a hardcoded list there would
/// drift the moment a provider gained a setting.
/// </para>
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
