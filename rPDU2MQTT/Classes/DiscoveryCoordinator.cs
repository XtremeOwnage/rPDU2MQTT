namespace rPDU2MQTT.Classes;

/// <summary>
/// Lets components request an on-demand discovery republish (e.g. from the "Rediscover" button)
/// without taking a direct dependency on the discovery service.
/// </summary>
public sealed class DiscoveryCoordinator
{
    /// <summary>Invoked when a rediscovery is requested. The discovery service subscribes to this.</summary>
    public event Func<CancellationToken, Task>? RediscoverRequested;

    public Task RequestRediscoverAsync(CancellationToken cancellationToken)
        => RediscoverRequested?.Invoke(cancellationToken) ?? Task.CompletedTask;
}
