using rPDU2MQTT.Core.History;
using Xunit;

namespace rPDU2MQTT.Tests;

/// <summary>
/// The bridge's own history (#502): fixed-interval files, a slot found by arithmetic, and "no reading"
/// stored as no reading rather than a zero.
/// </summary>
public class LocalHistoryStoreTests : IDisposable
{
    private readonly string root = Path.Combine(Path.GetTempPath(), "rpdu-history-" + Guid.NewGuid().ToString("N")[..8]);

    public void Dispose()
    {
        try { if (Directory.Exists(root)) Directory.Delete(root, recursive: true); } catch (IOException) { }
    }

    private LocalSeriesStore Store(int interval = 10) => new(root, rawIntervalSeconds: interval, toleranceSeconds: 30);

    private static DateTime At(int hour, int minute = 0, int second = 0)
        => new(2026, 9, 20, hour, minute, second, DateTimeKind.Utc);

    [Fact]
    public void AReadingIsReadBackAtTheMomentItWasTaken()
    {
        var store = Store();
        store.Write("main_panel", "realpower", At(10), 2400);

        Assert.Equal(2400, store.ValueAt("main_panel", "realpower", At(10), At(11)));
    }

    [Fact]
    public void ASlotNobodyWroteIsNoReading_NotAZero()
    {
        var store = Store();
        store.Write("main_panel", "realpower", At(10), 2400);

        // Well past the look-back: the node stopped reporting, which is not the same as reporting zero.
        Assert.True(double.IsNaN(store.ValueAt("main_panel", "realpower", At(12), At(12))));
        // …and a series nobody has written at all has nothing either.
        Assert.True(double.IsNaN(store.ValueAt("nothing", "realpower", At(10), At(11))));
    }

    [Fact]
    public void AReadingStandsUntilTheNextOne_ButNotForever()
    {
        var store = Store(interval: 10);
        store.Write("grid", "realpower", At(10, 0, 0), 800);

        // Within the look-back the reading is what was standing.
        Assert.Equal(800, store.ValueAt("grid", "realpower", At(10, 0, 25), At(11)));
        // Beyond it, nothing is claimed.
        Assert.True(double.IsNaN(store.ValueAt("grid", "realpower", At(10, 5, 0), At(11))));
    }

    [Fact]
    public void EachStepTakesItsOwnReading()
    {
        var store = Store();
        var steps = Enumerable.Range(0, 6).Select(i => At(10, i * 10)).ToList();
        for (var i = 0; i < steps.Count; i++) store.Write("main_panel", "realpower", steps[i], 100 * (i + 1));

        var series = store.Series("main_panel", "realpower", steps, At(12));

        Assert.Equal([100d, 200, 300, 400, 500, 600], series);
    }

    [Fact]
    public void AStepWithNothingAroundIt_IsAGapInTheSeries()
    {
        var store = Store();
        var steps = new[] { At(10), At(11), At(12) };
        store.Write("main_panel", "realpower", At(10), 100);
        store.Write("main_panel", "realpower", At(12), 300);

        var series = store.Series("main_panel", "realpower", steps, At(13));

        Assert.Equal(100, series[0]);
        Assert.True(double.IsNaN(series[1]));
        Assert.Equal(300, series[2]);
    }

    /// <summary>A day's file ends at midnight; the reading standing then was written in the one before it.</summary>
    [Fact]
    public void AReadingCarriesAcrossTheChunkItWasWrittenIn()
    {
        var store = Store();
        var lastOfDay = new DateTime(2026, 9, 20, 23, 59, 55, DateTimeKind.Utc);
        store.Write("main_panel", "energy", lastOfDay, 1234.5);

        var midnight = new DateTime(2026, 9, 21, 0, 0, 0, DateTimeKind.Utc);
        Assert.Equal(1234.5, store.ValueAt("main_panel", "energy", midnight, midnight.AddHours(1)));
    }

