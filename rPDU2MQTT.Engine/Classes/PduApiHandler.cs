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
    private readonly PduConfig instanceConfig;
    // Session token per host web port (OneView cluster members are reached via the master's proxy port).
    private readonly Dictionary<long, string> tokensByPort = new();
    // deviceId -> owning host web port (0 = the directly-connected/base host).
    private Dictionary<string, long>? deviceWebPorts;

    public PduApiHandler([DisallowNull, NotNull] HttpClient http, PduConfig instanceConfig)
    {
        this.http = http ?? throw new NullReferenceException("HttpClient in constructor was null");
        this.instanceConfig = instanceConfig;
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

    /// <summary>Turn an outlet on or off.</summary>
    public Task SetOutletStateAsync(string deviceId, int outletIndex, bool on, CancellationToken cancellationToken)
        => ControlOutletAsync(deviceId, outletIndex, on ? "on" : "off", cancellationToken);

    /// <summary>
    /// Issue a control action ("on", "off", "reboot") against an outlet.
    /// </summary>
    /// <remarks>
    /// Endpoint/auth match the Geist firmware (apiVersion 1.0.1): control is a POST to the
    /// outlet resource with the session token in the body. Only invoked when ActionsEnabled.
    /// </remarks>
    public Task ControlOutletAsync(string deviceId, int outletIndex, string action, CancellationToken cancellationToken)
        => SendCommandAsync(deviceId, $"/outlet/{outletIndex}", "control", new { action, delay = false }, $"outlet {outletIndex} control '{action}'", cancellationToken);

    /// <summary>
    /// Write outlet configuration fields (e.g. onDelay/offDelay/rebootDelay/poaAction) via cmd "set".
    /// </summary>
    public Task SetOutletConfigAsync(string deviceId, int outletIndex, IReadOnlyDictionary<string, object> fields, CancellationToken cancellationToken)
        => SendCommandAsync(deviceId, $"/outlet/{outletIndex}", "set", fields, $"outlet {outletIndex} set {string.Join(",", fields.Keys)}", cancellationToken);

    /// <summary>
    /// Reset an outlet's accumulated energy statistics (cmd "reset", target "energy").
    /// </summary>
    public Task ResetOutletStatsAsync(string deviceId, int outletIndex, CancellationToken cancellationToken)
        => SendCommandAsync(deviceId, $"/outlet/{outletIndex}", "reset", new { target = "energy" }, $"outlet {outletIndex} reset statistics", cancellationToken);

    /// <summary>Write device (PDU) configuration fields (e.g. <c>label</c>) via cmd "set".</summary>
    public Task SetDeviceConfigAsync(string deviceId, IReadOnlyDictionary<string, object> fields, CancellationToken cancellationToken)
        => SendCommandAsync(deviceId, "", "set", fields, $"device set {string.Join(",", fields.Keys)}", cancellationToken);

    /// <summary>Write entity (circuit/breaker, phase, total) configuration fields (e.g. <c>label</c>) via cmd "set".</summary>
    public Task SetEntityConfigAsync(string deviceId, string entityKey, IReadOnlyDictionary<string, object> fields, CancellationToken cancellationToken)
        => SendCommandAsync(deviceId, $"/entity/{entityKey}", "set", fields, $"entity {entityKey} set {string.Join(",", fields.Keys)}", cancellationToken);

    /// <summary>
    /// Write OneView group configuration fields (e.g. <c>label</c>) via cmd "set". Groups are a master
    /// (OneView) concept, reached at <c>/oneview/group/{key}</c> on the base host — not per-member.
    /// </summary>
    public async Task SetGroupConfigAsync(string groupKey, IReadOnlyDictionary<string, object> fields, CancellationToken cancellationToken)
    {
        var token = await GetTokenAsync(0, cancellationToken);
        var url = BuildUrl(0, $"/oneview/group/{groupKey}");
        var body = new { cmd = "set", token, data = fields };

        var description = $"group {groupKey} set {string.Join(",", fields.Keys)}";
        Log.Information($"[PduApiHandler] {description}");
        var response = await PostJsonWithRetryAsync(url, body, cancellationToken);
        var result = await response.Content.ReadFromJsonAsync<GetResponse<JsonElement>>(cancellationToken);

        if (!response.IsSuccessStatusCode || result is null || result.RetCode != 0)
        {
            tokensByPort.Remove(0);
            throw new Exception($"[PduApiHandler] {description} failed (HTTP {(int)response.StatusCode}, retCode {result?.RetCode} {result?.RetMsg}).");
        }
    }

    /// <summary>
    /// POST a command (control/set/reset) to a device resource (or a sub-resource like an outlet or
    /// entity) on the owning host, validating the result.
    /// </summary>
    /// <remarks>
    /// Endpoint/auth match the Geist firmware (apiVersion 1.0.1): the session token travels in the
    /// body, against the same /api/dev/{device}[/{sub}] path as the read API (a proxy port for cluster
    /// members). <paramref name="resourceSuffix"/> is "" for the device itself, "/outlet/{i}" for an
    /// outlet, or "/entity/{key}" for a circuit/phase/total. Only invoked when ActionsEnabled.
    /// </remarks>
    private async Task SendCommandAsync(string deviceId, string resourceSuffix, string cmd, object data, string description, CancellationToken cancellationToken)
    {
        var webPort = await ResolveWebPortAsync(deviceId, cancellationToken);
        var token = await GetTokenAsync(webPort, cancellationToken);

        var url = BuildUrl(webPort, $"/api/dev/{deviceId}{resourceSuffix}");
        var body = new { cmd, token, data };

        Log.Information($"[PduApiHandler] {deviceId}: {description}");
        var response = await PostJsonWithRetryAsync(url, body, cancellationToken);
        var result = await response.Content.ReadFromJsonAsync<GetResponse<JsonElement>>(cancellationToken);

        if (!response.IsSuccessStatusCode || result is null || result.RetCode != 0)
        {
            // A stale token is the most likely failure; drop it so the next call re-authenticates.
            tokensByPort.Remove(webPort);
            throw new Exception($"[PduApiHandler] {description} failed (HTTP {(int)response.StatusCode}, retCode {result?.RetCode} {result?.RetMsg}).");
        }
    }

    /// <summary>
    /// Authenticate (if needed) against the given host port and return a session token, cached per port.
    /// </summary>
    /// <remarks>
    /// Matches the PDU web UI: POST /api/auth/{username} with the plaintext password, wrapped as
    /// {"token":"","cmd":"login","data":{"password":...}}. retCode 1001 = NOT_AUTHORIZED (user
    /// invalid/disabled/no permission); 1004 = invalid password.
    /// </remarks>
    private async Task<string> GetTokenAsync(long webPort, CancellationToken cancellationToken)
    {
        if (tokensByPort.TryGetValue(webPort, out var cached) && !string.IsNullOrEmpty(cached))
            return cached;

        var creds = instanceConfig.Credentials;
        if (string.IsNullOrEmpty(creds?.Username) || string.IsNullOrEmpty(creds?.Password))
            throw new Exception("PDU username and password are required for write-actions (PDU.ActionsEnabled).");

        var body = new { token = "", cmd = "login", data = new { password = creds.Password } };

        var response = await PostJsonWithRetryAsync(BuildUrl(webPort, $"/api/auth/{Uri.EscapeDataString(creds.Username)}"), body, cancellationToken);
        var result = await response.Content.ReadFromJsonAsync<GetResponse<AuthData>>(cancellationToken);

        if (!response.IsSuccessStatusCode || result is null || result.RetCode != 0 || string.IsNullOrEmpty(result.Data?.Token))
            throw new Exception($"[PduApiHandler] PDU login failed (HTTP {(int)response.StatusCode}, retCode {result?.RetCode} {result?.RetMsg}).");

        tokensByPort[webPort] = result.Data.Token;
        return result.Data.Token;
    }

    /// <summary>
    /// Resolve the web port of the host that owns a device. In a OneView cluster, member PDUs are
    /// reached through the master's per-member proxy port; the master itself uses the base port (0).
    /// </summary>
    private async Task<long> ResolveWebPortAsync(string deviceId, CancellationToken cancellationToken)
    {
        if (deviceWebPorts is null || !deviceWebPorts.ContainsKey(deviceId))
            deviceWebPorts = await BuildWebPortMapAsync(cancellationToken);

        return deviceWebPorts.TryGetValue(deviceId, out var port) ? port : 0;
    }

    private async Task<Dictionary<string, long>> BuildWebPortMapAsync(CancellationToken cancellationToken)
    {
        var map = new Dictionary<string, long>(StringComparer.OrdinalIgnoreCase);
        try
        {
            var https = string.Equals(http.BaseAddress?.Scheme, "https", StringComparison.OrdinalIgnoreCase);
            var oneview = await GetAsync<Models.PDU.OneView.OneViewRootData>("/oneview", cancellationToken);
            foreach (var host in oneview.Hosts)
                foreach (var device in host.Cache?.Devices ?? new())
                    if (!string.IsNullOrEmpty(device.Key))
                        map[device.Key] = https ? host.HttpsPort : host.WebPort;
        }
        catch (Exception ex)
        {
            // Not a OneView/cluster deployment (or /oneview unavailable); fall back to the base host.
            Log.Debug($"[PduApiHandler] Could not build device->host map ({ex.Message}); using base host.");
        }
        return map;
    }

    /// <summary>Build a request URL targeting the owning host (a proxy port for cluster members).</summary>
    private string BuildUrl(long webPort, string relativePath)
    {
        if (webPort <= 0 || http.BaseAddress is null)
            return relativePath; // base address (master / single PDU)

        return $"{http.BaseAddress.Scheme}://{http.BaseAddress.Host}:{webPort}{relativePath}";
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
