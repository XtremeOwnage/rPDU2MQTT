using rPDU2MQTT.Models.Config;

namespace rPDU2MQTT.Plugin.Vertiv;

/// <summary>Plans running PDU instances against <see cref="Config.Pdus"/>.</summary>
public static class InstanceReconcile
{
    /// <summary>Settings that require rebuilding an instance when changed.</summary>
    public static string Signature(PduConfig c)
    {
        var con = c.Connection;
        return string.Join('|',
            con?.Host ?? "", con?.Port?.ToString() ?? "", con?.Scheme ?? "",
            con?.TimeoutSecs?.ToString() ?? "", con?.ValidateCertificate?.ToString() ?? "",
            c.Credentials?.Username ?? "", c.Credentials?.Password ?? "",
            c.PollInterval.ToString());
    }

    /// <summary>Ids to stop and start; a changed primary is reported via <c>primaryChanged</c> and re-pointed in place.</summary>
    public static (List<string> toStop, List<string> toStart, bool primaryChanged) Plan(
        IReadOnlyDictionary<string, string> running,
        IReadOnlyDictionary<string, PduConfig> desired,
        string? primaryId)
    {
        var toStop = new List<string>();
        var toStart = new List<string>();
        var primaryChanged = false;

        var desiredSig = desired
            .Where(kv => !string.IsNullOrWhiteSpace(kv.Value.Connection?.Host))
            .ToDictionary(kv => kv.Key, kv => Signature(kv.Value), StringComparer.OrdinalIgnoreCase);

        bool IsPrimary(string id) => string.Equals(id, primaryId, StringComparison.OrdinalIgnoreCase);

        // Removed or changed -> stop (the primary is never stopped).
        foreach (var (id, sig) in running)
        {
            var wanted = desiredSig.TryGetValue(id, out var dsig);
            var changed = wanted && dsig != sig;
            if (wanted && !changed)
                continue;
            if (IsPrimary(id))
            {
                if (changed) primaryChanged = true;
                continue;
            }
            toStop.Add(id);
        }

        // Added or changed -> start (the primary is never (re)started here).
        foreach (var (id, dsig) in desiredSig)
        {
            if (IsPrimary(id))
                continue;
            if (!running.TryGetValue(id, out var rsig) || rsig != dsig)
                toStart.Add(id);
        }

        return (toStop, toStart, primaryChanged);
    }
}
