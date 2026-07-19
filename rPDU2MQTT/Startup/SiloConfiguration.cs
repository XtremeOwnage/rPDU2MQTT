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
            silo.UseKubeMembership();
            Serilog.Log.Information("Orleans: Kubernetes clustering (KubeMembership).");
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
        || t.Namespace?.StartsWith("rPDU2MQTT.Models.PDU") == true
        || t == typeof(rPDU2MQTT.Core.PduSnapshot);
}
