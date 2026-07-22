using Microsoft.Extensions.Logging;
using Orleans.Runtime;
using Orleans.Runtime.Placement;
using rPDU2MQTT.Grains.Placement;

namespace rPDU2MQTT.Hosting;

/// <summary>
/// Applies <see cref="DevicePlacement"/>: device-owning grains go to a silo running the worker role when
/// the deployment has one. Lives in the host rather than next to the strategy because asking a silo's name
/// needs <see cref="ISiloStatusOracle"/>, which is silo-side runtime — the grains project deliberately
/// references only the SDK.
/// </summary>
public sealed class DevicePlacementDirector : IPlacementDirector
{
    private readonly ISiloStatusOracle oracle;
    private readonly ILogger<DevicePlacementDirector> log;

    public DevicePlacementDirector(ISiloStatusOracle oracle, ILogger<DevicePlacementDirector> log)
    {
        this.oracle = oracle;
        this.log = log;
    }

    public Task<SiloAddress> OnAddActivation(PlacementStrategy strategy, PlacementTarget target, IPlacementContext context)
    {
        var candidates = context.GetCompatibleSilos(target);
        var chosen = DevicePlacement.Choose(candidates, Name, target.GrainIdentity.GetHashCode())
            ?? throw new OrleansException($"No compatible silo to place {target.GrainIdentity}.");

        if (!DevicePlacement.IsPreferred(Name(chosen)))
            log.LogWarning("Placing device grain {Grain} on {Silo} ({Name}) — no silo runs the '{Role}' role, "
                + "so its device I/O happens there.", target.GrainIdentity, chosen, Name(chosen) ?? "?", DevicePlacement.PreferredRole);

        return Task.FromResult(chosen);
    }

    private string? Name(SiloAddress silo) => oracle.TryGetSiloName(silo, out var name) ? name : null;
}
