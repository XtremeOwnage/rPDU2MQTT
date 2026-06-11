using rPDU2MQTT.Classes;
using rPDU2MQTT.Helpers;
using rPDU2MQTT.Services.baseTypes;
using System.Text.Json;

namespace rPDU2MQTT.Services;

/// <summary>
/// Pushes PDU measurements to an EmonCMS server via its input/post API on each poll. EmonCMS
/// auto-creates the inputs from the posted keys. Enabled via config.
/// </summary>
public class EmonCmsExportService : baseMQTTService
{
    private static readonly HttpClient http = new();
    private readonly string postUrl;
    private readonly string node;
    private readonly string apiKey;

    public EmonCmsExportService(MQTTServiceDependencies deps) : base(deps, deps.Cfg.PDU.PollInterval)
    {
        var c = deps.Cfg.EmonCMS;
        postUrl = (c.Url ?? string.Empty).TrimEnd('/') + "/" + (c.Path ?? "input/post").TrimStart('/');
        node = c.Node;
        apiKey = c.ApiKey ?? string.Empty;
    }

    protected override async Task Execute(CancellationToken cancellationToken)
    {
        var data = await pdu.GetRootData_Public(cancellationToken);

        var values = new Dictionary<string, double>();
        foreach (var r in MetricsHelper.EnumerateReadings(data))
            values[r.Identifier] = r.Value;

        if (values.Count == 0)
            return;

        var form = new Dictionary<string, string>
        {
            ["node"] = node,
            ["apikey"] = apiKey,
            ["fulljson"] = JsonSerializer.Serialize(values),
        };

        using var content = new FormUrlEncodedContent(form);
        var response = await http.PostAsync(postUrl, content, cancellationToken);
        if (!response.IsSuccessStatusCode)
        {
            var body = await response.Content.ReadAsStringAsync(cancellationToken);
            Log.Error($"EmonCMS post failed (HTTP {(int)response.StatusCode}): {body}");
        }
    }
}
