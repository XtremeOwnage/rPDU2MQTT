using Orleans.Placement;
using Orleans.Runtime;

namespace rPDU2MQTT.Grains.Placement;

/// <summary>
/// Place this grain on a silo that runs the <c>worker</c> role, when the deployment has one.
/// <para>
/// Splitting the deployment into worker/api/ui Deployments implied that device I/O happens in the worker —
/// and it didn't. Roles only decide which background services start in each process; every pod is an equal
/// silo, and Orleans placed grains wherever it liked, so a PDU's HTTP session or a Modbus device's socket
/// could just as easily live in the pod serving the web GUI. That makes the tiering a label rather than a
/// boundary, and makes per-role network segmentation actively dangerous.
/// </para>
/// <para>
/// This is a <i>preference</i>, not a requirement: with no worker silo (the default all-in-one fleet, or
/// every worker down) it falls back to any compatible silo, because a grain that can't be placed is worse
/// than one placed in the wrong pod. The fallback is logged, so it isn't a silent surprise.
/// </para>
/// </summary>
[Serializable, GenerateSerializer, Immutable, SuppressReferenceTracking]
public sealed class DevicePlacement : PlacementStrategy
{
    public static readonly DevicePlacement Singleton = new();

    /// <summary>The role a silo must advertise (in its silo name) to be preferred.</summary>
    public const string PreferredRole = "worker";

    /// <summary>
    /// Silo names carry the role because that's what placement can see: a placement director can ask
    /// the silo status oracle for a silo's name, and for nothing else about it.
    /// </summary>
    public static string SiloName(string role, string suffix) => $"{role}-{suffix}";

    /// <summary>
    /// Does this silo run the preferred role? An all-in-one silo counts — it runs every role, including
    /// this one, which is why the single-Deployment default keeps working unchanged.
    /// </summary>
    public static bool IsPreferred(string? siloName)
        => siloName is not null
        && (siloName.StartsWith(PreferredRole + "-", StringComparison.OrdinalIgnoreCase)
            || siloName.StartsWith("all-", StringComparison.OrdinalIgnoreCase));

    /// <summary>
    /// The placement rule, as a pure function so it can be tested without a cluster: prefer silos running
    /// the role; fall back to every candidate when none does. <paramref name="hash"/> spreads different
    /// grains across the eligible silos while keeping one grain's choice stable for a given silo set.
    /// </summary>
    public static SiloAddress? Choose(IReadOnlyList<SiloAddress> candidates, Func<SiloAddress, string?> nameOf, int hash)
    {
        if (candidates.Count == 0) return null;

        var preferred = candidates.Where(s => IsPreferred(nameOf(s))).ToList();
        var pool = preferred.Count > 0 ? preferred : candidates;
        return pool[(int)((uint)hash % (uint)pool.Count)];
    }
}

/// <summary>Marks a grain as doing device I/O — see <see cref="DevicePlacement"/>.</summary>
[AttributeUsage(AttributeTargets.Class)]
public sealed class DevicePlacementAttribute : PlacementAttribute
{
    public DevicePlacementAttribute() : base(DevicePlacement.Singleton) { }
}
