using rPDU2MQTT.Classes;
using rPDU2MQTT.Core;
using rPDU2MQTT.Models.Config;
using Xunit;

namespace rPDU2MQTT.Tests;

/// <summary>
/// #205: a published measurement carries the time it was read. The default carries it where nothing can
/// trip over it (an MQTT v5 user property); Payload mode puts it in the message, and discovery has to move
/// with it or Home Assistant reads the whole JSON document as the state.
/// </summary>
public class MessageTimestampTests
{
    private static readonly DateTime Read = new(2026, 7, 21, 18, 30, 15, 250, DateTimeKind.Utc);

    [Fact]
    public void Default_LeavesThePayloadAlone()
    {
        // The whole point of the default: every existing consumer keeps reading a bare value.
        Assert.Equal("123.4", MessageTimestamps.Payload("123.4", Read, MessageTimestampMode.UserProperty));
        Assert.Equal("123.4", MessageTimestamps.Payload("123.4", Read, MessageTimestampMode.None));
        Assert.Equal("{{ value }}", MessageTimestamps.ValueTemplate(MessageTimestampMode.UserProperty));
        Assert.Equal("{{ value }}", MessageTimestamps.ValueTemplate(MessageTimestampMode.None));
    }

    [Fact]
    public void PayloadMode_CarriesValueAndTimestamp_AndDiscoveryFollows()
    {
        var payload = MessageTimestamps.Payload("123.4", Read, MessageTimestampMode.Payload);

        using var doc = System.Text.Json.JsonDocument.Parse(payload);
        Assert.Equal("123.4", doc.RootElement.GetProperty("value").GetString());
        Assert.Equal("2026-07-21T18:30:15.250Z", doc.RootElement.GetProperty("timestamp").GetString());

        // Home Assistant has to be told where the value moved to.
        Assert.Equal("{{ value_json.value }}", MessageTimestamps.ValueTemplate(MessageTimestampMode.Payload));
    }

    [Fact]
    public void Value_StaysAString_SoDevicePrecisionSurvives()
    {
        // "0.00" means the device reported two decimals; re-typing it as a number would throw that away.
        var payload = MessageTimestamps.Payload("0.00", Read, MessageTimestampMode.Payload);
        Assert.Contains("\"value\":\"0.00\"", payload);
    }

    [Fact]
    public void Timestamp_IsIso8601Utc_ToMilliseconds()
    {
        Assert.Equal("2026-07-21T18:30:15.250Z", MessageTimestamps.Format(Read));

        // A local time is normalised rather than published as-is with the wrong meaning.
        var local = new DateTime(2026, 7, 21, 18, 30, 15, 250, DateTimeKind.Utc).ToLocalTime();
        Assert.Equal("2026-07-21T18:30:15.250Z", MessageTimestamps.Format(local));
    }

    [Fact]
    public void NoReadTime_FallsBackToNow_RatherThanEmpty()
    {
        var payload = MessageTimestamps.Payload("1", null, MessageTimestampMode.Payload);
        using var doc = System.Text.Json.JsonDocument.Parse(payload);
        var stamp = doc.RootElement.GetProperty("timestamp").GetString();

        Assert.False(string.IsNullOrWhiteSpace(stamp));
        Assert.True(DateTime.TryParse(stamp, System.Globalization.CultureInfo.InvariantCulture,
            System.Globalization.DateTimeStyles.AdjustToUniversal, out var parsed));
        Assert.True((DateTime.UtcNow - parsed).Duration() < TimeSpan.FromMinutes(1));
    }

    [Fact]
    public void DefaultMode_ChangesNothingOnTheWire()
    {
        // This shipped defaulting to UserProperty on the reasoning that a user property is invisible to
        // consumers that don't read it — which is true of readers and irrelevant to the wire. It broke
        // publishing outright on a real broker. A mode that changes the packet has to be opted into by
        // someone who can watch their own broker while they do it.
        Assert.Equal(MessageTimestampMode.None, new Config().MQTT.MessageTimestamp);
    }
}
