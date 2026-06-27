using rPDU2MQTT.Models.Config;

namespace rPDU2MQTT.Classes;

/// <summary>
/// Pure reconciliation logic for the running PDU instances vs the desired <see cref="Config.Pdus"/>:
/// what to stop (removed/changed) and (re)start (added/changed). Kept side-effect-free so it's unit-testable;
/// <see cref="Services.InstanceManager"/> applies the plan.
/// </summary>
public static class InstanceReconcile
{
    /// <summary>
    /// A signature of everything that requires rebuilding an instance's PDU/poller when it changes:
    /// the connection target, TLS, timeout, credentials and poll cadence. (ActionsEnabled / Remap are
    /// read live by the sinks &amp; discovery, so they don't need a poller rebuild.)
    /// </summary>
    public static string Signature(PduConfig c)
    {
        var con = c.Connection;
        return string.Join('|',
            con?.Host ?? "", con?.Port?.ToString() ?? "", con?.Scheme ?? "",
            con?.TimeoutSecs?.ToString() ?? "", con?.ValidateCertificate?.ToString() ?? "",
            c.Credentials?.Username ?? "", c.Credentials?.Password ?? "",
            c.PollInterval.ToString());
    }

    /// <summary>
    /// Plan the move from the currently-running instance signatures to the desired config. Returns the ids
    /// to stop (removed or changed) and to start (added or changed); a changed non-primary instance appears
    /// in both (rebuild). The primary is never stopped — it's the fixed DI singleton — so a changed primary
    /// is surfaced via <c>primaryChanged</c> instead (needs a restart). Hostless desired entries are ignored.
    /// </summary>
    public static (List<string> toStop, List<string> toStart, bool primaryChanged) Plan(
        IReadOnlyDictionary<string, string> running,
        IReadOnlyDictionary<string, PduConfig> desired,
        string primaryId)
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
