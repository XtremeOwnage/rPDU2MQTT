namespace rPDU2MQTT.Services.Gui;

/// <summary>
/// The config sections externally loaded plugins contribute to the schema, resolved once at startup.
/// </summary>
/// <remarks>
/// A type of its own rather than a raw list so it can be injected without ambiguity, and so the GUI's
/// schema endpoint does not have to know how plugins are discovered.
/// </remarks>
public sealed class PluginSchemaSections
{
    public PluginSchemaSections(IReadOnlyList<(string Id, string Label, Type ConfigType)> sections)
        => Sections = sections;

    public IReadOnlyList<(string Id, string Label, Type ConfigType)> Sections { get; }
}
