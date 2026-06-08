using rPDU2MQTT.Models.Config;
using rPDU2MQTT.Models.PDUResponse;
using System.Diagnostics.CodeAnalysis;
using System.Net.Http.Json;
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
        var response = await PostJsonWithRetryAsync(path, body, cancellationToken);
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
    /// Matches the PDU web UI: POST /api/auth/{username} with the plaintext password, wrapped as
    /// {"token":"","cmd":"login","data":{"password":...}}. retCode 1001 = NOT_AUTHORIZED (user
    /// invalid/disabled/no permission); 1004 = invalid password.
    /// </remarks>
    private async Task<string> GetTokenAsync(CancellationToken cancellationToken)
    {
        if (!string.IsNullOrEmpty(authToken))
            return authToken;

        var creds = config.PDU.Credentials;
        if (string.IsNullOrEmpty(creds?.Username) || string.IsNullOrEmpty(creds?.Password))
            throw new Exception("PDU username and password are required for write-actions (PDU.ActionsEnabled).");

        var body = new { token = "", cmd = "login", data = new { password = creds.Password } };

        var response = await PostJsonWithRetryAsync($"/api/auth/{Uri.EscapeDataString(creds.Username)}", body, cancellationToken);
        var result = await response.Content.ReadFromJsonAsync<GetResponse<AuthData>>(cancellationToken);

        if (!response.IsSuccessStatusCode || result is null || result.RetCode != 0 || string.IsNullOrEmpty(result.Data?.Token))
            throw new Exception($"[PduApiHandler] PDU login failed (HTTP {(int)response.StatusCode}, retCode {result?.RetCode} {result?.RetMsg}).");

        authToken = result.Data.Token;
        return authToken;
    }

    /// <summary>
    /// POST JSON, retrying once on a transport error. The PDU's embedded HTTP server drops idle
    /// keep-alive connections, and HttpClient does not auto-retry POSTs, so a pooled-but-dead
    /// connection surfaces as "connection forcibly closed". A retry uses a fresh connection.
    /// </summary>
    private async Task<HttpResponseMessage> PostJsonWithRetryAsync<TBody>(string path, TBody body, CancellationToken cancellationToken)
    {
        // Serialize to a string and send as StringContent so the request carries a Content-Length.
        // The PDU's embedded HTTP server rejects chunked request bodies (which JsonContent uses,
        // since it streams without a known length) and resets the connection. Also force HTTP/1.1
        // and disable Expect: 100-continue for the same reason.
        var json = JsonSerializer.Serialize(body);

        const int maxAttempts = 2;
        for (int attempt = 1; ; attempt++)
        {
            using var request = new HttpRequestMessage(HttpMethod.Post, path)
            {
                Content = new StringContent(json, Encoding.UTF8, "application/json"),
                Version = System.Net.HttpVersion.Version11,
                VersionPolicy = HttpVersionPolicy.RequestVersionOrLower,
            };
            request.Headers.ExpectContinue = false;

            try
            {
                return await http.SendAsync(request, cancellationToken);
            }
            catch (HttpRequestException ex) when (attempt < maxAttempts)
            {
                Log.Debug($"[PduApiHandler] POST {path} transport error ({ex.Message}); retrying on a fresh connection.");
            }
        }
    }

    private sealed class AuthData
    {
        [System.Text.Json.Serialization.JsonPropertyName("token")]
        public string? Token { get; set; }
    }
}
