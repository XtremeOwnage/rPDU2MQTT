namespace rPDU2MQTT.Models.Config;

/// <summary>
/// The values the <i>items</i> of a list or dictionary may take — <c>[AllowedValues]</c> for a collection.
/// </summary>
[AttributeUsage(AttributeTargets.Property)]
public sealed class ItemAllowedValuesAttribute : Attribute
{
    public ItemAllowedValuesAttribute(params string[] values) => Values = values;

    public string[] Values { get; }
}

/// <summary>
/// The items of this collection are metric names, whichever ones this build understands.
/// </summary>
[AttributeUsage(AttributeTargets.Property)]
public sealed class MetricItemChoicesAttribute : Attribute
{
}

/// <summary>
/// The items of this collection are energy-flow tag names, so the GUI offers the tags the configuration
/// already defines rather than a free-text box per entry.
///
/// <para>
/// Not an <c>[AllowedValues]</c> and deliberately not a validated set: the vocabulary is whatever the
/// operator invented, it lives in the same document, and the server has no say in it. This only marks the
/// field as naming tags — a reference to something defined elsewhere, where a typo silently matches nothing.
/// </para>
/// </summary>
[AttributeUsage(AttributeTargets.Property)]
public sealed class TagChoicesAttribute : Attribute
{
}

/// <summary>
/// Which nav group a config section belongs to, declared where the section is.
///
/// <para>
/// The client used to hold this list. Keeping the grouping in two places meant a new section could be
/// registered, rendered and reachable while sitting in the wrong group — or in System, the catch-all —
/// with nothing to say it had been forgotten.
/// </para>
/// </summary>
[AttributeUsage(AttributeTargets.Property)]
public sealed class NavGroupAttribute : Attribute
{
    public NavGroupAttribute(string group) => Group = group;

    public string Group { get; }
}
