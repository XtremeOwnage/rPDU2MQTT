namespace rPDU2MQTT.Models.Config;

/// <summary>
/// The choices for a field come from an API path the GUI asks when it draws the field, answered as a list of
/// [value, label] pairs. For choices only the running bridge knows, such as the places a plugin defines. On a
/// list of strings, each choice is a box to tick.
/// </summary>
[AttributeUsage(AttributeTargets.Property)]
public sealed class ChoicesFromAttribute : Attribute
{
    public string Path { get; }

    public ChoicesFromAttribute(string path) => Path = path;
}
