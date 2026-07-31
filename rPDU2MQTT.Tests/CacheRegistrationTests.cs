using Microsoft.Extensions.DependencyInjection;
using rPDU2MQTT.Classes;
using rPDU2MQTT.Core.Flow;
using rPDU2MQTT.Models.Config;
using rPDU2MQTT.Services;
using rPDU2MQTT.Startup;
using Xunit;

namespace rPDU2MQTT.Tests;

/// <summary>
/// The cache half of the DI graph, built for real.
///
/// <para>
/// RedisCacheClient was registered by type while its constructor asks for a CacheConfig, and only the whole
/// Config is ever put in the container. Nothing caught it: every test built the pieces by hand, and the
/// registration itself was only reachable by starting the process. So it shipped, the cache defaulted to on,
/// and the bridge crash-looped on boot with "Unable to resolve service for type CacheConfig" — a container
/// that never got as far as connecting to anything.
/// </para>
/// <para>
/// These build a real ServiceProvider from the real registration. Constructing RedisCacheClient does not
/// connect — the multiplexer is Lazy — so this stays a unit test and still proves the graph resolves.
/// </para>
/// </summary>
public class CacheRegistrationTests
{
    private static Config ConfigWithCache(bool enabled) => new()
    {
        Cache = new CacheConfig
        {
            Enabled = enabled,
            Connection = "localhost:6379",
            KeyPrefix = "rpdu2mqtt:",
            ConnectTimeoutSeconds = 5,
        },
    };

    private static ServiceProvider Build(bool cacheEnabled)
    {
        var services = new ServiceCollection();
        ServiceConfiguration.AddCache(services, ConfigWithCache(cacheEnabled));
        // ValidateOnBuild is the point: it forces every registration to be constructible now, rather than
        // at the first resolve — which in the real host was during startup, in a crash loop.
        return services.BuildServiceProvider(new ServiceProviderOptions
        {
            ValidateOnBuild = true,
            ValidateScopes = true,
        });
    }

    [Fact]
    public void AnEnabledCacheResolves()
    {
        using var sp = Build(cacheEnabled: true);

        Assert.NotNull(sp.GetRequiredService<CacheHealth>());
        Assert.IsType<RedisCacheClient>(sp.GetRequiredService<ICacheClient>());
        Assert.IsType<RedisEnergyStore>(sp.GetRequiredService<IEnergyStore>());
    }

    [Fact]
    public void TheCacheClientIsOneSharedInstance()
    {
        using var sp = Build(cacheEnabled: true);

        // The concrete registration and the interface must be the same object: one connection, and one
        // CacheHealth being written to, or the Status board reports on a client nothing else is using.
        Assert.Same(sp.GetRequiredService<RedisCacheClient>(), sp.GetRequiredService<ICacheClient>());
    }

    [Fact]
    public void ADisabledCacheFallsBackToTheFileStore()
    {
        using var sp = Build(cacheEnabled: false);

        Assert.IsType<FileEnergyStore>(sp.GetRequiredService<IEnergyStore>());
        // Still registered when off, so the Status board can say "not configured" rather than showing nothing.
        Assert.NotNull(sp.GetRequiredService<CacheHealth>());
        Assert.Null(sp.GetService<ICacheClient>());
    }
}
