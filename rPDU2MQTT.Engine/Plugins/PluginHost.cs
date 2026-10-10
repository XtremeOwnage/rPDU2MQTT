using Microsoft.Extensions.DependencyInjection;
using rPDU2MQTT.Classes;
using rPDU2MQTT.Core;
using rPDU2MQTT.Core.Flow;
using rPDU2MQTT.Core.Integrations;

namespace rPDU2MQTT.Plugins;

/// <summary>Hands plugins the host's services, resolved on first use once <see cref="Attach"/> has run.</summary>
public sealed class PluginHost(Config cfg) : IPluginHost
{
    private IServiceProvider? services;

    public void Attach(IServiceProvider sp) => services ??= sp;

    private IServiceProvider Services => services ?? throw new InvalidOperationException("Plugin host services are not available until the host is built.");

    public Config Config => cfg;
    public ISnapshotCache Snapshots => Services.GetRequiredService<ISnapshotCache>();
    public IFlowValueSource? LiveValues => Services.GetService<IFlowValueSource>();
    public IMessagePublisher? Publisher => Services.GetService<IMessagePublisher>();
    public IntegrationStatus Status => Services.GetRequiredService<IntegrationStatus>();
    public IPeriodAuditor? Auditor => Services.GetService<IPeriodAuditor>();
    public IMeasurementHistory? History => cfg.History.Enabled ? Services.GetService<IMeasurementHistory>() : null;
}
