using rPDU2MQTT.Classes;

namespace rPDU2MQTT.Core;

/// <summary>What one directory the bridge writes to is holding, and how much room is left where it sits.</summary>
/// <param name="Name">What the directory is for, as the Diagnostics page names it.</param>
/// <param name="Path">The directory itself.</param>
/// <param name="Exists">Whether it is there at all — a volume that failed to mount is not.</param>
/// <param name="Writable">Whether this process can write to it. A read-only mount reads fine and stores nothing.</param>
/// <param name="Bytes">What this directory holds, counted from its own files.</param>
/// <param name="Files">How many files that is.</param>
/// <param name="Mount">The mount the directory sits on, when one can be told apart from the root filesystem.</param>
/// <param name="TotalBytes">Size of that mount, 0 when it could not be read.</param>
/// <param name="FreeBytes">Free space on it, 0 when it could not be read.</param>
/// <param name="MustWrite">Whether the bridge writes here. Plugins are only read, so a read-only plugins
/// directory is how many deployments ship it rather than a fault.</param>
public sealed record StorageUse(
    string Name, string Path, bool Exists, bool Writable, long Bytes, int Files,
    string? Mount, long TotalBytes, long FreeBytes, bool MustWrite = true);

/// <summary>How a directory is doing, worst last so the most urgent one sorts to the end.</summary>
public enum StorageState { Ok, Low, Full, ReadOnly, Missing }

/// <summary>
/// Reads what a directory is using and what is left on the volume under it.
///
/// <para>
/// A bridge that stores readings and floor plan images on mounted volumes fails in two ways nothing else
/// reports: the volume is not mounted where the deployment thinks, or it is full. Both look like data
/// quietly not being kept.
/// </para>
/// </summary>
public static class StorageUsage
{
    /// <summary>Below this share of the volume free, it is nearly full.</summary>
    public const double LowFraction = 0.10;

    /// <summary>Below this share free, or <see cref="FullBytes"/>, it is full: writes are about to fail.</summary>
    public const double FullFraction = 0.03;

    /// <summary>Under this much free space a volume is full whatever its size.</summary>
    public const long FullBytes = 64L * 1024 * 1024;

    /// <param name="count">Walk the directory for what it holds. The Status board only needs the room left,
    /// and does not need to read every file on each tick to learn it.</param>
    public static StorageUse For(string name, string? path, bool mustWrite = true, bool count = true)
    {
        if (string.IsNullOrWhiteSpace(path))
            return new StorageUse(name, "", false, false, 0, 0, null, 0, 0, mustWrite);

        var full = System.IO.Path.GetFullPath(path);
        var exists = Directory.Exists(full);
        var (bytes, files) = exists && count ? Contents(full) : (0, 0);
        var (mount, total, free) = Volume(full);
        return new StorageUse(name, full, exists, exists && Writable(full), bytes, files, mount, total, free, mustWrite);
    }

    /// <summary>
    /// Every directory this process writes to or loads from — one list, so the Diagnostics table and the
    /// Status card cannot disagree about which directories there are.
    /// </summary>
    /// <param name="historyRoot">The local history store's directory, when this process keeps one.</param>
    /// <param name="plugins">The plugins directory, reported only when it is there.</param>
    public static IReadOnlyList<StorageUse> Locations(Config config, string? historyRoot, string? plugins, bool count = true)
    {
        var entries = new List<StorageUse>();
        if (!string.IsNullOrWhiteSpace(historyRoot)) entries.Add(For("History", historyRoot, count: count));

        // An object store holds the images instead, and then there is no directory to report.
        var plans = !string.IsNullOrWhiteSpace(config.PlanStorage.Directory) ? config.PlanStorage.Directory
            : Environment.GetEnvironmentVariable("RPDU2MQTT_PLANS_DIRECTORY");
        if (!config.PlanStorage.ObjectStore.IsEnabled() && !string.IsNullOrWhiteSpace(plans))
            entries.Add(For("Floor plan images", plans, count: count));

        if (!string.IsNullOrWhiteSpace(plugins) && Directory.Exists(plugins))
            entries.Add(For("Plugins", plugins, mustWrite: false, count: count));
        return entries;
    }

