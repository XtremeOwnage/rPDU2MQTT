using rPDU2MQTT.Core.History;
using rPDU2MQTT.Plugin.EmonCms;
using Xunit;

namespace rPDU2MQTT.Tests;

/// <summary>Another system's history copied into the local store: every tier that keeps it, and only its gaps.</summary>
public class LocalHistoryImportTests : IDisposable
{
    private readonly string root = Path.Combine(Path.GetTempPath(), "rpdu-import-" + Guid.NewGuid().ToString("N")[..8]);

    public void Dispose()
    {
        try { if (Directory.Exists(root)) Directory.Delete(root, recursive: true); } catch (IOException) { }
    }

    private static readonly DateTime Now = new(2026, 9, 27, 12, 0, 0, DateTimeKind.Utc);

    private LocalSeriesStore Store() => new(root, rawIntervalSeconds: 10, rawKeepDays: 7, minuteKeepDays: 90);

    // What one tier holds at a moment, read straight from its file.
    private double InTier(string tier, DateTime at)
    {
        var dir = Path.Combine(root, LocalSeriesStore.FolderFor("grid", "realpower"), tier);
        if (!Directory.Exists(dir)) return double.NaN;
        foreach (var path in Directory.GetFiles(dir, "*.rts"))
        {
            var file = SeriesFile.Open(path)!;
            var slot = file.SlotOf(at);
            if (slot >= 0 && slot < file.Slots() && file.TimeOf(slot) <= at && file.TimeOf(slot + 1) > at) return file.Read(slot, 1)[0];
        }
        return double.NaN;
    }

    [Fact]
    public void EachTierTakesTheReadingsItKeeps()
    {
        var store = Store();
        var recent = Now.AddDays(-2);
        var old = Now.AddDays(-30);
        store.Import("grid", "realpower",
            [(recent, 100), (recent.AddSeconds(10), 110), (recent.AddSeconds(20), 120), (old, 500), (old.AddSeconds(30), 510)], Now);

        Assert.Equal(100, InTier("raw", recent));
        Assert.Equal(110, InTier("raw", recent.AddSeconds(10)));
        // The raw tier keeps a week; a month-old reading is not put where it would only be trimmed.
        Assert.True(double.IsNaN(InTier("raw", old)));
        // A coarser bucket holds the last reading in it.
        Assert.Equal(120, InTier("minute", recent));
        Assert.Equal(510, InTier("minute", old));
        Assert.Equal(510, InTier("hour", old));
        Assert.Equal(510, InTier("day", old));
    }

    [Fact]
    public void WhatTheBridgeRecordedIsNeverReplaced_AndASecondRunChangesNothing()
    {
        var store = Store();
        var at = Now.AddHours(-3);
        store.Write("grid", "realpower", at, 2400);

        var first = store.Import("grid", "realpower", [(at, 999), (at.AddSeconds(10), 2450)], Now);
        Assert.Equal(2400, InTier("raw", at));
        Assert.Equal(2450, InTier("raw", at.AddSeconds(10)));
        Assert.True(first > 0);

        Assert.Equal(0, store.Import("grid", "realpower", [(at, 999), (at.AddSeconds(10), 2450)], Now));
    }

    [Fact]
    public void AReadingAfterNowOrNotANumberIsNotStored()
    {
        var store = Store();
        Assert.Equal(0, store.Import("grid", "realpower", [(Now.AddMinutes(5), 1), (Now.AddHours(-1), double.NaN)], Now));
    }

    [Fact]
    public void AFeedReadKeepsItsRealPointsInOrder_AndDropsTheGaps()
    {
        var points = EmonCmsWire.Points("[[3000,3.5],[1000,null],[2000,\"2\"],[4000,1]]");
        Assert.Equal([(2000L, 2d), (3000L, 3.5), (4000L, 1d)], points);
        Assert.Empty(EmonCmsWire.Points("{\"success\":false}"));
    }
}
