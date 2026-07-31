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
