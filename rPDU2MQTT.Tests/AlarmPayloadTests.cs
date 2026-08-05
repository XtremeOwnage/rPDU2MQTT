using System.Text.Json;
using rPDU2MQTT.Core;
using rPDU2MQTT.Models.PDU;
using Xunit;

namespace rPDU2MQTT.Tests;

/// <summary>
/// Home Assistant reads the alarm state through <c>{{ 'OFF' if value == 'none' else 'ON' }}</c>, so
/// anything that isn't exactly "none" shows as an active problem. Every payload shape below is therefore a
/// question of whether the bridge raises an alarm nobody raised.
/// </summary>
public class AlarmPayloadTests
{
    private static Alarm A(string? state = null, string? severity = null) =>
        new() { State = state!, Severity = severity! };

    [Fact]
    public void NoAlarmObject_IsClear()
        => Assert.Equal("none", AlarmPayload.State(null));

    [Fact]
    public void AnEmptyState_IsClear_NotAProblem()
    {
        // The one that would bite: publishing "" verbatim makes HA's template say ON, so a PDU that
        // declines to fill the field lights up an alarm on a perfectly healthy outlet.
        Assert.Equal("none", AlarmPayload.State(A(state: "")));
        Assert.Equal("none", AlarmPayload.State(A(state: "   ")));
    }

    [Fact]
    public void ARealState_IsPassedThroughAsThePduStatedIt()
    {
        Assert.Equal("alarm", AlarmPayload.State(A(state: "alarm")));
        Assert.Equal("none", AlarmPayload.State(A(state: "none")));
        // Surrounding whitespace would otherwise make "none " read as an active alarm.
        Assert.Equal("none", AlarmPayload.State(A(state: " none ")));
    }

    [Fact]
    public void SeverityIsNeverInvented()
    {
        // The field an operator uses to decide whether to care. Defaulting it to either value states
        // something the PDU never said.
        Assert.Equal("{}", AlarmPayload.Attributes(null));
        Assert.Equal("{}", AlarmPayload.Attributes(A(state: "alarm")));
        Assert.Equal("{}", AlarmPayload.Attributes(A(state: "alarm", severity: "  ")));
    }

    [Fact]
    public void SeverityIsCarried_WhenTheDeviceStatesIt()
    {
        var json = AlarmPayload.Attributes(A(state: "alarm", severity: "warning"));
        Assert.Equal("warning", JsonDocument.Parse(json).RootElement.GetProperty("severity").GetString());
    }

    [Fact]
    public void AttributesAreAlwaysAParseableObject()
    {
        // HA discards an attributes payload it cannot read as an object — and leaves the previous value
        // showing, which is how a cleared alarm keeps a stale severity beside it.
        foreach (var alarm in new Alarm?[] { null, A(), A(state: "alarm"), A(state: "alarm", severity: "alarm") })
            Assert.Equal(JsonValueKind.Object, JsonDocument.Parse(AlarmPayload.Attributes(alarm)).RootElement.ValueKind);
    }

    [Fact]
    public void AClearAlarmIsStillReported_BecauseTheThresholdExists()
    {
        // A measurement the PDU watches and is currently happy with is worth an entity: it says the limit
        // is configured. A measurement with no alarm object at all is not — that would put an always-off
        // "problem" on every reading of every outlet.
        Assert.True(AlarmPayload.Reported(A(state: "none")));
        Assert.True(AlarmPayload.Reported(A()));
        Assert.False(AlarmPayload.Reported(null));
    }
}
