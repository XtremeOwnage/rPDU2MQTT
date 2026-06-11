namespace rPDU2MQTT.Classes;

/// <summary>
/// Lets components request an on-demand discovery republish (e.g. from the "Rediscover" button)
/// without taking a direct dependency on the discovery service.
/// </summary>
public sealed class DiscoveryCoordinator
{
    /// <summary>Invoked when a rediscovery is requested. The discovery service subscribes to this.</summary>
    public event Func<CancellationToken, Task>? RediscoverRequested;

    /// <summary>Invoked when a discovery clear is requested (remove the retained HA discovery messages).</summary>
    public event Func<CancellationToken, Task>? ClearRequested;

    public Task RequestRediscoverAsync(CancellationToken cancellationToken)
        => RediscoverRequested?.Invoke(cancellationToken) ?? Task.CompletedTask;

    public Task RequestClearAsync(CancellationToken cancellationToken)
        => ClearRequested?.Invoke(cancellationToken) ?? Task.CompletedTask;

    /// <summary>Whether anything is currently handling discovery requests (i.e. discovery is enabled).</summary>
    public bool HasSubscribers => RediscoverRequested is not null || ClearRequested is not null;
}
