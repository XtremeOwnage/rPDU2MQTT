using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Orleans.Serialization;
using Orleans.TestingHost;
using rPDU2MQTT.Classes;

namespace rPDU2MQTT.Tests;

/// <summary>
/// Shared in-memory Orleans cluster for grain tests: registers a minimal <see cref="Config"/> (grains read
/// it from DI) and the JSON serializer for the framework-free pipeline DTOs on both silo and client — the
/// serializer-config validator checks every grain interface, so any test cluster needs this.
/// </summary>
public static class GrainTestCluster
{
    private static bool IsAbstraction(Type t) => t.Namespace?.StartsWith("rPDU2MQTT.Abstractions") == true;

    private sealed class FakeRegistry : rPDU2MQTT.Services.Operator.IContainerRegistry
    {
        public Task<IReadOnlyList<string>> ListTagsAsync(string h, string r, CancellationToken ct) => Task.FromResult((IReadOnlyList<string>)Array.Empty<string>());
        public Task<string?> ResolveDigestAsync(string h, string r, string reference, CancellationToken ct) => Task.FromResult<string?>(null);
    }

    private sealed class Silo : ISiloConfigurator
    {
        public void Configure(ISiloBuilder silo)
        {
            silo.Services.AddSingleton(new Config());
            silo.Services.AddSingleton<rPDU2MQTT.Services.Operator.IContainerRegistry, FakeRegistry>();
            silo.Services.AddSerializer(s => s.AddJsonSerializer(isSupported: IsAbstraction));
        }
    }

    private sealed class Client : IClientBuilderConfigurator
    {
        public void Configure(IConfiguration _, IClientBuilder client)
            => client.Services.AddSerializer(s => s.AddJsonSerializer(isSupported: IsAbstraction));
    }

    public static async Task<TestCluster> StartAsync()
    {
        var cluster = new TestClusterBuilder(1)
            .AddSiloBuilderConfigurator<Silo>()
            .AddClientBuilderConfigurator<Client>()
            .Build();
        await cluster.DeployAsync();
        return cluster;
    }
}
