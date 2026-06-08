using rPDU2MQTT.Models.Config;
using rPDU2MQTT.Models.PDUResponse;
using System.Diagnostics.CodeAnalysis;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text;
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
    /// Endpoint/auth match the Geist firmware (apiVersion 1.0.1): control is a POST to the
    /// outlet resource with the session token in the body. Only invoked when ActionsEnabled.
    /// </remarks>
    public async Task SetOutletStateAsync(string deviceId, int outletIndex, bool on, CancellationToken cancellationToken)
    {
        var token = await GetTokenAsync(cancellationToken);
        var action = on ? "on" : "off";

        // The control resource is the same /api/dev/{device}/outlet/{index} path as the read API.
        var path = $"/api/dev/{deviceId}/outlet/{outletIndex}";
        var body = new
        {
            cmd = "control",
            token,
            data = new { action, delay = false },
        };

        Log.Information($"[PduApiHandler] Setting outlet {deviceId}/{outletIndex} -> {action}");
        var response = await http.PostAsJsonAsync(path, body, cancellationToken);
        var result = await response.Content.ReadFromJsonAsync<GetResponse<JsonElement>>(cancellationToken);

        if (!response.IsSuccessStatusCode || result is null || result.RetCode != 0)
        {
            // A stale token is the most likely failure; drop it so the next call re-authenticates.
            authToken = null;
            throw new Exception($"[PduApiHandler] Outlet control failed (HTTP {(int)response.StatusCode}, retCode {result?.RetCode} {result?.RetMsg}).");
        }
    }

    /// <summary>
    /// Authenticate (if needed) and return a session token, caching it for reuse.
    /// </summary>
    /// <remarks>
    /// Geist login is a POST to /api/auth/{username} with the SHA-256 hash of the password.
    /// </remarks>
    private async Task<string> GetTokenAsync(CancellationToken cancellationToken)
    {
        if (!string.IsNullOrEmpty(authToken))
            return authToken;

        var creds = config.PDU.Credentials;
        if (string.IsNullOrEmpty(creds?.Username) || string.IsNullOrEmpty(creds?.Password))
            throw new Exception("PDU username and password are required for write-actions (PDU.ActionsEnabled).");

        var hashedPassword = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(creds.Password))).ToLowerInvariant();
        var body = new { cmd = "login", data = new { password = hashedPassword } };

        var response = await http.PostAsJsonAsync($"/api/auth/{Uri.EscapeDataString(creds.Username)}", body, cancellationToken);
        var result = await response.Content.ReadFromJsonAsync<GetResponse<AuthData>>(cancellationToken);

        if (!response.IsSuccessStatusCode || result is null || result.RetCode != 0 || string.IsNullOrEmpty(result.Data?.Token))
            throw new Exception($"[PduApiHandler] PDU login failed (HTTP {(int)response.StatusCode}, retCode {result?.RetCode} {result?.RetMsg}).");

        authToken = result.Data.Token;
        return authToken;
    }

    private sealed class AuthData
    {
        [System.Text.Json.Serialization.JsonPropertyName("token")]
        public string? Token { get; set; }
    }
}
