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
    public void EmonCmsOverHttpWithNoUrl_IsAFault_NotAnException()
    {
        // The exact state a GUI toggle produces: Enabled on, Transport Http, URL never filled in.
        var fault = DestinationRequirements.EmonCms(enabled: true, httpTransport: true, url: null);

        Assert.NotNull(fault);
        Assert.Equal("emoncms", fault!.Component);
        Assert.Equal("EmonCMS.Url", fault.Path);
        // The message has to say the rest of the bridge is unaffected — that is the whole behavioural change.
        Assert.Contains("keeps running", fault.Message);
    }

    [Fact]
    public void ABlankUrl_CountsAsMissing()
    {
        // The old check tested only for null, so Url: "" sailed past startup and failed later at runtime.
        Assert.NotNull(DestinationRequirements.EmonCms(true, true, ""));
        Assert.NotNull(DestinationRequirements.EmonCms(true, true, "   "));
    }

    [Fact]
    public void EmonCmsIsFine_WhenDisabled_OrOverMqtt_OrConfigured()
    {
        Assert.Null(DestinationRequirements.EmonCms(enabled: false, httpTransport: true, url: null));
        // The MQTT transport reuses the broker, so it needs no URL at all.
        Assert.Null(DestinationRequirements.EmonCms(enabled: true, httpTransport: false, url: null));
        Assert.Null(DestinationRequirements.EmonCms(enabled: true, httpTransport: true, url: "https://emon.example.com/"));
    }

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
    public void FaultsAreRecordedPerComponent_AndTheLatestWins()
    {
        var faults = new ConfigurationFaults();
        Assert.Null(faults.For("emoncms"));

        faults.Record(DestinationRequirements.EmonCms(true, true, null)!);
        Assert.NotNull(faults.For("emoncms"));
        Assert.Single(faults.All);

        // Re-recording the same component replaces rather than accumulating — the board shows one card.
        faults.Record(DestinationRequirements.EmonCms(true, true, null)!);
        Assert.Single(faults.All);
    }
}

/// <summary>
/// The Status board must distinguish a cache nobody has used from one that is down.
/// </summary>
public class CacheHealthTests
{
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
}
