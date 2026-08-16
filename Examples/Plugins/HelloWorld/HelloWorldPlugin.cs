using System.ComponentModel;
using rPDU2MQTT.Classes;
using rPDU2MQTT.Core.Integrations;

namespace rPDU2MQTT.Plugin.HelloWorld;

/// <summary>
/// A complete, working plugin, kept deliberately small so it reads as a template.
///
/// It writes every reading and every energy-flow tier to a file each pass. That is a real destination —
/// it is what a CSV exporter or a "post to my own API" plugin would look like — while being something you
/// can verify with `cat`.
/// </summary>
public sealed class HelloWorldPlugin : IIntegration, IMeasurementDestination, IConfigurablePlugin, IIntegrationApi, IValueSourcePlugin
{
    private HelloWorldSettings settings = new();

    // --- Identity -------------------------------------------------------------------------------------

    public string Id => "helloworld";
    public string DisplayName => "Hello World";
    public IntegrationGroup Group => IntegrationGroup.Destinations;

    public bool Enabled(Config cfg) => settings.Enabled;

    public string? Misconfigured(Config cfg)
        => settings.Enabled && string.IsNullOrWhiteSpace(settings.Path)
            ? "Hello World is enabled but no output path is set."
            : null;

    // --- Its own settings, rendered by the GUI with no UI code here ------------------------------------

    public Type ConfigType => typeof(HelloWorldSettings);
    public void ApplyConfig(object s) => settings = (HelloWorldSettings)s;

    // --- What it does with a pass ---------------------------------------------------------------------

    public async Task SendAsync(ExportPass pass, CancellationToken ct)
    {
        var lines = new List<string> { $"# {pass.AtUtc:u}" };
        foreach (var r in pass.Readings)
            lines.Add($"{r.NodeId}\t{r.Type}\t{r.Value}{r.Units}");
        foreach (var t in pass.TiersFor(null))
            lines.Add($"{t.Node.Id}\t{t.Metric}\t{t.Value}{t.Units}\t(tier)");

        await File.WriteAllLinesAsync(settings.Path, lines, ct);
    }

    // --- Also a value source: nodes can bind to it, and its values roll up like any other -------------
    // A binding looks like: { Type: helloworld, Metric: realpower, Settings: { Watts: "1234" } }

    public string SourceType => "helloworld";
    public string SourceTypeLabel => "Hello World (fixed value)";

    private readonly Dictionary<string, double> values = new(StringComparer.OrdinalIgnoreCase);

    public Task ReconcileAsync(Config cfg, IReadOnlyList<SourceBinding> bindings, CancellationToken ct)
    {
        values.Clear();
        foreach (var b in bindings)
            values[b.NodeId + "|" + b.Key()] = b.Int("Watts");
        return Task.CompletedTask;
    }

    public bool TryGetValue(string nodeId, string metric, out double value)
        => values.TryGetValue(nodeId + "|" + metric, out value);

    // --- An action of its own, reachable at /api/integrations/helloworld/peek ---------------------------

    public IReadOnlyList<IntegrationAction> Actions =>
    [
        new("peek", "Show the last file", "Read back what was written on the most recent pass.",
            ActionEffect.Read,
            async (ctx, ct) => File.Exists(settings.Path)
                ? new { ok = true, lines = await File.ReadAllLinesAsync(settings.Path, ct) }
                : new { ok = false, lines = Array.Empty<string>() }),
    ];
}

/// <summary>Ordinary properties with ordinary attributes; the GUI renders a form from these.</summary>
public sealed class HelloWorldSettings
{
    [DefaultValue(false)]
    [Description("Write every reading and energy-flow tier to a file on each poll.")]
    public bool Enabled { get; set; }

    [DefaultValue("/tmp/rpdu2mqtt-helloworld.txt")]
    [Description("Where to write the file. It is replaced on every pass, not appended to.")]
    public string Path { get; set; } = "/tmp/rpdu2mqtt-helloworld.txt";
}
