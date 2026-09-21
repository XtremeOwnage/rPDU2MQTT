using System.Globalization;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using rPDU2MQTT.Models.Config;

namespace rPDU2MQTT.Core.Plans;

/// <summary>Plan images in an S3-compatible bucket, signed with AWS Signature Version 4 (#462).</summary>
public sealed class S3PlanImageStore(PlanObjectStoreConfig config, HttpClient http) : IPlanImageStore
{
    public string Describe => $"the bucket {config.Bucket} at {config.Endpoint}";

    private Uri UriFor(string id)
    {
        var endpoint = new Uri(config.Endpoint.TrimEnd('/') + "/");
        var key = (config.Prefix ?? "").TrimStart('/') + id;
        if (config.PathStyle) return new Uri(endpoint, $"{config.Bucket}/{key}");
        var b = new UriBuilder(endpoint) { Host = $"{config.Bucket}.{endpoint.Host}", Path = key };
        return b.Uri;
    }

    private async Task<HttpResponseMessage> SendAsync(HttpMethod method, string id, byte[]? body, string? contentType, CancellationToken ct)
    {
        var uri = UriFor(id);
        var request = new HttpRequestMessage(method, uri);
        var payload = body ?? [];
        var headers = new SortedDictionary<string, string>(StringComparer.Ordinal)
        {
            ["host"] = uri.Authority,
            ["x-amz-content-sha256"] = SigV4.Hex(SHA256.HashData(payload)),
            ["x-amz-date"] = DateTime.UtcNow.ToString("yyyyMMdd'T'HHmmss'Z'", CultureInfo.InvariantCulture),
        };
        request.Headers.Authorization = System.Net.Http.Headers.AuthenticationHeaderValue.Parse(
            SigV4.Authorization(method.Method, uri.AbsolutePath, "", headers, headers["x-amz-content-sha256"],
                config.Region, "s3", config.AccessKeyId, config.SecretAccessKey ?? ""));
        request.Headers.TryAddWithoutValidation("x-amz-content-sha256", headers["x-amz-content-sha256"]);
        request.Headers.TryAddWithoutValidation("x-amz-date", headers["x-amz-date"]);
        if (body is not null)
        {
            request.Content = new ByteArrayContent(body);
            if (contentType is not null) request.Content.Headers.ContentType = new(contentType);
        }
        return await http.SendAsync(request, ct);
    }

    public async Task SaveAsync(string id, byte[] bytes, string contentType, CancellationToken ct)
    {
        using var r = await SendAsync(HttpMethod.Put, id, bytes, contentType, ct);
        if (!r.IsSuccessStatusCode)
            throw new PlanImageRejected($"The object store refused the image ({(int)r.StatusCode} {r.ReasonPhrase}): {Trim(await r.Content.ReadAsStringAsync(ct))}");
    }

    public async Task<PlanImage?> ReadAsync(string id, CancellationToken ct)
    {
        try
        {
            using var r = await SendAsync(HttpMethod.Get, id, null, null, ct);
            if (r.StatusCode == HttpStatusCode.NotFound || !r.IsSuccessStatusCode) return null;
            var format = PlanImageFormat.ForId(id);
            return format is null ? null : new PlanImage(await r.Content.ReadAsByteArrayAsync(ct), format.ContentType);
        }
        catch (HttpRequestException) { return null; }
    }

    public async Task DeleteAsync(string id, CancellationToken ct)
    {
        using var r = await SendAsync(HttpMethod.Delete, id, null, null, ct);
    }

    private static string Trim(string s) => s.Length > 300 ? s[..300] + "…" : s;
}

/// <summary>AWS Signature Version 4, header form.</summary>
public static class SigV4
{
    public static string Hex(byte[] b) => Convert.ToHexString(b).ToLowerInvariant();

    private static byte[] Hmac(byte[] key, string data) => HMACSHA256.HashData(key, Encoding.UTF8.GetBytes(data));

    /// <summary>The Authorization header value for a request whose signed headers (lower-case names) are given, x-amz-date among them.</summary>
    public static string Authorization(string method, string path, string query, IReadOnlyDictionary<string, string> headers,
        string payloadHash, string region, string service, string accessKey, string secretKey)
    {
        var amzDate = headers["x-amz-date"];
        var date = amzDate[..8];
        var names = headers.Keys.Select(k => k.ToLowerInvariant()).OrderBy(k => k, StringComparer.Ordinal).ToList();
        var canonicalHeaders = string.Concat(names.Select(n => $"{n}:{headers.First(h => h.Key.Equals(n, StringComparison.OrdinalIgnoreCase)).Value.Trim()}\n"));
        var signed = string.Join(';', names);
        var canonical = $"{method}\n{path}\n{query}\n{canonicalHeaders}\n{signed}\n{payloadHash}";
        var scope = $"{date}/{region}/{service}/aws4_request";
        var toSign = $"AWS4-HMAC-SHA256\n{amzDate}\n{scope}\n{Hex(SHA256.HashData(Encoding.UTF8.GetBytes(canonical)))}";
        var key = Hmac(Hmac(Hmac(Hmac(Encoding.UTF8.GetBytes("AWS4" + secretKey), date), region), service), "aws4_request");
        return $"AWS4-HMAC-SHA256 Credential={accessKey}/{scope}, SignedHeaders={signed}, Signature={Hex(HMACSHA256.HashData(key, Encoding.UTF8.GetBytes(toSign)))}";
    }
}
