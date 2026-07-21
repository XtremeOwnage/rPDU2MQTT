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
    private static bool IsAbstraction(Type t) =>
        t.Namespace?.StartsWith("rPDU2MQTT.Abstractions") == true
        || t.Namespace == "rPDU2MQTT.Core.Transport";

    private sealed class FakeRegistry : rPDU2MQTT.Services.Operator.IContainerRegistry
    {
        public Task<IReadOnlyList<string>> ListTagsAsync(string h, string r, CancellationToken ct) => Task.FromResult((IReadOnlyList<string>)Array.Empty<string>());
        public Task<string?> ResolveDigestAsync(string h, string r, string reference, CancellationToken ct) => Task.FromResult<string?>(null);
    }

    /// <summary>A registry holding the single instance <c>default</c>, on its own config (the DI one stays bare).</summary>
    public const string KnownInstanceId = "default";

    private static rPDU2MQTT.Classes.PduInstanceRegistry OneInstanceRegistry()
    {
        var cfg = new Config();
        cfg.Pdus[KnownInstanceId] = new rPDU2MQTT.Models.Config.PduConfig();
        cfg.Pdus[KnownInstanceId].Connection.Host = "10.255.255.1";   // never contacted by these tests
        return new rPDU2MQTT.Classes.PduInstanceRegistry(cfg, new rPDU2MQTT.Classes.PduInstanceFactory(cfg));
    }

    private sealed class Silo : ISiloConfigurator
    {
        public void Configure(ISiloBuilder silo)
        {
            silo.Services.AddSingleton(new Config());
            silo.Services.AddSingleton<rPDU2MQTT.Services.Operator.IContainerRegistry, FakeRegistry>();
            // One known PDU instance so PduGrain can activate. Building a PDU opens no sockets — a grain
            // keyed to any *other* instance finds nothing, which is what the ownership tests check.
            silo.Services.AddSingleton(OneInstanceRegistry());
            // What the EmonCMS grain needs to exist. Nothing here reaches the network: with EmonCMS off in
            // the config, the grain refuses before it would call anything.
            silo.Services.AddSingleton<rPDU2MQTT.Core.IMessageBus, rPDU2MQTT.Core.ChannelMessageBus>();
            silo.Services.AddSingleton<rPDU2MQTT.Core.ISnapshotCache, rPDU2MQTT.Core.SnapshotCache>();
            silo.Services.AddSingleton<rPDU2MQTT.Services.EmonCmsFeedSync>();
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
