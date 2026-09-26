using rPDU2MQTT.Core;
using Xunit;

namespace rPDU2MQTT.Tests;

/// <summary>
/// What the bridge writes to, and the room left where it sits. A volume that did not mount, or one that is
/// full or read-only, otherwise looks like readings quietly not being kept.
/// </summary>
public class StorageUsageTests : IDisposable
{
    private readonly string root = Path.Combine(Path.GetTempPath(), "rpdu-storage-" + Guid.NewGuid().ToString("N")[..8]);

    public void Dispose()
    {
        try { if (Directory.Exists(root)) Directory.Delete(root, recursive: true); } catch (IOException) { }
    }

    [Fact]
    public void ADirectoryIsReportedWithWhatItHolds()
    {
        Directory.CreateDirectory(Path.Combine(root, "series", "raw"));
        File.WriteAllBytes(Path.Combine(root, "series", "raw", "a.rts"), new byte[1024]);
        File.WriteAllBytes(Path.Combine(root, "series", "raw", "b.rts"), new byte[512]);

        var use = StorageUsage.For("History", root);

        Assert.True(use.Exists);
        Assert.True(use.Writable);
        Assert.Equal(1536, use.Bytes);       // counted, not estimated, and through subdirectories
        Assert.Equal(2, use.Files);
        Assert.Equal(Path.GetFullPath(root), use.Path);
    }

    [Fact]
    public void AVolumeThatIsNotThereSaysSo_RatherThanReportingZeroUse()
    {
        var use = StorageUsage.For("History", Path.Combine(root, "never-mounted"));

        Assert.False(use.Exists);
        Assert.False(use.Writable);
        Assert.Equal(0, use.Bytes);
    }

    [Fact]
    public void NoDirectoryConfiguredIsNotADirectory()
    {
        var use = StorageUsage.For("Floor plan images", "");

        Assert.False(use.Exists);
        Assert.Equal("", use.Path);
    }

    /// <summary>The mount the directory is on, not the root filesystem it happens to sit inside.</summary>
    [Fact]
    public void TheMountUnderTheDirectoryIsReportedWithItsFreeSpace()
    {
        Directory.CreateDirectory(root);

        var use = StorageUsage.For("History", root);

        Assert.NotNull(use.Mount);
        Assert.True(use.TotalBytes > 0, "the volume's size was not read");
        Assert.True(use.FreeBytes > 0, "the free space was not read");
        Assert.True(use.FreeBytes <= use.TotalBytes);
        // The mount is a prefix of the directory: the longest one, where volumes are nested.
        Assert.StartsWith(use.Mount!.TrimEnd(Path.DirectorySeparatorChar), use.Path, StringComparison.Ordinal);
    }

    private static StorageUse Volume(long free, long total, string name = "History", bool exists = true, bool writable = true, bool mustWrite = true)
        => new(name, "/data/" + name, exists, writable, 0, 0, "/data", total, free, mustWrite);

    private const long GB = 1L << 30;

    [Theory]
    [InlineData(5 * GB, 10 * GB, StorageState.Ok)]
    [InlineData(GB / 2 + 1, 10 * GB, StorageState.Low)]    // just over 5% free
    [InlineData(GB / 5, 10 * GB, StorageState.Full)]       // 2% free
    [InlineData(32L << 20, 100L << 20, StorageState.Full)] // a third free, but under 64 MB: full whatever its size
    [InlineData(0, 0, StorageState.Ok)]                    // size unreadable: nothing to judge by
    public void RoomIsJudgedByShareFreeAndAFloor(long free, long total, StorageState expected)
        => Assert.Equal(expected, StorageUsage.Room(free, total));

    /// <summary>A volume that did not mount reports the root filesystem's free space — plenty of it.</summary>
    [Fact]
    public void MissingAndReadOnlyOutrankFreeSpace()
    {
        Assert.Equal(StorageState.Missing, StorageUsage.StateOf(Volume(9 * GB, 10 * GB, exists: false, writable: false)));
        Assert.Equal(StorageState.ReadOnly, StorageUsage.StateOf(Volume(9 * GB, 10 * GB, writable: false)));
    }

    /// <summary>Plugins are only read: shipped read-only, or on a busy root filesystem, is not a fault.</summary>
    [Fact]
    public void ADirectoryOnlyReadIsNotFaultedForBeingReadOnlyOrFull()
        => Assert.Equal(StorageState.Ok, StorageUsage.StateOf(Volume(GB / 100, 10 * GB, "Plugins", writable: false, mustWrite: false)));

    [Fact]
    public void TheWorstDirectoryIsTheOneThatNeedsAttention()
    {
        var worst = StorageUsage.Worst([
            Volume(9 * GB, 10 * GB, "History"),
            Volume(GB / 2 + 1, 10 * GB, "Floor plan images"),
            Volume(GB / 100, 10 * GB, "Plugins", mustWrite: false),
        ]);

        Assert.Equal("Floor plan images", worst!.Name);
        Assert.Contains("free of 10.0 GB", StorageUsage.Describe(worst));
    }
}
