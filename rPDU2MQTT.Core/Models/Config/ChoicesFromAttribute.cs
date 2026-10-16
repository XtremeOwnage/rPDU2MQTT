namespace rPDU2MQTT.Models.Config;

/// <summary>Field choices as [value, label] pairs from an API path.</summary>
[AttributeUsage(AttributeTargets.Property)]
public sealed class ChoicesFromAttribute : Attribute
{
    public string Path { get; }

    public ChoicesFromAttribute(string path) => Path = path;
}
