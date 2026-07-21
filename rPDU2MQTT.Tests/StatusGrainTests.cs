using rPDU2MQTT.Grains.Abstractions.Status;
using Xunit;

namespace rPDU2MQTT.Tests;

/// <summary>
/// The Status board as grains: a process reports facts, the component grain decides what they mean, and the
/// board is the projection of those verdicts — so every replica and every reader see the same board.
/// </summary>
public class StatusGrainTests
{
    private static ComponentReport Report(bool? ok = null, bool enabled = true, string? detail = null,
        DateTime? eventUtc = null, int intervalSeconds = 0, string? title = null, long count = 0, string? state = null)
        => new() { Ok = ok, Enabled = enabled, Detail = detail, EventUtc = eventUtc, IntervalSeconds = intervalSeconds, Title = title, Count = count, State = state };

    [Fact]
    public async Task Component_Reports_Reach_TheBoard_AsVerdicts()
    {
        var cluster = await GrainTestCluster.StartAsync();
        try
        {
            var f = cluster.GrainFactory;
            await f.GetGrain<IMqttStatusGrain>("mqtt").Report(Report(ok: true, detail: "broker:1883"));

            var card = Assert.Single(await f.GetGrain<IStatusBoardGrain>(0).Board(), c => c.Id == "mqtt");
            Assert.Equal(StatusLevel.Good, card.Level);
            Assert.Equal("Connected", card.State);
            Assert.Equal("broker:1883", card.Detail);
            Assert.Equal("MQTT", card.Title);

            // A change of fact republishes the verdict — the board follows without being asked.
            await f.GetGrain<IMqttStatusGrain>("mqtt").Report(Report(ok: false, detail: "broker:1883"));
            card = Assert.Single(await f.GetGrain<IStatusBoardGrain>(0).Board(), c => c.Id == "mqtt");
            Assert.Equal(StatusLevel.Bad, card.Level);
            Assert.Equal("Disconnected", card.State);
        }
        finally { await cluster.StopAllSilosAsync(); }
    }

    [Fact]
    public async Task Pdu_Staleness_IsJudged_AgainstItsOwnPollInterval()
    {
        var cluster = await GrainTestCluster.StartAsync();
        try
        {
            var f = cluster.GrainFactory;
            var now = DateTime.UtcNow;

            var fresh = f.GetGrain<IPduStatusGrain>("pdu:default");
            await fresh.Report(Report(eventUtc: now.AddSeconds(-2), intervalSeconds: 30, title: "PDU · default"));
            var card = await fresh.Current();
            Assert.Equal(StatusLevel.Good, card.Level);
            Assert.Equal("Polling", card.State);
            Assert.Equal("PDU · default", card.Title);
            Assert.Equal(AgeStyle.Ago, card.Age);          // the consumer ages EventUtc into "Updated 2s ago"

            // Same age, a much tighter cadence → the same reading is stale.
            var slow = f.GetGrain<IPduStatusGrain>("pdu:slow");
            await slow.Report(Report(eventUtc: now.AddSeconds(-600), intervalSeconds: 30));
            Assert.Equal(StatusLevel.Bad, (await slow.Current()).Level);

            // Nothing polled yet is waiting, not broken.
            var empty = f.GetGrain<IPduStatusGrain>("pdu:new");
            await empty.Report(Report(intervalSeconds: 30));
            var waiting = await empty.Current();
            Assert.Equal(StatusLevel.Warn, waiting.Level);
            Assert.Equal("No data yet", waiting.State);
        }
        finally { await cluster.StopAllSilosAsync(); }
    }

