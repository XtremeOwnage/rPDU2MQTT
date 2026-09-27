using rPDU2MQTT.Core.Flow;
using rPDU2MQTT.Services.Gui;
using Xunit;

namespace rPDU2MQTT.Tests;

/// <summary>
/// The readings behind the Circuit Finder (#494): recorded on the server for as long as the page keeps asking,
/// so a tap is a timestamp and a state is every reading between two taps.
/// </summary>
public class CircuitSamplerTests
{
    private static readonly DateTime T0 = new(2026, 9, 27, 12, 0, 0, DateTimeKind.Utc);

    private static FlowNode[] Channels(double kitchen, double garage) =>
    [
        new("n30_2", "Kitchen", "breaker", kitchen),
        new("n30_3", "Garage", "breaker", garage),
        new("main_panel#unmeasured", "Unmeasured load", "unmeasured", 400),
        new("n30_9", "Dead channel", "breaker", null),
    ];

    [Fact]
    public void ARepeatedPollIsOneReading_NotTwo()
    {
        var s = new CircuitSampler();
        Assert.True(s.Record(T0, Channels(100, 50)));
        Assert.False(s.Record(T0.AddSeconds(1), Channels(100, 50)));   // the same poll, read again
        Assert.True(s.Record(T0.AddSeconds(5), Channels(102, 50)));

        var (samples, channels) = s.Since(DateTime.MinValue);
        Assert.Equal(2, samples.Count);
        // Channels a load can sit on, with their names; not the builder's remainder, and not one with no reading.
        Assert.Equal(["n30_2", "n30_3"], samples[0].Values.Keys.OrderBy(k => k));
        Assert.Equal("Kitchen", channels["n30_2"].Label);
        Assert.False(channels.ContainsKey("main_panel#unmeasured"));
    }

    [Fact]
    public void ReadingsAreKeptForHalfAnHour_AndReadBackFromAPoint()
    {
        var s = new CircuitSampler();
        for (var i = 0; i <= 40; i++) s.Record(T0.AddMinutes(i), Channels(100 + i, 50));

        var all = s.Since(DateTime.MinValue).Samples;
        Assert.True(all[0].At >= T0.AddMinutes(40) - CircuitSampler.Keep);
        Assert.Equal(T0.AddMinutes(40), all[^1].At);

        // The page asks for what it has not seen yet.
        Assert.Equal(2, s.Since(T0.AddMinutes(38)).Samples.Count);
    }

    [Fact]
    public void RecordingRunsWhileThePageKeepsAsking_AndOneRecorderAtATime()
    {
        var s = new CircuitSampler();
        Assert.True(s.Arm(T0));                     // nothing recording: the caller starts it
        Assert.False(s.Arm(T0.AddMinutes(1)));      // already recording: this only extends it
        Assert.True(s.KeepGoing(T0.AddMinutes(10)));
        Assert.False(s.KeepGoing(T0.AddMinutes(12)));   // ten minutes after the last ask, it stops

        Assert.True(s.Arm(T0.AddMinutes(13)));      // and the next ask starts it again
    }
}
