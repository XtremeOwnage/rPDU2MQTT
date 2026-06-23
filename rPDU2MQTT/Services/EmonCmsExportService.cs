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

    public EmonCmsExportService(MQTTServiceDependencies deps, EmonCmsStatus status) : base(deps, deps.Cfg.PDU.PollInterval)
    {
        config = deps.Cfg;
        c = deps.Cfg.EmonCMS;
        this.status = status;
        postUrl = (c.Url ?? string.Empty).TrimEnd('/') + "/" + (c.Path ?? "input/post").TrimStart('/');
    }

    protected override async Task Execute(CancellationToken cancellationToken)
    {
        var data = LatestFreshData();
        if (data is null)
            return;

        var values = new Dictionary<string, double>();
        foreach (var r in MetricsHelper.EnumerateReadings(data))
            values[MetricsHelper.EmonCmsInputName(r, config)] = r.Value;

        if (values.Count == 0)
            return;

        try
        {
            if (c.Transport == EmonCmsTransport.Mqtt)
                await SendViaMqtt(values, cancellationToken);
            else
                await SendViaHttp(values, cancellationToken);

            status.RecordSuccess(values.Count);
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

    private Task SendViaMqtt(Dictionary<string, double> values, CancellationToken cancellationToken)
    {
        // EmonCMS's MQTT input parses a JSON payload on <baseTopic>/<node>.
        var topic = $"{(c.MqttBaseTopic ?? "emon").TrimEnd('/')}/{c.Node}";
        return PublishString(topic, JsonSerializer.Serialize(values), cancellationToken);
    }
}