    [Fact]
    public async Task EmonCms_KnownOutcome_SurvivesReportsFromProcessesThatCantSeeIt()
    {
        var cluster = await GrainTestCluster.StartAsync();
        try
        {
            var emon = cluster.GrainFactory.GetGrain<IEmonCmsStatusGrain>("emoncms");

            // The worker exports successfully...
            await emon.Report(Report(ok: true, detail: "HTTP", count: 12));
            var card = await emon.Current();
            Assert.Equal(StatusLevel.Good, card.Level);
            Assert.Equal("Exporting", card.State);
            Assert.Contains("12 values", card.Detail);

            // ...then an API/UI replica reports: it has no exporter, so no outcome. That is not evidence of a
            // problem, and must not turn the card amber.
            await emon.Report(Report(ok: null, detail: "HTTP"));
            Assert.Equal(StatusLevel.Good, (await emon.Current()).Level);

            // A real failure does change it.
            await emon.Report(Report(ok: false, detail: "connection refused"));
            card = await emon.Current();
            Assert.Equal(StatusLevel.Bad, card.Level);
            Assert.Equal("connection refused", card.Detail);
        }
        finally { await cluster.StopAllSilosAsync(); }
    }

    [Fact]
    public async Task Disabled_Components_AreGrey_NotBroken()
    {
        var cluster = await GrainTestCluster.StartAsync();
        try
        {
            var f = cluster.GrainFactory;
            await f.GetGrain<IEmonCmsStatusGrain>("emoncms").Report(Report(enabled: false));
            await f.GetGrain<IHomeAssistantStatusGrain>("homeassistant").Report(Report(enabled: false));
            await f.GetGrain<IPrometheusStatusGrain>("prometheus").Report(Report(enabled: true, detail: ":9184/metrics"));

            var board = await f.GetGrain<IStatusBoardGrain>(0).Board();
            Assert.Equal(StatusLevel.Off, board.Single(c => c.Id == "emoncms").Level);
            Assert.Equal("Discovery off", board.Single(c => c.Id == "homeassistant").State);
            Assert.Equal(StatusLevel.Good, board.Single(c => c.Id == "prometheus").Level);

            // Board order is the components' own, broker first and nodes last.
            await f.GetGrain<IMqttStatusGrain>("mqtt").Report(Report(ok: true));
            await f.GetGrain<INodeStatusGrain>("node:a").Report(Report(state: "worker, api, ui", detail: "v1 ·", eventUtc: DateTime.UtcNow));
            board = await f.GetGrain<IStatusBoardGrain>(0).Board();
            Assert.Equal("mqtt", board.First().Id);
            Assert.Equal("node:a", board.Last().Id);
        }
        finally { await cluster.StopAllSilosAsync(); }
    }

    [Fact]
    public async Task Node_Card_Carries_ItsRoles_AndUptime()
    {
        var cluster = await GrainTestCluster.StartAsync();
        try
        {
            var started = DateTime.UtcNow.AddHours(-1);
            var node = cluster.GrainFactory.GetGrain<INodeStatusGrain>("node:worker-pod-1");
            await node.Report(Report(state: "worker", detail: "v0.0.0-local ·", eventUtc: started, title: "Node · pod-1"));

            var card = await node.Current();
            Assert.Equal("Node · pod-1", card.Title);
            Assert.Equal("worker", card.State);
            Assert.Equal(StatusLevel.Good, card.Level);
            Assert.Equal(AgeStyle.Uptime, card.Age);       // the consumer renders "up 1h 0m" from EventUtc
            Assert.Equal(started, card.EventUtc);
        }
        finally { await cluster.StopAllSilosAsync(); }
    }

    [Fact]
    public async Task NeverReported_Component_IsUnknown_NotHealthy()
    {
        var cluster = await GrainTestCluster.StartAsync();
        try
        {
            var card = await cluster.GrainFactory.GetGrain<IMqttStatusGrain>("mqtt").Current();
            Assert.Equal(StatusLevel.Off, card.Level);
            Assert.Equal("Unknown", card.State);

            // ...and it never published, so it isn't on the board at all.
            Assert.Empty(await cluster.GrainFactory.GetGrain<IStatusBoardGrain>(0).Board());
        }
        finally { await cluster.StopAllSilosAsync(); }
    }
}
