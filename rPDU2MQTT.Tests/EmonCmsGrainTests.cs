using rPDU2MQTT.Grains.Abstractions.EmonCms;
using Xunit;

namespace rPDU2MQTT.Tests;

/// <summary>
/// EmonCMS's configuration is written by one actor. These check the gating around that — a pass that can't
/// or shouldn't run says why instead of half-applying something to someone else's database.
/// </summary>
public class EmonCmsFeedGrainTests
{
    [Fact]
    public async Task Disabled_Or_Unconfigured_Refuses_AndSaysWhy()
    {
        var cluster = await GrainTestCluster.StartAsync();
        try
        {
            var emon = cluster.GrainFactory.GetGrain<IEmonCmsFeedGrain>(0);

            // The bare test cluster's config has EmonCMS off, so nothing is called and the refusal is recorded.
            var report = await emon.Reconcile(force: true);
            Assert.False(report.Ok);
            Assert.Contains("disabled", report.Message, StringComparison.OrdinalIgnoreCase);
            Assert.NotNull(report.AtUtc);

            // ...and it's readable afterwards without triggering another pass.
            var last = await emon.Last();
            Assert.Equal(report.Message, last.Message);
        }
        finally { await cluster.StopAllSilosAsync(); }
    }

    [Fact]
    public async Task PeriodicPoke_IsIgnored_WhenAutoConfigureIsOff()
    {
        var cluster = await GrainTestCluster.StartAsync();
        try
        {
            // A timer poking the grain must never provision on its own when the operator hasn't asked for it.
            var report = await cluster.GrainFactory.GetGrain<IEmonCmsFeedGrain>(0).Reconcile(force: false);
            Assert.False(report.Ok);
        }
        finally { await cluster.StopAllSilosAsync(); }
    }
}
