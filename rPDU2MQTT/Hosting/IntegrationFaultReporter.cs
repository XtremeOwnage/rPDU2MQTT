using Microsoft.Extensions.Hosting;
using rPDU2MQTT.Classes;
using rPDU2MQTT.Core.Integrations;
using rPDU2MQTT.Core.Startup;

namespace rPDU2MQTT.Hosting;

/// <summary>
/// Records, once at startup, every integration that is switched on and cannot run as configured.
///
/// <para>
/// The rule for what an integration needs lives on the integration (<see cref="IIntegration.Misconfigured"/>),
/// which is the only place an externally loaded plugin can put one. This carries the answers into the
/// shared <see cref="ConfigurationFaults"/> the Status board and the GUI already read, so a plugin's fault
/// is surfaced exactly like a built-in's.
/// </para>
/// <para>
/// A hosted service rather than a DI factory: it has to write into the collection that already exists,
/// and registering a replacement would have discarded the logging-sink faults recorded before the
/// container was built.
/// </para>
/// </summary>
public sealed class IntegrationFaultReporter : IHostedService
{
    private readonly IntegrationRegistry registry;
    private readonly ConfigurationFaults faults;
    private readonly Config cfg;

    public IntegrationFaultReporter(IntegrationRegistry registry, ConfigurationFaults faults, Config cfg)
    {
        this.registry = registry;
        this.faults = faults;
        this.cfg = cfg;
    }

    public Task StartAsync(CancellationToken cancellationToken)
    {
        foreach (var (integration, reason) in registry.Faulted(cfg))
        {
            faults.Record(new ConfigurationFault(integration.Id, integration.DisplayName, reason));
            // Loud and diagnosable rather than fatal: nothing reachable from a toggle may stop the bridge.
            Log.Error($"{integration.DisplayName} is enabled but cannot run: {reason} Everything else keeps running.");
        }
        return Task.CompletedTask;
    }

    public Task StopAsync(CancellationToken cancellationToken) => Task.CompletedTask;
}
