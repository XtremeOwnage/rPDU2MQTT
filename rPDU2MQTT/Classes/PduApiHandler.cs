using rPDU2MQTT.Models.Config;
using rPDU2MQTT.Models.PDUResponse;
using System.Diagnostics.CodeAnalysis;
using System.Net.Http.Json;
using System.Text.Json;

namespace rPDU2MQTT.Classes;

/// <summary>
/// This class handles requests to, and from the rPDU API.
/// </summary>
public class PduApiHandler
{
    private readonly HttpClient http;
    private readonly Config config;
    private string? authToken;

    public PduApiHandler([DisallowNull, NotNull] HttpClient http, Config config)
    {
        this.http = http ?? throw new NullReferenceException("HttpClient in constructor was null");
        this.config = config;
    }

    public string BaseAddress => http.BaseAddress?.ToString() ?? string.Empty;

    public async Task<T> GetAsync<T>(string Path, CancellationToken cancellationToken)
    {
        try
        {
            Log.Debug($"[PduApiHandler] Querying {Path}");
            var result = await http.GetFromJsonAsync<GetResponse<T>>(Path, options: Models.PDU.Converter.Settings, cancellationToken);

            if (result is null)
                throw new Exception($"[PduApiHandler] Received a null/empty response from {Path}");

            Log.Debug($"[PduApiHandler] Response Code: {result.RetCode}");
            return result.Data;
        }
        catch (JsonException jex)
        {
            Log.Error($"[PduApiHandler] Json Error Occured: {jex.ToString()}");
            throw;
        }
    }

    /// <summary>
    /// Turn an outlet on or off.
    /// </summary>
    /// <remarks>
    /// IMPORTANT: the control endpoint/payload below is based on the Geist/Vertiv API spec and
    /// has NOT been verified against live hardware. Verify the path, payload, and auth flow for
    /// your firmware before relying on it. Only invoked when PDU.ActionsEnabled is true.
    /// </remarks>
    public async Task SetOutletStateAsync(string deviceId, int outletIndex, bool on, CancellationToken cancellationToken)
    {
        var token = await GetTokenAsync(cancellationToken);
        var action = on ? "on" : "off";

        // The control resource follows the same /api/dev/{device}/outlet/{index} shape as the read API.
        var path = $"/api/dev/{deviceId}/outlet/{outletIndex}";
        var body = new
        {
            cmd = "control",
            token,
            data = new { action, delay = false },
        };

        Log.Information($"[PduApiHandler] Setting outlet {deviceId}/{outletIndex} -> {action}");
        var response = await http.PostAsJsonAsync(path, body, cancellationToken);

        if (!response.IsSuccessStatusCode)
        {
            // A stale token is the most likely failure; drop it so the next call re-authenticates.
            authToken = null;
            var content = await response.Content.ReadAsStringAsync(cancellationToken);
            throw new Exception($"[PduApiHandler] Outlet control failed ({(int)response.StatusCode}): {content}");
        }
    }

    /// <summary>
    /// Authenticate (if needed) and return a control token, caching it for reuse.
    /// </summary>
    private async Task<string> GetTokenAsync(CancellationToken cancellationToken)
    {
        if (!string.IsNullOrEmpty(authToken))
            return authToken;

        var creds = config.PDU.Credentials
            ?? throw new Exception("PDU credentials are required for write-actions (PDU.ActionsEnabled).");

        var body = new { cmd = "login", data = new { username = creds.Username, password = creds.Password } };
        var response = await http.PostAsJsonAsync("/api/auth", body, cancellationToken);
        response.EnsureSuccessStatusCode();

        var result = await response.Content.ReadFromJsonAsync<GetResponse<AuthData>>(cancellationToken);
        authToken = result?.Data?.Token
            ?? throw new Exception("[PduApiHandler] Authentication did not return a token.");

        return authToken;
    }

    private sealed class AuthData
    {
        [System.Text.Json.Serialization.JsonPropertyName("token")]
        public string? Token { get; set; }
    }
}
