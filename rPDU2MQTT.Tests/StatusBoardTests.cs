using rPDU2MQTT.Core.Status;
using Xunit;

namespace rPDU2MQTT.Tests;

/// <summary>
/// The Status board's rules, which used to live one per grain. Evaluated on read rather than on a timer,
/// so an age can never be stale and a component going quiet turns amber without anything noticing.
/// </summary>
public class StatusBoardTests
{
    [Fact]
    public void ADisabledComponentIsGrey_NotAFailure()
    {
        var board = new StatusBoard();
        board.Report("mqtt", StatusBoard.ComponentKind.Broker, new ComponentReport(Enabled: false));

        Assert.Equal(StatusLevel.Off, board.For("mqtt")!.Level);
    }

    [Fact]
    public void ADeviceIsJudgedAgainstItsOwnInterval()
    {
        // A five-minute poller must not be called stale by a thirty-second one's standard, which is why
        // the cadence travels on the report rather than being assumed by the board.
        var board = new StatusBoard();
        var twoMinutesAgo = DateTime.UtcNow.AddMinutes(-2);

        board.Report("fast", StatusBoard.ComponentKind.Device, new ComponentReport(EventUtc: twoMinutesAgo, IntervalSeconds: 30));
        board.Report("slow", StatusBoard.ComponentKind.Device, new ComponentReport(EventUtc: twoMinutesAgo, IntervalSeconds: 600));

        Assert.Equal(StatusLevel.Bad, board.For("fast")!.Level);
        Assert.Equal(StatusLevel.Good, board.For("slow")!.Level);
    }

    [Fact]
    public void AConfiguredButUnreachableCacheIsAFailure_NotAnOff()
    {
        // The counters it holds are what let a restart continue a total instead of looking like a meter
        // reset, so a silent fallback to local state is worth shouting about.
        var board = new StatusBoard();
        board.Report("cache", StatusBoard.ComponentKind.Cache, new ComponentReport(Enabled: true, Ok: false, Detail: "refused"));

        var card = board.For("cache")!;
        Assert.Equal(StatusLevel.Bad, card.Level);
        Assert.Equal("Unreachable", card.State);
    }

    [Fact]
    public void AnUntriedCacheIsAmber_NotConnected()
    {
        // Claiming "Connected" on no evidence is the same mistake as calling an untried cache unreachable.
        var board = new StatusBoard();
        board.Report("cache", StatusBoard.ComponentKind.Cache, new ComponentReport(Enabled: true, Ok: null));

        Assert.Equal(StatusLevel.Warn, board.For("cache")!.Level);
    }

    [Fact]
    public void EnabledWithNoOutcomeYetIsItsOwnState()
    {
        var board = new StatusBoard();
        board.Report("emoncms", StatusBoard.ComponentKind.Integration, new ComponentReport(Enabled: true, Ok: null));

        var card = board.For("emoncms")!;
        Assert.Equal(StatusLevel.Warn, card.Level);
        Assert.Equal("No data yet", card.State);
    }

    [Fact]
    public void ACardOrders_ByKind_SoTheBrokerLeadsAndNodesTrail()
    {
        var board = new StatusBoard();
        board.Report("node:x", StatusBoard.ComponentKind.Node, new ComponentReport());
        board.Report("mqtt", StatusBoard.ComponentKind.Broker, new ComponentReport(Ok: true));
        board.Report("pdu:1", StatusBoard.ComponentKind.Device, new ComponentReport(EventUtc: DateTime.UtcNow, IntervalSeconds: 30));

        Assert.Equal(["mqtt", "pdu:1", "node:x"], board.Board().Select(c => c.Id));
    }

    [Fact]
    public void AnIntegrationsOwnVerdictBecomesItsCard()
    {
        // One rule serving both the board and /health/integrations — the alternative is two answers to
        // "is EmonCMS healthy" that drift apart.
        var report = StatusBoard.From(
            new rPDU2MQTT.Core.Integrations.IntegrationHealth(
                rPDU2MQTT.Core.Integrations.HealthLevel.Bad, "Error", "connection refused"),
            "EmonCMS");

        var board = new StatusBoard();
        board.Report("emoncms", StatusBoard.ComponentKind.Integration, report);

        var card = board.For("emoncms")!;
        Assert.Equal(StatusLevel.Bad, card.Level);
        Assert.Equal("EmonCMS", card.Title);
        Assert.Equal("connection refused", card.Detail);
    }

    [Fact]
    public void ADroppedComponentLeavesTheBoard()
    {
        var board = new StatusBoard();
        board.Report("gone", StatusBoard.ComponentKind.Integration, new ComponentReport());
        board.Drop("gone");

        Assert.Null(board.For("gone"));
        Assert.Empty(board.Board());
    }

    [Fact]
    public void AChangeOfFact_ChangesTheVerdict_WithoutAnythingRepublishing()
    {
        // The board is a projection, not a cache of verdicts: the reporter states facts and the reader gets
        // the current answer. A card can never be a verdict nobody has re-evaluated.
        var board = new StatusBoard();
        board.Report("mqtt", StatusBoard.ComponentKind.Broker, new ComponentReport(Ok: true, Detail: "broker:1883"));
        Assert.Equal("Connected", board.For("mqtt")!.State);

        board.Report("mqtt", StatusBoard.ComponentKind.Broker, new ComponentReport(Ok: false, Detail: "broker:1883"));
        var card = board.For("mqtt")!;
        Assert.Equal(StatusLevel.Bad, card.Level);
        Assert.Equal("Disconnected", card.State);
    }

    [Fact]
    public void ADeviceThatHasNeverPolled_IsWaiting_NotBroken()
    {
        // A PDU configured a moment ago has nothing wrong with it — reporting it red is how a fresh install
        // looks broken.
        var board = new StatusBoard();
        board.Report("pdu:new", StatusBoard.ComponentKind.Device, new ComponentReport(IntervalSeconds: 30));

        var card = board.For("pdu:new")!;
        Assert.Equal(StatusLevel.Warn, card.Level);
        Assert.Equal("No data yet", card.State);
    }

    [Fact]
    public void AComponentNobodyHasReported_HasNoCardAtAll()
    {
        // Not green, not grey — absent. Inventing a card for something never reported is claiming knowledge
        // the board does not have.
        var board = new StatusBoard();

        Assert.Null(board.For("mqtt"));
        Assert.Empty(board.Board());
    }
}
