using rPDU2MQTT.Core.Plans;

namespace rPDU2MQTT.Services;

/// <summary>Plan images kept in the shared cache, one key each, so they survive a restart without a volume (#462).</summary>
public sealed class CachePlanImageStore(ICacheClient cache, string keyPrefix) : IPlanImageStore
{
    private string Key(string id) => keyPrefix + "plan:" + id;

    public string Describe => "the shared cache (Valkey/Redis)";

    public Task SaveAsync(string id, byte[] bytes, string contentType, CancellationToken ct)
    {
        cache.HashSet(Key(id), new Dictionary<string, string> { ["type"] = contentType, ["data"] = Convert.ToBase64String(bytes) });
        return Task.CompletedTask;
    }

    public Task<PlanImage?> ReadAsync(string id, CancellationToken ct)
    {
        var entry = cache.HashGetAll(Key(id));
        if (!entry.TryGetValue("data", out var data) || !entry.TryGetValue("type", out var type)) return Task.FromResult<PlanImage?>(null);
        try { return Task.FromResult<PlanImage?>(new PlanImage(Convert.FromBase64String(data), type)); }
        catch (FormatException) { return Task.FromResult<PlanImage?>(null); }
    }

    public Task DeleteAsync(string id, CancellationToken ct)
    {
        cache.HashSet(Key(id), new Dictionary<string, string>());
        return Task.CompletedTask;
    }
}
