using rPDU2MQTT.Startup.ConfigSources;

namespace rPDU2MQTT.Classes;

/// <summary>
/// Lets components request an on-demand discovery republish (e.g. from the "Rediscover" button)
/// without taking a direct dependency on the discovery service.
/// </summary>
public sealed class DiscoveryCoordinator
{
    private readonly Config config;
    private readonly IConfigSource configSource;
    private readonly PDU pdu;

    public DiscoveryCoordinator(Config config, IConfigSource configSource, PDU pdu)
    {
        this.config = config;
        this.configSource = configSource;
        this.pdu = pdu;
    }

    /// <summary>Invoked when a rediscovery is requested. The discovery service subscribes to this.</summary>
    public event Func<CancellationToken, Task>? RediscoverRequested;

    /// <summary>Invoked when a discovery clear is requested (remove the retained HA discovery messages).</summary>
    public event Func<CancellationToken, Task>? ClearRequested;

    public Task RequestRediscoverAsync(CancellationToken cancellationToken)
    {
        // Hot-reload config from the source so saved override/template/name edits take effect on
        // republish without a full restart (connection-level settings still need a restart).
        ReloadConfig();
        return RediscoverRequested?.Invoke(cancellationToken) ?? Task.CompletedTask;
    }

    private void ReloadConfig()
    {
        try
        {
            config.CopyFrom(configSource.Load());
            pdu.InvalidateCache();
            Log.Information("Reloaded configuration from source for rediscovery.");
        }
        catch (Exception ex)
        {
            Log.Warning($"Could not reload configuration for rediscovery ({ex.Message}); using the current configuration.");
        }
    }

    public Task RequestClearAsync(CancellationToken cancellationToken)
        => ClearRequested?.Invoke(cancellationToken) ?? Task.CompletedTask;

    /// <summary>Whether anything is currently handling discovery requests (i.e. discovery is enabled).</summary>
    public bool HasSubscribers => RediscoverRequested is not null || ClearRequested is not null;
}
