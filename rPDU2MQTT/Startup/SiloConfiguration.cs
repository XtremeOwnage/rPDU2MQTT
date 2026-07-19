using Microsoft.Extensions.DependencyInjection;
using Orleans.Clustering.Kubernetes;
using Orleans.Configuration;
using Orleans.Hosting;
using Orleans.Serialization;

namespace rPDU2MQTT.Startup;

/// <summary>
/// Configures the co-hosted Orleans silo (v3, see docs/v3-orleans-migration.md). Every process is a silo;
/// grains provide the cross-process coordination the hand-rolled MQTT plumbing used to. Clustering defaults
/// to localhost (single silo — local dev / single-node); set <c>RPDU2MQTT_ORLEANS_CLUSTERING=kubernetes</c>
/// for a real multi-silo cluster via the Kubernetes membership provider (no external DB).
/// </summary>
public static class SiloConfiguration
{
    public static void Configure(ISiloBuilder silo)
    {
        silo.Configure<ClusterOptions>(o =>
        {
            o.ClusterId = Environment.GetEnvironmentVariable("RPDU2MQTT_ORLEANS_CLUSTER_ID") ?? "rpdu2mqtt";
            o.ServiceId = "rpdu2mqtt";
        });

        var clustering = (Environment.GetEnvironmentVariable("RPDU2MQTT_ORLEANS_CLUSTERING") ?? "localhost").ToLowerInvariant();
        if (clustering is "kubernetes" or "k8s")
        {
            // Advertise this pod's IP so sibling silos (other role deployments) can reach it directly — the
            // CNI routes pod IPs. Fixed silo/gateway ports (exposed on the container + allowed by NetworkPolicy).
            var podIp = Environment.GetEnvironmentVariable("POD_IP");
            silo.Configure<Orleans.Configuration.EndpointOptions>(o =>
            {
                if (System.Net.IPAddress.TryParse(podIp, out var ip)) o.AdvertisedIPAddress = ip;
                o.SiloPort = 11111;
                o.GatewayPort = 30000;
            });
            silo.UseKubeMembership();
            Serilog.Log.Information($"Orleans: Kubernetes clustering (KubeMembership), advertising {podIp}:11111.");
        }
        else
        {
            silo.UseLocalhostClustering();
            Serilog.Log.Information("Orleans: localhost clustering (single silo). Set RPDU2MQTT_ORLEANS_CLUSTERING=kubernetes for multi-silo.");
        }

        // The pipeline DTOs (rPDU2MQTT.Abstractions.*) carry no Orleans attributes on purpose — the contract
        // layer stays framework-free. Ship them across grains with the JSON serializer instead of the
        // generated one; the purity test keeps Orleans out of Abstractions.
        // Framework-free DTOs that cross grain boundaries: the pipeline contracts, and the PDU snapshot/model
        // (which carry no Orleans attributes) — shipped with JSON so the domain stays serializer-agnostic.
        silo.Services.AddSerializer(s => s.AddJsonSerializer(isSupported: IsGrainDto));
    }

    /// <summary>Types shipped across grains via JSON (no Orleans attributes on the domain).</summary>
    public static bool IsGrainDto(Type t) =>
        t.Namespace?.StartsWith("rPDU2MQTT.Abstractions") == true
        || t.Namespace == "rPDU2MQTT.Core.Transport";   // RawSnapshot wire form (round-trippable PDU data)
}
