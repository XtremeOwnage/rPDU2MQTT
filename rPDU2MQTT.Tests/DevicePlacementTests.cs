using Orleans.Runtime;
using rPDU2MQTT.Grains.Placement;
using Xunit;

namespace rPDU2MQTT.Tests;

/// <summary>
/// Where a device-owning grain lands. Splitting into worker/api/ui Deployments implied device I/O happens
/// in the worker; it didn't — roles only gate background services, and Orleans placed grains anywhere, so a
/// PDU's HTTP session could live in the pod serving the web GUI. This is the rule that makes the label true.
/// </summary>
public class DevicePlacementTests
{
    private static SiloAddress Silo(int port) => SiloAddress.New(new System.Net.IPEndPoint(System.Net.IPAddress.Loopback, port), 0);

    private static Func<SiloAddress, string?> Names(params (int Port, string? Name)[] names)
        => silo => names.FirstOrDefault(n => n.Port == silo.Endpoint.Port).Name;

    [Fact]
    public void Prefers_AWorkerSilo_OverTheOthers()
    {
        var ui = Silo(1); var api = Silo(2); var worker = Silo(3);
        var name = Names((1, "ui-pod-a"), (2, "api-pod-b"), (3, "worker-pod-c"));

        // Whatever the hash, the only worker is the only acceptable answer.
        for (var hash = 0; hash < 20; hash++)
            Assert.Equal(worker, DevicePlacement.Choose(new[] { ui, api, worker }, name, hash));
    }

    [Fact]
    public void AllInOne_CountsAsAWorker_SoTheDefaultDeploymentIsUnaffected()
    {
        // An all-in-one silo runs every role, worker included; a single-Deployment fleet must place normally.
        var a = Silo(1); var b = Silo(2);
        var name = Names((1, "all-pod-a"), (2, "all-pod-b"));

        Assert.Contains(DevicePlacement.Choose(new[] { a, b }, name, 0), new[] { a, b });
        Assert.True(DevicePlacement.IsPreferred("all-pod-a"));
        Assert.True(DevicePlacement.IsPreferred("worker-pod-a"));
        Assert.False(DevicePlacement.IsPreferred("ui-pod-a"));
        Assert.False(DevicePlacement.IsPreferred(null));
    }

    [Fact]
    public void NoWorkerAnywhere_FallsBack_RatherThanRefusingToPlace()
    {
        // Every worker down, or a deployment that simply has none: a grain placed in the wrong pod beats a
        // grain that can't be placed at all. The director logs a warning when this happens.
        var ui = Silo(1); var api = Silo(2);
        var name = Names((1, "ui-pod-a"), (2, "api-pod-b"));

        var chosen = DevicePlacement.Choose(new[] { ui, api }, name, 7);
        Assert.Contains(chosen, new[] { ui, api });
    }

    [Fact]
    public void SpreadsAcrossWorkers_ButIsStableForOneGrain()
    {
        var w1 = Silo(1); var w2 = Silo(2);
        var name = Names((1, "worker-a"), (2, "worker-b"));
        var candidates = new[] { w1, w2 };

        // The same grain (same hash) always resolves to the same silo while the silo set is unchanged...
        Assert.Equal(DevicePlacement.Choose(candidates, name, 42), DevicePlacement.Choose(candidates, name, 42));

        // ...and different grains don't all pile onto one worker.
        var picks = Enumerable.Range(0, 10).Select(h => DevicePlacement.Choose(candidates, name, h)).Distinct().Count();
        Assert.Equal(2, picks);
    }

    [Fact]
    public void NoSilosAtAll_IsNull_NotAnException()
    {
        Assert.Null(DevicePlacement.Choose(System.Array.Empty<SiloAddress>(), _ => "worker-a", 0));
    }

    [Fact]
    public void SiloName_CarriesTheRole()
    {
        Assert.Equal("worker-rpdu2mqtt-worker-abc123", DevicePlacement.SiloName("worker", "rpdu2mqtt-worker-abc123"));
        Assert.True(DevicePlacement.IsPreferred(DevicePlacement.SiloName("worker", "pod")));
        Assert.False(DevicePlacement.IsPreferred(DevicePlacement.SiloName("ui", "pod")));
    }
}
