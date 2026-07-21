using Microsoft.Extensions.Logging;
using rPDU2MQTT.Grains.Abstractions.Diagnostics;

namespace rPDU2MQTT.Grains.Diagnostics;

/// <summary>Confirms the silo is live and grains activate. Reports the local silo address for placement visibility.</summary>
public sealed class PingGrain : Grain, IPingGrain
{
    private readonly ILocalSiloDetails silo;
    public PingGrain(ILocalSiloDetails silo) => this.silo = silo;

    public Task<string> Ping() => Task.FromResult($"pong from {silo.Name} ({silo.SiloAddress})");
}
