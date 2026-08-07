using Xunit;

namespace rPDU2MQTT.Tests;

/// <summary>
/// The chart's pod security defaults must not depend on what the image's USER directive happens to say.
///
/// <para>
/// #349: setting <c>runAsNonRoot</c> without <c>runAsUser</c> makes kubelet verify the image's own USER,
/// which it can only do when that USER is numeric. Against an image whose USER is a name the container does
/// not start at all — "container has runAsNonRoot and image has non-numeric user (app), cannot verify user
/// is non-root". The image and the chart were changed together, so the chart reached a cluster before the
/// image did and every pod there failed.
/// </para>
/// </summary>
public class ChartSecurityContextTests
{
    private static string Values()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !File.Exists(Path.Combine(dir.FullName, "rPDU2MQTT.sln"))) dir = dir.Parent;
        Assert.NotNull(dir);
        var path = Path.Combine(dir!.FullName, "charts", "rpdu2mqtt", "values.yaml");
        Assert.True(File.Exists(path), $"{path} is missing.");
        return File.ReadAllText(path);
    }

    /// <summary>The block starting at a top-level key, up to the next top-level key or comment.</summary>
    private static string Block(string yaml, string key)
    {
        var lines = yaml.Split('\n');
        var start = Array.FindIndex(lines, l => l.StartsWith(key + ":", StringComparison.Ordinal));
        Assert.True(start >= 0, $"no top-level '{key}:' in values.yaml");
        var end = start + 1;
        while (end < lines.Length && (lines[end].Length == 0 || lines[end][0] is ' ' or '\t')) end++;
        return string.Join('\n', lines[start..end]);
    }

    [Fact]
    public void RunAsNonRoot_IsAlwaysPairedWithAnExplicitRunAsUser()
    {
        var block = Block(Values(), "podSecurityContext");
        if (!block.Contains("runAsNonRoot: true")) return;   // not requesting it; nothing to pair

        Assert.Contains("runAsUser:", block);
    }

    [Fact]
    public void TheDockerfileUsesANumericUser()
    {
        // Belt and braces for the same failure: even with runAsUser set, a named USER leaves anyone who
        // overrides podSecurityContext with runAsNonRoot alone in the broken state.
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !File.Exists(Path.Combine(dir.FullName, "rPDU2MQTT.sln"))) dir = dir.Parent;
        var dockerfile = File.ReadAllText(Path.Combine(dir!.FullName, "Dockerfile"));

        var user = dockerfile.Split('\n').Last(l => l.TrimStart().StartsWith("USER ", StringComparison.Ordinal)).Trim();
        Assert.True(user is "USER $APP_UID" || user.Length > 5 && char.IsDigit(user[5]),
            $"the image's USER must be numeric or $APP_UID so kubelet can verify runAsNonRoot; found '{user}'");
    }
}
