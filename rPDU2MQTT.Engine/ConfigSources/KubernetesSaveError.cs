using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using k8s.Autorest;

namespace rPDU2MQTT.Startup.ConfigSources;

/// <summary>
/// What the Kubernetes API server said, in words.
///
/// <para>
/// A rejected write comes back as a <c>Status</c> object, and reporting it by pasting that JSON into the
/// GUI leaves the reader to find the one field at fault inside a wall of escaped quotes. The commonest
/// rejection by far is a CRD older than the build writing to it: a value this version understands is not
/// in the installed schema's enum, which reads as the GUI being broken when the fix is to apply the CRD.
/// </para>
/// </summary>
public static class KubernetesSaveError
{
    /// <summary>The rejection in plain words, or null when this is not one the API server explained.</summary>
    public static string? Explain(Exception ex) => ex switch
    {
        HttpOperationException k => Explain((int?)k.Response?.StatusCode ?? 0, k.Response?.Content),
        _ => null,
    };

    /// <summary>As above, from the status code and response body — the form a test can state outright.</summary>
    public static string? Explain(int statusCode, string? body)
    {
        if (string.IsNullOrWhiteSpace(body)) return null;

        JsonElement root;
        try { root = JsonDocument.Parse(body).RootElement; }
        catch (JsonException) { return null; }
        if (root.ValueKind != JsonValueKind.Object) return null;
        if (!root.TryGetProperty("kind", out var kind) || kind.GetString() != "Status") return null;

        var causes = root.TryGetProperty("details", out var details) && details.TryGetProperty("causes", out var c)
            && c.ValueKind == JsonValueKind.Array ? c.EnumerateArray().ToList() : [];

        var text = new StringBuilder();
        text.Append(statusCode == 422
            ? "Kubernetes rejected this save: the RpduConfig CRD installed in the cluster does not accept it."
            : $"Kubernetes refused this save (HTTP {statusCode}).");

        if (causes.Count == 0)
        {
            var message = root.TryGetProperty("message", out var m) ? m.GetString() : null;
            if (!string.IsNullOrWhiteSpace(message)) text.Append('\n').Append(message);
            return text.ToString();
        }

        var unsupported = false;
        foreach (var cause in causes)
        {
            var field = Readable(cause.TryGetProperty("field", out var f) ? f.GetString() : null);
            var message = cause.TryGetProperty("message", out var m) ? m.GetString() ?? "" : "";
            var reason = cause.TryGetProperty("reason", out var r) ? r.GetString() : null;
            if (reason is "FieldValueNotSupported") unsupported = true;

            text.Append("\n• ").Append(field.Length > 0 ? field + ": " : "").Append(Plain(message));
        }

        // The value is one this build offers, so the schema that refused it is behind the build.
        if (unsupported)
            text.Append("\n\nThat value is one this version added, so the CRD in the cluster is older than this build. ")
                .Append("Apply the CRD shipped with this release (kubectl apply -f charts/rpdu2mqtt/crds/rpduconfig.yaml), ")
                .Append("or update it through whatever manages the cluster's manifests, then save again.");

        return text.ToString();
    }

    /// <summary>The field path as the GUI shows it: <c>spec.</c> is the CR's wrapper, not part of the setting.</summary>
    private static string Readable(string? field)
    {
        var f = (field ?? "").Trim();
        return f.StartsWith("spec.", StringComparison.Ordinal) ? f["spec.".Length..] : f;
    }

    /// <summary>One cause, unquoted: <c>Unsupported value: "x": supported values: "a", "b"</c> reads badly as-is.</summary>
    private static string Plain(string message)
    {
        var m = Regex.Match(message, "^Unsupported value: \"(?<value>[^\"]*)\": supported values: (?<list>.+)$");
        if (!m.Success) return message;

        var allowed = string.Join(", ", Regex.Matches(m.Groups["list"].Value, "\"(?<v>[^\"]*)\"").Select(x => x.Groups["v"].Value));
        return $"'{m.Groups["value"].Value}' is not a value the installed CRD allows here (it accepts {allowed}).";
    }
}