    [Fact]
    public void TheCoarserTiersTakeTheLastReadingOfEachBucket()
    {
        var store = Store();
        // Three readings inside one minute: the minute is worth the last of them, not their average.
        store.Write("main_panel", "realpower", At(10, 0, 10), 100);
        store.Write("main_panel", "realpower", At(10, 0, 30), 200);
        store.Write("main_panel", "realpower", At(10, 0, 50), 300);

        store.Rollup("main_panel", "realpower", At(11));

        var minute = store.Tiers[1];
        Assert.Equal(60, minute.IntervalSeconds);
        // Read back through the tier the store would pick for a window of minutes over a long range.
        var steps = new[] { At(10, 1) };
        Assert.Equal(300, store.Series("main_panel", "realpower", steps, At(11))[0]);
    }

    [Fact]
    public void AWindowOlderThanTheRawTierKeeps_IsAnsweredFromACoarserOne()
    {
        var store = Store();
        var now = new DateTime(2026, 9, 20, 12, 0, 0, DateTimeKind.Utc);

        // A month of daily steps: the raw tier is not kept that long, and a day is coarser than a minute.
        Assert.Equal("hour", store.TierFor(now.AddDays(-30), 86400, now).Name);
        // A few hours of five-minute steps: the minute tier is as fine as that question needs.
        Assert.Equal("minute", store.TierFor(now.AddHours(-3), 300, now).Name);
        // …but not at a step finer than it stores.
        Assert.Equal("raw", store.TierFor(now.AddHours(-3), 1, now).Name);
    }

    [Fact]
    public void RetentionDeletesWholeChunks_AndKeepsTheRecentOnes()
    {
        var store = new LocalSeriesStore(root, rawIntervalSeconds: 10, rawKeepDays: 2);
        var now = new DateTime(2026, 9, 20, 12, 0, 0, DateTimeKind.Utc);
        store.Write("main_panel", "realpower", now.AddDays(-10), 100);
        store.Write("main_panel", "realpower", now, 200);

        var gone = store.Trim(now);

        Assert.Equal(1, gone);
        Assert.Equal(200, store.ValueAt("main_panel", "realpower", now, now));
        Assert.True(double.IsNaN(store.ValueAt("main_panel", "realpower", now.AddDays(-10), now)));
    }

    [Fact]
    public void TwoSeriesNeverShareAFolder_HoweverTheirIdsAreSpelled()
    {
        // Ids the filesystem would argue about, and two that clean to the same name.
        Assert.NotEqual(LocalSeriesStore.FolderFor("outlet:pdu:1", "realpower"), LocalSeriesStore.FolderFor("outlet/pdu/1", "realpower"));
        Assert.NotEqual(LocalSeriesStore.FolderFor("main", "energy"), LocalSeriesStore.FolderFor("main", "energy_d"));
        Assert.DoesNotContain(':', LocalSeriesStore.FolderFor("outlet:pdu:1", "realpower"));
        Assert.DoesNotContain('#', LocalSeriesStore.FolderFor("main#in", "energy"));
    }

    [Fact]
    public void AFileThatIsNotOursIsNotRead()
    {
        Directory.CreateDirectory(root);
        var path = Path.Combine(root, "foreign.rts");
        File.WriteAllText(path, "this is not a series file, but it is long enough to look like one");

        Assert.Null(SeriesFile.Open(path));
    }

    [Fact]
    public void AChunksHeaderSurvivesBeingReopened()
    {
        Directory.CreateDirectory(root);
        var path = Path.Combine(root, "series.rts");
        var start = At(0);
        var written = SeriesFile.Create(path, 10, start);
        written.Write(6, 42);

        var reopened = SeriesFile.Open(path)!;
        Assert.Equal(10, reopened.IntervalSeconds);
        Assert.Equal(start, reopened.Start);
        Assert.Equal(6, reopened.SlotOf(At(0, 1, 5)));
        Assert.Equal(42, reopened.Read(6, 1)[0]);
        // The slots skipped on the way there are gaps, not zeros.
        Assert.All(reopened.Read(0, 6), v => Assert.True(double.IsNaN(v)));
    }

    [Fact]
    public void ASweepWritesEveryNodesReadingAtOnce()
    {
        var store = Store();
        store.WriteSweep(At(10), [("a", "realpower", 1), ("b", "realpower", 2), ("a", "energy", 3)]);

        Assert.Equal(1, store.ValueAt("a", "realpower", At(10), At(11)));
        Assert.Equal(2, store.ValueAt("b", "realpower", At(10), At(11)));
        Assert.Equal(3, store.ValueAt("a", "energy", At(10), At(11)));
    }
}
