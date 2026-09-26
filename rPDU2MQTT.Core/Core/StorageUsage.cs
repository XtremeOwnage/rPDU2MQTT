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
public sealed record StorageUse(
    string Name, string Path, bool Exists, bool Writable, long Bytes, int Files,
    string? Mount, long TotalBytes, long FreeBytes);

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
    public static StorageUse For(string name, string? path)
    {
        if (string.IsNullOrWhiteSpace(path))
            return new StorageUse(name, "", false, false, 0, 0, null, 0, 0);

        var full = System.IO.Path.GetFullPath(path);
        var exists = Directory.Exists(full);
        var (bytes, files) = exists ? Contents(full) : (0, 0);
        var (mount, total, free) = Volume(full);
        return new StorageUse(name, full, exists, exists && Writable(full), bytes, files, mount, total, free);
    }

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
