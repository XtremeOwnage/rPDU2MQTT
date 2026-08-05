namespace rPDU2MQTT.Models.Config;

/// <summary>
/// Marks the one setting that turns a whole capability on or off.
///
/// <para>
/// These used to be scattered — one switch per config page, so answering "what is this bridge actually
/// doing?" meant opening every page and reading every form. The GUI gathers them onto a single Features
/// page instead, and removes them from the individual pages so a capability has exactly one switch.
/// </para>
/// <para>
/// Marked here rather than inferred from the property name, because the names genuinely differ:
/// <c>Gui.Enabled</c>, but <c>HomeAssistant.DiscoveryEnabled</c> and <c>Prometheus.Exporter</c>. A rule of
/// "the boolean called Enabled" would have silently dropped the last two off the page, and a feature you
/// cannot see is worse than one you have to hunt for. The server decides, so the form keeps no list.
/// </para>
/// </summary>
[AttributeUsage(AttributeTargets.Property)]
public sealed class FeatureToggleAttribute : Attribute
{
}
