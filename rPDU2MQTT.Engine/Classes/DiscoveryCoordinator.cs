using rPDU2MQTT.Startup.ConfigSources;

namespace rPDU2MQTT.Classes;

/// <summary>Requests an on-demand discovery republish or clear.</summary>
public sealed class DiscoveryCoordinator
{
    private readonly Config config;
    private readonly IConfigSource configSource;
    private readonly PduInstanceRegistry pdus;

    public DiscoveryCoordinator(Config config, IConfigSource configSource, PduInstanceRegistry pdus)
    {
        this.config = config;
        this.configSource = configSource;
        this.pdus = pdus;
    }

    /// <summary>What discovery published on its last pass; null or !HasPublished means unknown, not stale.</summary>
    public Func<(bool HasPublished, IReadOnlyCollection<string> Ids)>? PublishedDevices { get; set; }

    /// <summary>Invoked when a rediscovery is requested. The discovery service subscribes to this.</summary>
    public event Func<CancellationToken, Task>? RediscoverRequested;

    /// <summary>Invoked when a discovery clear is requested (remove the retained HA discovery messages).</summary>
    public event Func<CancellationToken, Task>? ClearRequested;

    public Task RequestRediscoverAsync(CancellationToken cancellationToken)
    {
        // Reload config so saved edits apply on republish.
        ReloadConfig();
        return RediscoverRequested?.Invoke(cancellationToken) ?? Task.CompletedTask;
    }

    private void ReloadConfig()
    {
        try
        {
            config.CopyFrom(configSource.Load());
            pdus.Primary?.InvalidateCache();
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
