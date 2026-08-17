using rPDU2MQTT.Classes;
using rPDU2MQTT.Core.Operator;
using rPDU2MQTT.Hosting;
using rPDU2MQTT.Services.Operator;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace rPDU2MQTT.Tests;

/// <summary>
/// The operator's actions return their results directly (no MQTT command topic, no CR-status polling).
/// Without the Kubernetes config source there is nothing it can roll, and it says so rather than failing.
/// </summary>
public class KubernetesOperatorTests
{
    [Fact]
    public async Task WithoutKubernetes_ReportsUnavailable()
    {
        var op = new KubernetesOperator(new Config(), new NoRegistry(), NullLogger<KubernetesOperator>.Instance);

        var report = await op.CheckNow(force: true);
        Assert.Contains("Kubernetes", report.Message);

        Assert.Contains("Kubernetes", await op.SetTag("edge"));
        Assert.Contains("Kubernetes", await op.Redeploy());
    }

    /// <summary>Never reached without the Kubernetes source — which is the point of the test above.</summary>
    private sealed class NoRegistry : IContainerRegistry
    {
        public Task<IReadOnlyList<string>> ListTagsAsync(string registry, string repository, CancellationToken ct)
            => throw new NotSupportedException();
        public Task<string?> ResolveDigestAsync(string registry, string repository, string tag, CancellationToken ct)
            => throw new NotSupportedException();
    }

    [Fact]
    public void SetImagePatch_UpdatesBothTheImageAndTheReportedTagEnv()
    {
        // Regression: a switch that patched only the container image rolled the pod but left RPDU2MQTT_IMAGE
        // (what the GUI/diagnostics report) on the old tag, so it looked like the switch didn't stick.
        var json = KubernetesOperator.BuildImagePatch(
            new[] { "rpdu2mqtt" }, "ghcr.io/xtremeownage/rpdu2mqtt:unstable", "ghcr.io/xtremeownage/rpdu2mqtt:unstable");

        using var doc = System.Text.Json.JsonDocument.Parse(json);
        var container = doc.RootElement.GetProperty("spec").GetProperty("template").GetProperty("spec")
            .GetProperty("containers")[0];
        Assert.Equal("rpdu2mqtt", container.GetProperty("name").GetString());
        Assert.Equal("ghcr.io/xtremeownage/rpdu2mqtt:unstable", container.GetProperty("image").GetString());
        var env = container.GetProperty("env")[0];
        Assert.Equal("RPDU2MQTT_IMAGE", env.GetProperty("name").GetString());
        Assert.Equal("ghcr.io/xtremeownage/rpdu2mqtt:unstable", env.GetProperty("value").GetString());
    }

    [Theory]
    // A pod's ImageID is a full pull reference; the registry gives a bare digest. Same build → equal.
    [InlineData("ghcr.io/xtremeownage/rpdu2mqtt@sha256:ABC123", "sha256:abc123", true)]
    [InlineData("docker-pullable://ghcr.io/xtremeownage/rpdu2mqtt@sha256:abc123", "sha256:abc123", true)]
    // Different builds of the same moving tag → a newer build is waiting.
    [InlineData("ghcr.io/xtremeownage/rpdu2mqtt@sha256:aaa", "sha256:bbb", false)]
    // Nothing to compare → never claim equality (the operator says "couldn't determine" instead).
    [InlineData("", "sha256:abc", false)]
    [InlineData("ghcr.io/xtremeownage/rpdu2mqtt:unstable", "sha256:abc", false)]
    public void ImageDigest_EqualsWhenSameBuild_RegardlessOfReferenceShape(string a, string b, bool expected)
        => Assert.Equal(expected, rPDU2MQTT.Hosting.ImageDigest.Equal(a, b));

    [Fact]
    public void ImageDigest_Normalize_ExtractsShaFromAnyReference()
    {
        Assert.Equal("sha256:abc", rPDU2MQTT.Hosting.ImageDigest.Normalize("repo@SHA256:ABC"));
        Assert.Null(rPDU2MQTT.Hosting.ImageDigest.Normalize("repo:unstable"));
        Assert.Null(rPDU2MQTT.Hosting.ImageDigest.Normalize(null));
    }
[Fact]
    public void ADeploymentNotRunningTheApp_IsLeftAlone()
    {
        // The label selector finds every Deployment in the release, and the chart's Valkey cache carries the
        // same app.kubernetes.io/instance label. Selecting a container name for it used to fall back to the
        // conventional "rpdu2mqtt" — and a strategic-merge patch keyed on name CREATES what isn't there, so
        // the operator injected a whole crash-looping bridge container into the cache's pod.
        var valkey = new[] { new k8s.Models.V1Container { Name = "valkey", Image = "valkey/valkey:8-alpine" } };

        var targets = KubernetesOperator.TargetContainers(valkey, "xtremeownage/rpdu2mqtt");

        Assert.Empty(targets);   // empty means "skip this Deployment", never "invent a container"
    }

    [Fact]
    public void ContainersRunningTheApp_AreTargeted()
    {
        // The counterpart: a real deployment, including a multi-container pod, still gets patched — and only
        // the containers that actually run the app.
        var pod = new[]
        {
            new k8s.Models.V1Container { Name = "rpdu2mqtt", Image = "ghcr.io/xtremeownage/rpdu2mqtt:unstable" },
            new k8s.Models.V1Container { Name = "sidecar", Image = "busybox:latest" },
        };

        var targets = KubernetesOperator.TargetContainers(pod, "xtremeownage/rpdu2mqtt");

        Assert.Equal(new[] { "rpdu2mqtt" }, targets);
    }
}
