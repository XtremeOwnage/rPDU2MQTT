namespace rPDU2MQTT.Models.Config;

/// <summary>
/// Declares the placeholder variables a templated string field supports (e.g. <c>{type}</c>), so the
/// GUI can list them as click-to-insert / draggable chips under the input.
/// </summary>
[AttributeUsage(AttributeTargets.Property)]
public sealed class TemplateVariablesAttribute : Attribute
{
    public string[] Names { get; }

    public TemplateVariablesAttribute(params string[] names) => Names = names;
}
