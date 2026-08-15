using rPDU2MQTT.Classes;
using rPDU2MQTT.Helpers;
using rPDU2MQTT.Models.Config;
using rPDU2MQTT.Services.baseTypes;
using System.Text.Json;

namespace rPDU2MQTT.Services;

/// <summary>
/// Pushes PDU measurements and the energy-flow hierarchy to EmonCMS on each poll, via either its HTTP
/// input/post API or by publishing to its MQTT input. Input keys come from <c>EmonCMS.InputNameTemplate</c>
/// (readings) and <c>EmonCMS.FlowInputNameTemplate</c> (flow nodes). The outcome is recorded in
/// <see cref="EmonCmsStatus"/> for the GUI health indicator. Enabled via config.
/// </summary>
public class EmonCmsExportService : baseMQTTService
{
    private static readonly HttpClient http = new();
    private readonly Config config;
    private readonly EmonCMSConfig c;
    private readonly EmonCmsStatus status;
    private readonly string postUrl;
    private readonly Core.Flow.IFlowValueSource? live;

    public EmonCmsExportService(MQTTServiceDependencies deps, EmonCmsStatus status, Core.Flow.IFlowValueSource? live = null)
        : base(deps, deps.Cfg.Primary.PollInterval)
    {
        config = deps.Cfg;
        c = deps.Cfg.EmonCMS;
        this.status = status;
        this.live = live;
        postUrl = (c.Url ?? string.Empty).TrimEnd('/') + "/" + (c.Path ?? "input/post").TrimStart('/');
    }

    protected override async Task Execute(CancellationToken cancellationToken)
    {
        // Group readings into payloads. Normally one combined payload (input keys are unique per device),
        // but when the MQTT topic template contains {device} (#165) we split per PDU so each goes to its
        // own topic. The HTTP transport always posts one combined payload (the split is a topic concept).
        var splitByDevice = c.Transport == EmonCmsTransport.Mqtt && MetricsHelper.EmonCmsSplitsByDevice(config);
        var payloads = new Dictionary<string, Dictionary<string, double>>();
        var merged = new Models.PDU.PduData();

        foreach (var data in FreshSnapshots())
        {
            merged.Devices.AddRange(data.Devices);
            foreach (var r in MetricsHelper.EnumerateReadings(data))
            {
                var key = splitByDevice ? r.Device : string.Empty;
                if (!payloads.TryGetValue(key, out var values)) payloads[key] = values = new();
                values[MetricsHelper.EmonCmsInputName(r, config)] = r.Value;
            }
        }

        // The hierarchy itself — the panels, inverters, batteries and totals a PDU knows nothing about.
        // They have no device, so they ride in the combined payload whichever way the readings are split.
        foreach (var (name, value) in FlowInputs(merged))
        {
            if (!payloads.TryGetValue(string.Empty, out var values)) payloads[string.Empty] = values = new();
            values[name] = value;
        }

        var total = payloads.Sum(p => p.Value.Count);
        if (total == 0)
            return;

        try
        {
            if (c.Transport == EmonCmsTransport.Mqtt)
                foreach (var (device, values) in payloads)
                    await SendViaMqtt(MetricsHelper.EmonCmsMqttTopic(device, config), values, cancellationToken);
            else if (payloads.TryGetValue(string.Empty, out var combined))
                await SendViaHttp(combined, cancellationToken);

            status.RecordSuccess(total);
        }
        catch (Exception ex)
        {
            status.RecordFailure(ex.Message);
            Log.Error($"EmonCMS export failed: {ex.Message}");
        }
    }

    /// <summary>
    /// Every energy-flow tier's input key and value, for each exported metric (power, energy, today).
    /// </summary>
    private IEnumerable<(string Name, double Value)> FlowInputs(Models.PDU.PduData merged)
    {
        if (!c.ExportFlowNodes || !Core.Flow.FlowTiers.Any(merged, config)) yield break;

        List<(string, double)> found;
        try
        {
            found = Core.Flow.FlowTiers.Graphs(merged, config, live)
                .SelectMany(g => Core.Flow.FlowTiers.Of(g.Graph, c.NodeTags))
                .Select(t => (MetricsHelper.EmonCmsFlowInputName(t.Node.Id, t.Node.Label, t.Node.Kind, t.Metric, config), t.Value))
                .ToList();
        }
        catch (Exception ex)
        {
            // A hierarchy that cannot be built is worth saying out loud: the PDU readings still go, and the
            // silence about everything else is exactly what made this hard to notice.
            Log.Warning($"EmonCMS: could not build the energy-flow hierarchy this pass, so only the PDU readings were sent ({ex.Message}).");
            yield break;
        }

        foreach (var f in found) yield return f;
    }

    private async Task SendViaHttp(Dictionary<string, double> values, CancellationToken cancellationToken)
    {
        var form = new Dictionary<string, string>
        {
            ["node"] = c.Node,
            ["apikey"] = c.ApiKey ?? string.Empty,
            ["fulljson"] = JsonSerializer.Serialize(values),
        };

        using var content = new FormUrlEncodedContent(form);
        var response = await http.PostAsync(postUrl, content, cancellationToken);
        var body = await response.Content.ReadAsStringAsync(cancellationToken);

        if (!response.IsSuccessStatusCode)
            throw new Exception($"HTTP {(int)response.StatusCode}: {body}");
        // EmonCMS answers 200 even on auth/permission failures, flagged in the JSON body.
        if (body.Contains("\"success\":false", StringComparison.OrdinalIgnoreCase))
            throw new Exception($"EmonCMS rejected the post: {body}");
    }

    private Task SendViaMqtt(string topic, Dictionary<string, double> values, CancellationToken cancellationToken)
        // EmonCMS's MQTT input parses a JSON payload on the rendered topic (see MqttTopicTemplate).
        => PublishString(topic, JsonSerializer.Serialize(values), cancellationToken);
}
