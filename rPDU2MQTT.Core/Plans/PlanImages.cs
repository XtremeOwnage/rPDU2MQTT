using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using rPDU2MQTT.Models.Config;

namespace rPDU2MQTT.Core.Plans;

/// <summary>An image format a floor plan can be uploaded in (#462).</summary>
public sealed record PlanImageFormat(string Extension, string ContentType)
{
    public static readonly PlanImageFormat Png = new("png", "image/png");
    public static readonly PlanImageFormat Jpeg = new("jpg", "image/jpeg");
    public static readonly PlanImageFormat WebP = new("webp", "image/webp");
    public static readonly PlanImageFormat Svg = new("svg", "image/svg+xml");

    public static readonly PlanImageFormat[] All = [Png, Jpeg, WebP, Svg];

    /// <summary>What the formats are called where the limits are stated.</summary>
    public const string Named = "PNG, JPEG, WebP or SVG";

    /// <summary>The format the bytes actually are, whatever the upload claimed. Null for anything else.</summary>
    public static PlanImageFormat? Detect(ReadOnlySpan<byte> b)
    {
        if (b.Length >= 8 && b[0] == 0x89 && b[1] == 0x50 && b[2] == 0x4E && b[3] == 0x47) return Png;
        if (b.Length >= 3 && b[0] == 0xFF && b[1] == 0xD8 && b[2] == 0xFF) return Jpeg;
        if (b.Length >= 12 && b[..4].SequenceEqual("RIFF"u8) && b[8..12].SequenceEqual("WEBP"u8)) return WebP;
        var head = Encoding.UTF8.GetString(b[..Math.Min(b.Length, 4096)]).TrimStart('\uFEFF', ' ', '\t', '\r', '\n');
        if ((head.StartsWith("<?xml", StringComparison.Ordinal) || head.StartsWith("<svg", StringComparison.Ordinal) || head.StartsWith("<!--", StringComparison.Ordinal))
            && head.Contains("<svg", StringComparison.Ordinal)) return Svg;
        return null;
    }

    public static PlanImageFormat? ForId(string id) => All.FirstOrDefault(f => id.EndsWith("." + f.Extension, StringComparison.Ordinal));
}

/// <summary>An image read back from plan storage.</summary>
public sealed record PlanImage(byte[] Bytes, string ContentType);

/// <summary>Why an upload was refused, said in terms of the limits.</summary>
public sealed class PlanImageRejected(string message) : Exception(message);

/// <summary>Where floor plan images are kept, outside the configuration (#462).</summary>
public interface IPlanImageStore
{
    /// <summary>Where images go, said plainly for the page: a directory path or a bucket.</summary>
    string Describe { get; }

    Task SaveAsync(string id, byte[] bytes, string contentType, CancellationToken ct);

    /// <summary>The image, or null when it is not there — a missing image leaves the floor as a grid.</summary>
    Task<PlanImage?> ReadAsync(string id, CancellationToken ct);

    Task DeleteAsync(string id, CancellationToken ct);
}

/// <summary>Uploading, naming and reading plan images, whichever store holds them.</summary>
public sealed partial class PlanImages(IPlanImageStore store, PlanStorageConfig config, bool fallback = false)
{
    /// <summary>Nothing was configured, so images go to a directory beside the program — lost with its container.</summary>
    public bool Fallback => fallback;

    [GeneratedRegex("^[a-f0-9]{24}\\.(png|jpg|webp|svg)$")]
    private static partial Regex IdPattern();

    public IPlanImageStore Store => store;

    public long MaxBytes => Math.Clamp(config.MaxMegabytes, 1, 100) * 1024L * 1024L;

    /// <summary>The limits, as the upload control states them.</summary>
    public string Limits => $"{PlanImageFormat.Named}, up to {Math.Clamp(config.MaxMegabytes, 1, 100)} MB.";

