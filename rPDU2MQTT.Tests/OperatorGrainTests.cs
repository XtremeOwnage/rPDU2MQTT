using rPDU2MQTT.Grains.Abstractions.Operator;
using Xunit;

namespace rPDU2MQTT.Tests;

/// <summary>
/// The operator as a grain: activates, and its actions return results directly (no MQTT command topic, no
/// CR-status polling). Without the Kubernetes config source it reports unavailable — and exercises shipping
/// the OperatorReport across the grain boundary.
/// </summary>
public class OperatorGrainTests
{
    [Fact]
    public async Task OperatorGrain_WithoutKubernetes_ReportsUnavailable()
    {
        var cluster = await GrainTestCluster.StartAsync();
        try
        {
            var op = cluster.GrainFactory.GetGrain<IOperatorGrain>(0);

            var report = await op.CheckNow(force: true);
            Assert.Contains("Kubernetes", report.Message);

            Assert.Contains("Kubernetes", await op.SetTag("edge"));
            Assert.Contains("Kubernetes", await op.Redeploy());
        }
        finally { await cluster.StopAllSilosAsync(); }
    }

    [Fact]
    public void SetImagePatch_UpdatesBothTheImageAndTheReportedTagEnv()
    {
        // Regression: a switch that patched only the container image rolled the pod but left RPDU2MQTT_IMAGE
        // (what the GUI/diagnostics report) on the old tag, so it looked like the switch didn't stick.
        var json = rPDU2MQTT.Grains.Operator.OperatorGrain.BuildImagePatch(
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
}
