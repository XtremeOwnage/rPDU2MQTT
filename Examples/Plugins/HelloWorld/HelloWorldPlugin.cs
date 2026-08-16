using System.ComponentModel;
using rPDU2MQTT.Classes;
using rPDU2MQTT.Core.Integrations;
using rPDU2MQTT.Models.PDU;

namespace rPDU2MQTT.Plugin.HelloWorld;

/// <summary>
/// A complete, working plugin, kept deliberately small so it reads as a template.
///
/// It writes every reading and every energy-flow tier to a file each pass. That is a real destination —
/// it is what a CSV exporter or a "post to my own API" plugin would look like — while being something you
/// can verify with `cat`.
/// </summary>
public sealed class HelloWorldPlugin : IIntegration, IMeasurementDestination, IConfigurablePlugin, IIntegrationApi, IValueSourcePlugin, IDeviceSourcePlugin, IDeviceControlPlugin
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

    // --- Also a device: two outlets, polled by the host and switchable ---------------------------------
    // Everything downstream — MQTT publishing, HA discovery, the flow graph, every destination — treats
    // this exactly like a real PDU, because none of them asks what kind of device produced a reading.

    private readonly Dictionary<int, string> outletState = new() { [0] = "on", [1] = "on" };

    public string InstanceId => "helloworld";

    public Task<PduData?> PollAsync(Config cfg, CancellationToken ct)
    {
        if (!settings.Device) return Task.FromResult<PduData?>(null);

        var device = new Device { Key = "hw", Entity_Name = "hello_device", Entity_DisplayName = "Hello Device" };
        foreach (var (key, state) in outletState)
        {
            var outlet = new Outlet
            {
                Key = key,
                Entity_Name = $"outlet{key}",
                Entity_DisplayName = $"Hello Outlet {key + 1}",
                State = state,
            };
            outlet.Measurements.Add(new Measurement
            {
                Type = "realpower",
                Value = (state == "on" ? settings.Watts : 0).ToString(),
                Units = "W",
            });
            device.Outlets.Add(outlet);
        }

        var data = new PduData();
        data.Devices.Add(device);
        return Task.FromResult<PduData?>(data);
    }

    public bool Supports(string action) => action is "on" or "off";

    public Task<string> ControlOutletAsync(Config cfg, string deviceId, int outletIndex, string action, CancellationToken ct)
    {
        if (!outletState.ContainsKey(outletIndex)) return Task.FromResult($"no outlet {outletIndex}");
        outletState[outletIndex] = action;
        // Report what actually happened, not what was asked: an echo that contradicts the next poll makes
        // an outlet appear to flip back on its own.
        return Task.FromResult(action);
    }

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

    [DefaultValue(false)]
    [Description("Also present two fake outlets as a device, to see what a hardware plugin looks like.")]
    public bool Device { get; set; }

    [DefaultValue(42)]
    [Description("Watts each fake outlet reports while it is on.")]
    public int Watts { get; set; } = 42;

    [DefaultValue("/tmp/rpdu2mqtt-helloworld.txt")]
    [Description("Where to write the file. It is replaced on every pass, not appended to.")]
    public string Path { get; set; } = "/tmp/rpdu2mqtt-helloworld.txt";
}
