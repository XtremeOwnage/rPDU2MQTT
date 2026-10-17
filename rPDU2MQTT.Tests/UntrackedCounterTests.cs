using rPDU2MQTT.Core.Flow;
using Xunit;

/// <summary>An untracked slice's live lifetime total: what the parent rose beyond its tracked siblings.</summary>
public class UntrackedCounterTests
{
    private static readonly UntrackedSeries.Plan Sub = new("sub_untracked", "sub", ["b1", "b2"]);

    private static double? Step(UntrackedCounter c, double? sub, double? b1, double? b2)
    {
        var r = new Dictionary<string, double?> { ["sub"] = sub, ["b1"] = b1, ["b2"] = b2 };
        return c.Advance(Sub, id => r[id]);
    }

    [Fact]
    public void AddsWhatTheParentRoseBeyondItsSiblings()
    {
        var c = new UntrackedCounter();
        Assert.Equal(0, Step(c, 1000, 600, 300));
        Assert.Equal(2, Step(c, 1010, 605, 303));
        Assert.Equal(3, Step(c, 1012, 606, 303));
    }

    [Fact]
    public void SiblingsReadingHigh_HoldTheTotal_RatherThanTakingItBack()
    {
        var c = new UntrackedCounter();
        Step(c, 1000, 600, 300);
        Assert.Equal(0, Step(c, 1001, 601, 301));
    }

    [Fact]
    public void ASiblingThatStartsReporting_IsNotBookedAsUntracked()
    {
        var c = new UntrackedCounter();
        Step(c, 1000, 600, null);
        Step(c, 1010, 605, null);              // b2 not yet bound: its draw is untracked
        Assert.Equal(5, Step(c, 1020, 610, 700));  // b2's first reading has nothing to rise from: uncounted
        Assert.Equal(6, Step(c, 1025, 612, 702));
    }

    [Fact]
    public void ASiblingThatStops_IsAGap_NotItsDrawMovedToUntracked()
    {
        var c = new UntrackedCounter();
        Step(c, 1000, 600, 300);
        Assert.Equal(0, Step(c, 1010, 605, null));
        Assert.Equal(0, Step(c, 1020, 610, 305));   // back, re-baselined
        Assert.Equal(1, Step(c, 1030, 615, 309));
    }

    [Fact]
    public void ACounterThatFalls_IsReBaselined_NotReadAsAReset()
    {
        var c = new UntrackedCounter();
        Step(c, 1000, 600, 300);
        Assert.Equal(0, Step(c, 5, 605, 303));      // parent counter restarted
        Assert.Equal(2, Step(c, 15, 610, 306));
    }

    [Fact]
    public void NoParentReading_KeepsTheTotal()
    {
        var c = new UntrackedCounter();
        Assert.Null(Step(c, null, 600, 300));
        Step(c, 1000, 600, 300);
        Step(c, 1010, 605, 303);
        Assert.Equal(2, Step(c, null, 606, 304));
        Assert.Equal(2, Step(c, 1020, 607, 305));   // first step after the gap only re-baselines
    }

    [Fact]
    public void PublishedThroughContinue_ItCarriesOnFromTheMarkAlreadyPublished()
    {
        var export = new CumulativeExport();
        Assert.Equal(995, export.Publish("sub_untracked|energy", 995));
        var c = new UntrackedCounter();
        Assert.Equal(995, export.Continue("sub_untracked|energy", Step(c, 1000, 600, 300)));
        Assert.Equal(997, export.Continue("sub_untracked|energy", Step(c, 1010, 605, 303)));
    }
}
