using rPDU2MQTT.Core.Flow;
using Xunit;

namespace rPDU2MQTT.Tests;

public class EnergyStoreTests : IDisposable
{
    private readonly string dir = Path.Combine(Path.GetTempPath(), "rpdu-energy-" + Guid.NewGuid().ToString("N")[..8]);
    private string Path_ => Path.Combine(dir, "energy.json");
    public void Dispose() { try { Directory.Delete(dir, true); } catch { } }

    [Fact]
    public void TotalsSurviveARestart()
    {
        // The whole reason a file exists: a counter that resets reads downstream as a meter reset and
        // corrupts history that was already recorded correctly.
        var at = new DateTime(2026, 7, 30, 12, 0, 0, DateTimeKind.Utc);
        new FileEnergyStore(Path_).Save(new Dictionary<string, EnergyState>
        {
            ["solar"] = new(12.5, at, 1000, 0),
            ["grid"] = new(0.25, at, 40, 90),
        });

        var reloaded = new FileEnergyStore(Path_).Load();   // a fresh instance, as a restart would build

        Assert.Equal(12.5, reloaded["solar"].KWh);
        Assert.Equal(at, reloaded["solar"].LastSampleUtc);
        Assert.Equal(1000, reloaded["solar"].LastPowerW);
        Assert.Equal(90, reloaded["grid"].UnmeasuredSeconds);
    }

    [Fact]
    public void ThePeriodBaselineSurvivesARestart_SoADailyTotalDoesNotRestartWithTheProcess()
    {
        // The baseline is the only record of where today began. Losing it on restart would silently reset
        // every daily figure to zero mid-afternoon — which reads as "nothing has run today", and is the kind
        // of thing that looks fine until someone checks the numbers against the meter.
        var at = new DateTime(2026, 8, 1, 14, 0, 0, DateTimeKind.Utc);
        new FileEnergyStore(Path_).Save(new Dictionary<string, EnergyState>
        {
            ["outlet:rack_pdu_1:3"] = new(43.5, at, 0, 0, "2026-08-01", 31.0, 7371.006),
        });

        var s = new FileEnergyStore(Path_).Load()["outlet:rack_pdu_1:3"];

        Assert.Equal("2026-08-01", s.PeriodKey);
        Assert.Equal(31.0, s.PeriodStartKWh);
        Assert.Equal(7371.006, s.LastCounterKWh!.Value, 6);
        Assert.Equal(12.5, s.PeriodKWh, 6);
    }

    [Fact]
    public void StateWrittenBeforePeriodsExisted_LoadsWithoutAPeriod_RatherThanClaimingOne()
    {
        // An upgrade must not invent a baseline. A null key means "no period established yet"; the next
        // sample sets one, and today's figure starts from that moment instead of from a made-up zero.
        Directory.CreateDirectory(dir);
        File.WriteAllText(Path_, """{"solar":{"KWh":42.0,"LastSampleUtc":"2026-07-31T12:00:00Z","LastPowerW":1000,"UnmeasuredSeconds":0}}""");

        var s = new FileEnergyStore(Path_).Load()["solar"];

        Assert.Equal(42.0, s.KWh);
        Assert.Null(s.PeriodKey);
        Assert.Null(s.LastCounterKWh);
    }

    [Fact]
    public void AMissingFile_StartsEmptyWithoutComplaint()
    {
        var warnings = new List<string>();
        var states = new FileEnergyStore(Path_, warnings.Add).Load();

        Assert.Empty(states);
        Assert.Empty(warnings);   // a first run is not a fault
    }

    [Fact]
    public void ACorruptFile_StartsEmptyButSaysSo()
    {
        // Silently restarting from zero would look exactly like a meter reset to Home Assistant, and the
        // lost totals cannot be reconstructed from anything else — so it has to be loud.
        Directory.CreateDirectory(dir);
        File.WriteAllText(Path_, "{ this is not json");
        var warnings = new List<string>();

        var states = new FileEnergyStore(Path_, warnings.Add).Load();

        Assert.Empty(states);
        Assert.Single(warnings);
        Assert.Contains("meter reset", warnings[0]);
    }

    [Fact]
    public void SavingTwice_LeavesNoTempFileBehind()
    {
        var store = new FileEnergyStore(Path_);
        store.Save(new Dictionary<string, EnergyState> { ["a"] = new(1, DateTime.UtcNow, 10, 0) });
        store.Save(new Dictionary<string, EnergyState> { ["a"] = new(2, DateTime.UtcNow, 10, 0) });

        Assert.Equal(2, store.Load()["a"].KWh);
        Assert.False(File.Exists(Path_ + ".tmp"), "the temp file used for the atomic write was left behind");
    }
}
