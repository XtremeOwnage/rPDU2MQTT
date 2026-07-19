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
}
