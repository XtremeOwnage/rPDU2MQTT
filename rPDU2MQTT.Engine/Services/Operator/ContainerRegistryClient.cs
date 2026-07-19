using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json.Serialization;

namespace rPDU2MQTT.Services.Operator;

/// <summary>
/// Minimal OCI/Docker Registry v2 client for the operator's update check (#210). Lists tags for a public
/// repository, performing the anonymous token dance a registry asks for on the first 401 and following
/// tag-list pagination. Read-only — it never pulls image layers, only the tag catalogue.
/// </summary>
public sealed class ContainerRegistryClient : IContainerRegistry
{
    // One shared client: registry hosts are few and long-lived, so pooling connections is correct here.
    private static readonly HttpClient Http = new() { Timeout = TimeSpan.FromSeconds(20) };

    public async Task<IReadOnlyList<string>> ListTagsAsync(string registryHost, string repository, CancellationToken ct)
    {
        var tags = new List<string>();
        string? token = null;
        // The catalogue can paginate; the registry returns a Link header with rel="next".
        var next = $"https://{registryHost}/v2/{repository}/tags/list?n=200";

        while (next is not null)
        {
            using var response = await SendAsync(next, token, ct);

            // First request is unauthenticated; a public registry answers 401 with the token realm to use.
            if (response.StatusCode == HttpStatusCode.Unauthorized && token is null)
            {
                token = await AcquireTokenAsync(response, repository, ct);
                if (token is null) response.EnsureSuccessStatusCode(); // no realm offered -> surface the 401
                using var retried = await SendAsync(next, token, ct);
                retried.EnsureSuccessStatusCode();
                next = await ReadPageAsync(retried, tags, ct);
                continue;
            }

            response.EnsureSuccessStatusCode();
            next = await ReadPageAsync(response, tags, ct);
        }

        return tags;
    }

    private static Task<HttpResponseMessage> SendAsync(string url, string? token, CancellationToken ct)
    {
        var request = new HttpRequestMessage(HttpMethod.Get, url);
        request.Headers.Accept.ParseAdd("application/json");
        if (token is not null)
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        return Http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, ct);
    }

    private static async Task<string?> ReadPageAsync(HttpResponseMessage response, List<string> tags, CancellationToken ct)
    {
        var page = await response.Content.ReadFromJsonAsync<TagList>(ct);
        if (page?.Tags is { } t) tags.AddRange(t);

        // Follow pagination: Link: <.../tags/list?...&last=...>; rel="next"
        if (response.Headers.TryGetValues("Link", out var links))
        {
            foreach (var link in links)
            {
                if (!link.Contains("rel=\"next\"", StringComparison.OrdinalIgnoreCase)) continue;
                var start = link.IndexOf('<');
                var end = link.IndexOf('>');
                if (start >= 0 && end > start)
                {
                    var rel = link[(start + 1)..end];
                    var host = response.RequestMessage?.RequestUri is { } u ? $"{u.Scheme}://{u.Authority}" : "";
                    return rel.StartsWith("http", StringComparison.OrdinalIgnoreCase) ? rel : host + rel;
                }
            }
        }
        return null;
    }

    /// <summary>Parse the <c>WWW-Authenticate: Bearer realm=…,service=…</c> challenge and fetch a pull token.</summary>
    private static async Task<string?> AcquireTokenAsync(HttpResponseMessage challenge, string repository, CancellationToken ct)
    {
        var bearer = challenge.Headers.WwwAuthenticate.FirstOrDefault(h => h.Scheme.Equals("Bearer", StringComparison.OrdinalIgnoreCase));
        if (bearer?.Parameter is null) return null;

        var parms = ParseChallenge(bearer.Parameter);
        if (!parms.TryGetValue("realm", out var realm)) return null;

        var query = new List<string>();
        if (parms.TryGetValue("service", out var service)) query.Add($"service={Uri.EscapeDataString(service)}");
        query.Add($"scope={Uri.EscapeDataString(parms.GetValueOrDefault("scope", $"repository:{repository}:pull"))}");
        var tokenUrl = $"{realm}?{string.Join('&', query)}";

        using var response = await Http.GetAsync(tokenUrl, ct);
        response.EnsureSuccessStatusCode();
        var tok = await response.Content.ReadFromJsonAsync<TokenResponse>(ct);
        return tok?.Token ?? tok?.AccessToken;
    }

    private static Dictionary<string, string> ParseChallenge(string parameter)
    {
        var result = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var part in parameter.Split(','))
        {
            var eq = part.IndexOf('=');
            if (eq <= 0) continue;
            var key = part[..eq].Trim();
            var value = part[(eq + 1)..].Trim().Trim('"');
            result[key] = value;
        }
        return result;
    }

    private sealed class TagList
    {
        [JsonPropertyName("tags")] public List<string>? Tags { get; set; }
    }

    private sealed class TokenResponse
    {
        [JsonPropertyName("token")] public string? Token { get; set; }
        [JsonPropertyName("access_token")] public string? AccessToken { get; set; }
    }
}
