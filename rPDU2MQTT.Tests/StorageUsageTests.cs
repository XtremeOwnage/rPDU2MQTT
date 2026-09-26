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
}