    /// <summary>
    /// What one directory's condition is. Missing and read-only come first: a volume that did not mount
    /// has plenty of "free space" — the root filesystem's.
    /// </summary>
    public static StorageState StateOf(StorageUse use)
    {
        if (!use.Exists) return StorageState.Missing;
        if (use.MustWrite && !use.Writable) return StorageState.ReadOnly;
        // Only the directories written to can fill up in a way that loses anything.
        return use.MustWrite ? Room(use.FreeBytes, use.TotalBytes) : StorageState.Ok;
    }

    /// <summary>Whether a volume of this size with this much free is fine, nearly full, or full.</summary>
    public static StorageState Room(long freeBytes, long totalBytes)
    {
        if (totalBytes <= 0) return StorageState.Ok;   // unreadable size: nothing to judge by
        var fraction = (double)freeBytes / totalBytes;
        if (freeBytes < FullBytes || fraction < FullFraction) return StorageState.Full;
        return fraction < LowFraction ? StorageState.Low : StorageState.Ok;
    }

    /// <summary>The directory most in need of attention, or null when there are none.</summary>
    public static StorageUse? Worst(IEnumerable<StorageUse> uses)
        => uses
            .OrderByDescending(StateOf)
            // Among equals, the one with the least room: that is the one that fills first.
            .ThenBy(u => u.TotalBytes > 0 ? (double)u.FreeBytes / u.TotalBytes : 1)
            .FirstOrDefault();

    /// <summary>What a card or row says about a directory, in a few words.</summary>
    public static string Describe(StorageUse use) => StateOf(use) switch
    {
        StorageState.Missing => $"{use.Name}: {(use.Path.Length > 0 ? use.Path : "no directory")} does not exist",
        StorageState.ReadOnly => $"{use.Name}: {use.Path} is read-only",
        _ when use.TotalBytes > 0 => $"{use.Name}: {Size(use.FreeBytes)} free of {Size(use.TotalBytes)} ({Percent(use)} free)",
        _ => $"{use.Name}: {use.Path}",
    };

    private static string Percent(StorageUse use) => $"{Math.Floor(100.0 * use.FreeBytes / use.TotalBytes):0}%";

    /// <summary>Bytes as the Diagnostics page shows them.</summary>
    public static string Size(long n)
        => n >= 1L << 30 ? $"{n / (double)(1L << 30):0.0} GB"
         : n >= 1L << 20 ? $"{n / (double)(1L << 20):0.0} MB"
         : n >= 1L << 10 ? $"{Math.Round(n / 1024.0):0} KB"
         : $"{n} B";

    /// <summary>Everything under the directory, counted rather than estimated.</summary>
    private static (long Bytes, int Files) Contents(string path)
    {
        long bytes = 0;
        var files = 0;
        try
        {
            foreach (var file in new DirectoryInfo(path).EnumerateFiles("*", SearchOption.AllDirectories))
            {
                bytes += file.Length;
                files++;
            }
        }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
        return (bytes, files);
    }

    /// <summary>Can this process write here? Asked by writing, since permissions alone do not say.</summary>
    private static bool Writable(string path)
    {
        var probe = System.IO.Path.Combine(path, $".writable-{Guid.NewGuid():N}");
        try
        {
            File.WriteAllText(probe, "");
            File.Delete(probe);
            return true;
        }
        catch (Exception) { return false; }
    }

    /// <summary>
    /// The mount the path is on: the longest mount point that is a prefix of it, so a volume mounted at
    /// /data/history is reported rather than the root filesystem it sits inside.
    /// </summary>
    private static (string? Mount, long Total, long Free) Volume(string path)
    {
        try
        {
            DriveInfo? best = null;
            foreach (var drive in DriveInfo.GetDrives())
            {
                if (!drive.IsReady) continue;
                var root = drive.RootDirectory.FullName;
                if (!Under(path, root)) continue;
                if (best is null || root.Length > best.RootDirectory.FullName.Length) best = drive;
            }
            return best is null ? (null, 0, 0) : (best.RootDirectory.FullName, best.TotalSize, best.AvailableFreeSpace);
        }
        catch (IOException) { return (null, 0, 0); }
        catch (UnauthorizedAccessException) { return (null, 0, 0); }
    }

    private static bool Under(string path, string root)
    {
        if (root.Length == 0) return false;
        if (path.Equals(root.TrimEnd(System.IO.Path.DirectorySeparatorChar), StringComparison.Ordinal)) return true;
        var withSeparator = root.EndsWith(System.IO.Path.DirectorySeparatorChar) ? root : root + System.IO.Path.DirectorySeparatorChar;
        return path.StartsWith(withSeparator, StringComparison.Ordinal);
    }
}
