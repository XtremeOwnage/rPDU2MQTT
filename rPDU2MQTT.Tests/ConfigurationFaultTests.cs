using rPDU2MQTT.Core.Startup;
using Xunit;

namespace rPDU2MQTT.Tests;

/// <summary>
/// Nothing reachable from a toggle in the GUI may stop the bridge from starting.
///
/// <para>
/// Enabling EmonCMS before filling in its URL did exactly that: startup threw, and the process could not
/// come up at all — no PDU polling, no MQTT, no Home Assistant, no energy flow — over one optional
/// exporter. The only symptom was a stack trace in a container that was already restarting.
/// </para>
/// </summary>
public class ConfigurationFaultTests
{



    [Fact]
    public void LoggingSinksDegradeIndividually()
    {
        // Same rule for the other two toggles that could brick startup.
        Assert.NotNull(DestinationRequirements.FileLog(enabled: true, path: null));
        Assert.Null(DestinationRequirements.FileLog(enabled: true, path: "/var/log/rpdu.log"));
        Assert.Null(DestinationRequirements.FileLog(enabled: false, path: null));

        Assert.NotNull(DestinationRequirements.Syslog(enabled: true, host: null));
        Assert.Null(DestinationRequirements.Syslog(enabled: true, host: "syslog.local"));
        Assert.Null(DestinationRequirements.Syslog(enabled: false, host: null));

        // Each names only its own sink, so one bad sink doesn't read as "logging is broken".
        Assert.Contains("console sink is unaffected", DestinationRequirements.FileLog(true, null)!.Message);
        Assert.Contains("other log sinks are unaffected", DestinationRequirements.Syslog(true, null)!.Message);
    }
    [Fact]
    public void BeforeAnythingTries_ItIsNotYetKnown_NotUnreachable()
    {
        // Energy aggregation is off by default, so nothing touches the cache. Reporting the initial
        // false as "UNREACHABLE" made a perfectly healthy Valkey look broken on the board.
        var h = new rPDU2MQTT.Core.Flow.CacheHealth();

        Assert.False(h.Attempted);          // -> the card shows "checking", not a red failure
        Assert.False(h.Reachable);
        Assert.Null(h.Error);
    }

    [Fact]
    public void SuccessAndFailureBothCountAsAttempted()
    {
        var h = new rPDU2MQTT.Core.Flow.CacheHealth();

        h.Succeeded();
        Assert.True(h.Attempted);
        Assert.True(h.Reachable);
        Assert.Null(h.Error);

        h.Failed("connection refused");
        Assert.True(h.Attempted);
        Assert.False(h.Reachable);
        Assert.Equal("connection refused", h.Error);

        // And it recovers, so a transient outage doesn't leave the card red forever.
        h.Succeeded();
        Assert.True(h.Reachable);
        Assert.Null(h.Error);
    }

    [Fact]
    public void AnEnabledDestinationMissingWhatItNeeds_IsDisabledAndSaysSo_WithoutStoppingTheBridge()
    {
        // The rule lives on the integration now, not in a static helper nothing calls. Testing the helper
        // was testing a copy: the production path had already moved and the copy would have kept passing
        // however wrong it got.
        var cfg = new rPDU2MQTT.Classes.Config();
        cfg.EmonCMS.Enabled = true;
        cfg.EmonCMS.Transport = rPDU2MQTT.Models.Config.EmonCmsTransport.Http;
        cfg.EmonCMS.Url = null;

        var emon = new rPDU2MQTT.Integrations.EmonCms.EmonCmsIntegration(
            cfg, new rPDU2MQTT.Services.EmonCmsStatus(new rPDU2MQTT.Core.Integrations.IntegrationStatus()),
            new rPDU2MQTT.Services.EmonCmsFeedSync(cfg, new StubSnapshots()));

        Assert.NotNull(emon.Misconfigured(cfg));

        // Over MQTT it reuses the broker and needs no URL at all.
        cfg.EmonCMS.Transport = rPDU2MQTT.Models.Config.EmonCmsTransport.Mqtt;
        Assert.Null(emon.Misconfigured(cfg));

        // Blank counts as missing — a null-only check let Url: "" through, to fail later at runtime.
        cfg.EmonCMS.Transport = rPDU2MQTT.Models.Config.EmonCmsTransport.Http;
        cfg.EmonCMS.Url = "   ";
        Assert.NotNull(emon.Misconfigured(cfg));

        // And a destination nobody switched on is not a fault to go and fix.
        cfg.EmonCMS.Enabled = false;
        Assert.False(emon.Enabled(cfg));
    }

    private sealed class StubSnapshots : rPDU2MQTT.Core.ISnapshotCache
    {
        public IReadOnlyCollection<rPDU2MQTT.Core.PduSnapshot> All => Array.Empty<rPDU2MQTT.Core.PduSnapshot>();
        public rPDU2MQTT.Core.PduSnapshot? Latest => null;
        public rPDU2MQTT.Core.PduSnapshot? Get(string instanceId) => null;
        public void Put(rPDU2MQTT.Core.PduSnapshot snapshot) { }
    }
}
