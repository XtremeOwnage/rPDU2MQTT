namespace rPDU2MQTT.Models.Config;

/// <summary>
/// The values the <i>items</i> of a list or dictionary may take — <c>[AllowedValues]</c> for a collection.
///
/// <para>
/// A list's element and a dictionary's value have no property of their own to annotate, so a field whose
/// answers are a known, closed set still rendered as free text: the Prometheus label list and the MQTT
/// import profile's measure→metric map were both typed by hand, with a typo producing a label nobody
/// exports or a metric nothing rolls up, silently and only at runtime.
/// </para>
/// <para>
/// The set is a constraint on what the software understands, so it is declared on the model rather than in
/// the form. What the form does with it — a dropdown — is the form's business.
/// </para>
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
/// <para>
/// Marked rather than listed because the authority is <c>FlowUnits</c>'s table: a metric added there must
/// be offered here, and a name offered here that the table does not know is one nothing will ever roll up.
/// An attribute cannot reference that table directly (its argument would have to be a compile-time
/// constant), so the schema fills the choices in — the same arrangement as the time-zone list.
/// </para>
/// </summary>
[AttributeUsage(AttributeTargets.Property)]
public sealed class MetricItemChoicesAttribute : Attribute
{
}
