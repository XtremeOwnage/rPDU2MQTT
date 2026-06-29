using rPDU2MQTT.Classes;
using rPDU2MQTT.Helpers;
using rPDU2MQTT.Models.Config;
using rPDU2MQTT.Services.baseTypes;
using System.Text.Json;

namespace rPDU2MQTT.Services;

/// <summary>
/// Pushes PDU measurements to EmonCMS on each poll, via either its HTTP input/post API or by
/// publishing to its MQTT input. Input keys come from <c>EmonCMS.InputNameTemplate</c>. The outcome
/// is recorded in <see cref="EmonCmsStatus"/> for the GUI health indicator. Enabled via config.
/// </summary>
public class EmonCmsExportService : baseMQTTService
{
    private static readonly HttpClient http = new();
    private readonly Config config;
    private readonly EmonCMSConfig c;
    private readonly EmonCmsStatus status;
    private readonly string postUrl;

    public EmonCmsExportService(MQTTServiceDependencies deps, EmonCmsStatus status) : base(deps, deps.Cfg.Primary.PollInterval)
    {
        config = deps.Cfg;
        c = deps.Cfg.EmonCMS;
        this.status = status;
        postUrl = (c.Url ?? string.Empty).TrimEnd('/') + "/" + (c.Path ?? "input/post").TrimStart('/');
    }

    protected override async Task Execute(CancellationToken cancellationToken)
    {
        // Group readings into payloads. Normally one combined payload (input keys are unique per device),
        // but when the MQTT topic template contains {device} (#165) we split per PDU so each goes to its
        // own topic. The HTTP transport always posts one combined payload (the split is a topic concept).
        var splitByDevice = c.Transport == EmonCmsTransport.Mqtt && MetricsHelper.EmonCmsSplitsByDevice(config);
        var payloads = new Dictionary<string, Dictionary<string, double>>();
        foreach (var data in FreshSnapshots())
            foreach (var r in MetricsHelper.EnumerateReadings(data))
            {
                var key = splitByDevice ? r.Device : string.Empty;
                if (!payloads.TryGetValue(key, out var values)) payloads[key] = values = new();
                values[MetricsHelper.EmonCmsInputName(r, config)] = r.Value;
            }

        var total = payloads.Sum(p => p.Value.Count);
        if (total == 0)
            return;

        try
        {
            if (c.Transport == EmonCmsTransport.Mqtt)
                foreach (var (device, values) in payloads)
                    await SendViaMqtt(MetricsHelper.EmonCmsMqttTopic(device, config), values, cancellationToken);
            else
                await SendViaHttp(payloads[string.Empty], cancellationToken);

            status.RecordSuccess(total);
        }
        catch (Exception ex)
        {
            status.RecordFailure(ex.Message);
            Log.Error($"EmonCMS export failed: {ex.Message}");
        }
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
