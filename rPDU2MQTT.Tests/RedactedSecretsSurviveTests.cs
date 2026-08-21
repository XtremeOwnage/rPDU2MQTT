using System.Text.RegularExpressions;

namespace rPDU2MQTT.Tests;

/// <summary>
/// Every secret stripped from the Kubernetes CR has to be kept somewhere else.
///
/// <para>
/// On Kubernetes the CR spec is written redacted and the credentials go to a companion Secret, which is
/// read back on load. A field added to <c>RedactSecrets</c> but not to <c>SecretFields</c> is therefore
/// removed from the CR on the next save and restored from nowhere: the value is destroyed, with no error
/// and nothing in the log. That is what happened to the Home Assistant token — the Energy Dashboard sync
/// began reporting "enabled but no long-lived access token is set" and the field in the GUI was empty.
/// </para>
/// <para>
/// A source-shape guard rather than a behavioural one, because the failure is a field present in one list
/// and absent from another; there is no state to drive it into.
/// </para>
/// </summary>
public class RedactedSecretsSurviveTests
{
    private static string Read(params string[] parts)
        => File.ReadAllText(Path.Combine(new[] { FindRepoRoot() }.Concat(parts).ToArray()));

    private static string FindRepoRoot()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !File.Exists(Path.Combine(dir.FullName, "rPDU2MQTT.sln"))) dir = dir.Parent;
        return dir?.FullName ?? throw new InvalidOperationException("repo root not found");
    }

    /// <summary>The config paths RedactSecrets nulls out, e.g. "HASS.EnergyDashboard.Token".</summary>
    private static IEnumerable<string> Redacted()
    {
        var source = Read("rPDU2MQTT.Core", "ConfigSchema.cs");
        var body = source[source.IndexOf("public static Config RedactSecrets", StringComparison.Ordinal)..];
        body = body[..body.IndexOf("return clone;", StringComparison.Ordinal)];
        foreach (Match m in Regex.Matches(body, @"clone\.([A-Za-z0-9_.?]+)\s*=\s*null", RegexOptions.None, TimeSpan.FromSeconds(5)))
            yield return m.Groups[1].Value.Replace("?", "");
    }

    [Fact]
    public void EverySecretStrippedFromTheCrIsKeptInTheCompanionSecret()
    {
        var secretFields = Read("rPDU2MQTT.Engine", "ConfigSources", "KubernetesConfigSource.cs");
        var fields = secretFields[secretFields.IndexOf("SecretFields =", StringComparison.Ordinal)..];
        fields = fields[..fields.IndexOf("};", StringComparison.Ordinal)].Replace("?", "");

        var missing = new List<string>();
        foreach (var path in Redacted())
        {
            // The last two segments identify the field well enough to spot in the accessor lambdas —
            // "EnergyDashboard.Token", "Gui.Password" — without matching a same-named field elsewhere.
            var segments = path.Split('.');
            var needle = segments.Length >= 2 ? string.Join('.', segments[^2..]) : path;
            if (!fields.Contains(needle, StringComparison.Ordinal)) missing.Add(path);
        }

        Assert.True(missing.Count == 0,
            "These are redacted from the CR but never written to the companion Secret, so a save destroys "
          + "them: " + string.Join(", ", missing));
    }

    /// <summary>A key the chart never writes is a credential the operator cannot supply at install.</summary>
    [Fact]
    public void EveryCompanionSecretKeyIsOfferedByTheChart()
    {
        // Only the companion-Secret table: the same file also names env vars that are not credentials.
        var source = Read("rPDU2MQTT.Engine", "ConfigSources", "KubernetesConfigSource.cs");
        var table = source[source.IndexOf("SecretFields =", StringComparison.Ordinal)..];
        table = table[..table.IndexOf("};", StringComparison.Ordinal)];
        var keys = Regex.Matches(table, "\"(RPDU2MQTT_[A-Z_]+)\"", RegexOptions.None, TimeSpan.FromSeconds(5))
            .Select(m => m.Groups[1].Value).Distinct().ToList();
        Assert.NotEmpty(keys);

        var secretTemplate = Read("charts", "rpdu2mqtt", "templates", "secret.yaml");
        var missing = keys.Where(k => !secretTemplate.Contains(k, StringComparison.Ordinal)).ToList();

        Assert.True(missing.Count == 0, "The chart offers no value for: " + string.Join(", ", missing));
    }
}