    /// <summary>An id is a name this store wrote: a hash and an extension, never a path.</summary>
    public static bool IsId(string? id) => !string.IsNullOrEmpty(id) && IdPattern().IsMatch(id);

    /// <summary>Store an upload and return its id. The same image uploaded twice is stored once.</summary>
    public async Task<string> SaveAsync(byte[] bytes, CancellationToken ct)
    {
        if (bytes.Length == 0) throw new PlanImageRejected("The file is empty.");
        if (bytes.Length > MaxBytes)
            throw new PlanImageRejected($"The image is {bytes.Length / 1024.0 / 1024.0:0.0} MB; the limit is {config.MaxMegabytes} MB. Raise PlanStorage.MaxMegabytes, or upload a smaller image.");
        var format = PlanImageFormat.Detect(bytes)
            ?? throw new PlanImageRejected($"That is not an image this can show. Upload {PlanImageFormat.Named}. A HEIC photo from an iPhone needs converting first, or set the camera to 'Most Compatible'.");
        var id = Convert.ToHexString(SHA256.HashData(bytes))[..24].ToLowerInvariant() + "." + format.Extension;
        await store.SaveAsync(id, bytes, format.ContentType, ct);
        return id;
    }

    public Task<PlanImage?> ReadAsync(string id, CancellationToken ct) =>
        IsId(id) ? store.ReadAsync(id, ct) : Task.FromResult<PlanImage?>(null);

    public Task DeleteAsync(string id, CancellationToken ct) =>
        IsId(id) ? store.DeleteAsync(id, ct) : Task.CompletedTask;

    /// <summary>
    /// The store the configuration asks for: the bucket when one is set, else a named directory, else the shared
    /// cache when there is one (it survives a restart), else a directory beside the program.
    /// </summary>
    public static PlanImages For(PlanStorageConfig config, HttpClient? http = null, IPlanImageStore? cache = null)
    {
        var mounted = Environment.GetEnvironmentVariable("RPDU2MQTT_PLANS_DIRECTORY");
        IPlanImageStore store = config.ObjectStore.IsEnabled() ? new S3PlanImageStore(config.ObjectStore, http ?? new HttpClient())
            : !string.IsNullOrWhiteSpace(config.Directory) ? new DirectoryPlanImageStore(config.Directory)
            : !string.IsNullOrWhiteSpace(mounted) ? new DirectoryPlanImageStore(mounted)
            : cache ?? new DirectoryPlanImageStore(Path.Combine(AppContext.BaseDirectory, "plans"));
        var fallback = !config.ObjectStore.IsEnabled() && string.IsNullOrWhiteSpace(config.Directory) && string.IsNullOrWhiteSpace(mounted) && cache is null;
        return new PlanImages(store, config, fallback);
    }
}

/// <summary>Plan images as files in one directory: a PVC, a Compose volume, or any directory.</summary>
public sealed class DirectoryPlanImageStore(string directory) : IPlanImageStore
{
    public string Describe => $"the directory {directory}";

    public async Task SaveAsync(string id, byte[] bytes, string contentType, CancellationToken ct)
    {
        Directory.CreateDirectory(directory);
        var path = Path.Combine(directory, id);
        var temp = path + ".tmp";
        await File.WriteAllBytesAsync(temp, bytes, ct);
        File.Move(temp, path, overwrite: true);
    }

    public async Task<PlanImage?> ReadAsync(string id, CancellationToken ct)
    {
        var path = Path.Combine(directory, id);
        if (!File.Exists(path) || PlanImageFormat.ForId(id) is not { } format) return null;
        try { return new PlanImage(await File.ReadAllBytesAsync(path, ct), format.ContentType); }
        catch (IOException) { return null; }
        catch (UnauthorizedAccessException) { return null; }
    }

    public Task DeleteAsync(string id, CancellationToken ct)
    {
        var path = Path.Combine(directory, id);
        if (File.Exists(path)) File.Delete(path);
        return Task.CompletedTask;
    }
}
