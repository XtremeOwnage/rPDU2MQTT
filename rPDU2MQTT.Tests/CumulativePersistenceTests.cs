using rPDU2MQTT.Core.Flow;
using Xunit;

namespace rPDU2MQTT.Tests;

/// <summary>
/// The high-water marks have to outlive the process.
///
/// <para>
/// Reported from a live Home Assistant Energy Dashboard reading 6.5 MWh of solar in a week against a system
/// generating about 60 kWh a day. The guard that stops a <c>total_increasing</c> sensor going backwards held
/// its peaks in memory only, so every restart re-baselined it: the next pass published whatever the raw
/// counter happened to read, and where that sat below what had already gone out, Home Assistant recorded a
/// meter reset and counted the whole climb again. That bridge had restarted seventeen times that week.
/// </para>
/// </summary>
public class CumulativePersistenceTests
{
    /// <summary>A store that keeps what it is given, as a real one does across a restart.</summary>
    private sealed class Disk : IEnergyStore
    {
        public Dictionary<string, double> Peaks = new();
        public int Writes;
        public IReadOnlyDictionary<string, EnergyState> Load() => new Dictionary<string, EnergyState>();
        public void Save(IReadOnlyDictionary<string, EnergyState> states) { }
        public IReadOnlyDictionary<string, double> LoadPeaks() => Peaks;
        public void SavePeaks(IReadOnlyDictionary<string, double> peaks)
        {
            Peaks = new Dictionary<string, double>(peaks);
            Writes++;
        }
    }

    [Fact]
    public void APeakSurvivesARestart()
    {
        var disk = new Disk();

        // Before: the counter climbs to 416.8 and that is what has gone out.
        var before = new CumulativeExport(disk);
        Assert.Equal(416.8, before.Publish("solar|energy", 416.8));

        // The counter resets, then the process restarts before it has climbed back.
        var after = new CumulativeExport(disk);
        Assert.Null(after.Publish("solar|energy", 30));

        var withheld = Assert.Single(after.Withheld);
        Assert.Contains("416.8", withheld.Reason);
    }

    /// <summary>Without a store this is exactly the bug: the restart republishes the low reading.</summary>
    [Fact]
    public void WithoutAStoreTheRestartRepublishesTheLowReading()
    {
        var before = new CumulativeExport();
        before.Publish("solar|energy", 416.8);

        var after = new CumulativeExport();
        Assert.Equal(30, after.Publish("solar|energy", 30));
    }

    [Fact]
    public void OnlyAMovedMarkIsWritten()
    {
        var disk = new Disk();
        var guard = new CumulativeExport(disk);

        guard.Publish("a|energy", 10);
        var afterFirst = disk.Writes;
        guard.Publish("a|energy", 10);            // unchanged — nothing to persist
        Assert.Equal(afterFirst, disk.Writes);

        guard.Publish("a|energy", 11);            // moved
        Assert.Equal(afterFirst + 1, disk.Writes);
    }

    [Fact]
    public void EveryKeyIsKeptSeparately()
    {
        var disk = new Disk();
        var before = new CumulativeExport(disk);
        before.Publish("solar|energy", 400);
        before.Publish("grid|energy", 150);

        var after = new CumulativeExport(disk);
        Assert.Null(after.Publish("solar|energy", 20));     // held
        Assert.Equal(160, after.Publish("grid|energy", 160)); // still climbing, still published
    }
}
