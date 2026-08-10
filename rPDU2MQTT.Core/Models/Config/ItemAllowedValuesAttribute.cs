namespace rPDU2MQTT.Models.Config;

/// <summary>
/// The values the <i>items</i> of a list or dictionary may take — <c>[AllowedValues]</c> for a collection.
///
/// </summary>
[AttributeUsage(AttributeTargets.Property)]
public sealed class ItemAllowedValuesAttribute : Attribute
{
    public ItemAllowedValuesAttribute(params string[] values) => Values = values;

    public string[] Values { get; }
}

/// <summary>
/// The items of this collection are metric names, whichever ones this build understands.
///
/// </summary>
[AttributeUsage(AttributeTargets.Property)]
public sealed class MetricItemChoicesAttribute : Attribute
{
}
