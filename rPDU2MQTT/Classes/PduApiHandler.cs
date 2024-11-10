using rPDU2MQTT.Models.PDUResponse;
using System.Diagnostics.CodeAnalysis;
using System.Net.Http.Json;

namespace rPDU2MQTT.Classes;

/// <summary>
/// This class handles requests to, and from the rPDU API.
/// </summary>
public class PduApiHandler
{
    private HttpClient http;

    public PduApiHandler([DisallowNull, NotNull] HttpClient http)
    {
        this.http = http ?? throw new NullReferenceException("HttpClient in constructor was null");
    }

    public string BaseAddress => http.BaseAddress.ToString();

    public async Task<T> GetAsync<T>(string Path, CancellationToken cancellationToken)
    {
        Log.Debug($"[PduApiHandler] Querying {Path}");
        var result = await http.GetFromJsonAsync<GetResponse<T>>("/api/conf/oneview/enabled", options: Models.PDU.Converter.Settings, cancellationToken);
        Log.Debug($"[PduApiHandler] Response Code: {result.RetCode}");
        return result.Data;
    }
}
