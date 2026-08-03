using System.Net;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json.Nodes;
using rPDU2MQTT.Classes;
using rPDU2MQTT.Services;
using Xunit;

namespace rPDU2MQTT.Tests;

/// <summary>
/// The client that talks to Home Assistant's device registry, against a stand-in that answers the way HA
/// does. The selection rule is unit-tested elsewhere; what this pins is the part that actually broke things
/// if I got it wrong — reading HA's payload shapes. <c>identifiers</c> is a list of [domain, id] <b>pairs</b>,
/// entities point at their device by <c>device_id</c>, and removal is per <c>config_entry_id</c>.
/// </summary>
public class HaDeviceCleanupClientTests : IDisposable
{
    private readonly HttpListener listener = new();
    private readonly string url;
    public readonly List<JsonObject> Removals = new();

    public HaDeviceCleanupClientTests()
    {
        var port = 18800 + Random.Shared.Next(600);
        url = $"http://127.0.0.1:{port}";
        listener.Prefixes.Add(url + "/");
        listener.Start();
        _ = Task.Run(ServeAsync);
    }

    public void Dispose() { try { listener.Stop(); } catch { } }

    private async Task ServeAsync()
    {
        while (listener.IsListening)
        {
            HttpListenerContext ctx;
            try { ctx = await listener.GetContextAsync(); } catch { return; }
            if (!ctx.Request.IsWebSocketRequest) { ctx.Response.StatusCode = 400; ctx.Response.Close(); continue; }

            var ws = (await ctx.AcceptWebSocketAsync(null)).WebSocket;
            _ = Task.Run(() => SessionAsync(ws));
        }
    }

    private async Task SessionAsync(WebSocket ws)
    {
        async Task SendAsync(object o) =>
            await ws.SendAsync(Encoding.UTF8.GetBytes(o is JsonNode n ? n.ToJsonString() : System.Text.Json.JsonSerializer.Serialize(o)),
                WebSocketMessageType.Text, true, CancellationToken.None);

        await SendAsync(new { type = "auth_required" });
        var buf = new byte[64 * 1024];
        while (ws.State == WebSocketState.Open)
        {
            WebSocketReceiveResult r;
            try { r = await ws.ReceiveAsync(buf, CancellationToken.None); } catch { return; }
            if (r.MessageType == WebSocketMessageType.Close) return;
            var msg = JsonNode.Parse(Encoding.UTF8.GetString(buf, 0, r.Count))!.AsObject();
            var type = (string?)msg["type"];
            var id = (int?)msg["id"] ?? 0;

            if (type == "auth") { await SendAsync(new { type = "auth_ok" }); continue; }

            if (type == "config/device_registry/list")
            {
                await SendAsync(new JsonObject
                {
                    ["id"] = id, ["type"] = "result", ["success"] = true,
                    ["result"] = new JsonArray
                    {
                        Device("d-stale", "Proxmox: Kube04", "energyflow_outlet_rack_pdu_1_9"),
                        Device("d-live", "Live outlet", "energyflow_outlet_pdu_1_4"),
                        Device("d-other", "Attic", "acurite_986_attic"),
                    },
                });
                continue;
            }
            if (type == "config/entity_registry/list")
            {
                await SendAsync(new JsonObject
                {
                    ["id"] = id, ["type"] = "result", ["success"] = true,
                    ["result"] = new JsonArray
                    {
                        new JsonObject { ["entity_id"] = "sensor.live_power", ["device_id"] = "d-live" },
                        new JsonObject { ["entity_id"] = "sensor.attic_temp", ["device_id"] = "d-other" },
                    },
                });
                continue;
            }
            if (type == "config/device_registry/remove_config_entry")
            {
                lock (Removals) Removals.Add(msg);
                await SendAsync(new JsonObject { ["id"] = id, ["type"] = "result", ["success"] = true });
                continue;
            }
            await SendAsync(new JsonObject { ["id"] = id, ["type"] = "result", ["success"] = false });
        }
    }

    private static JsonObject Device(string id, string name, string ident) => new()
    {
        ["id"] = id,
        ["name"] = name,
        ["identifiers"] = new JsonArray { new JsonArray { "mqtt", ident } },
        ["config_entries"] = new JsonArray { "entry-mqtt" },
    };

    private HaEnergyDashboardSync Sync()
    {
        var cfg = new Config();
        cfg.HASS.EnergyDashboard.Url = url;
        cfg.HASS.EnergyDashboard.Token = "test-token";
        return new HaEnergyDashboardSync(cfg, new StubSnapshots());
    }

    private sealed class StubSnapshots : rPDU2MQTT.Core.ISnapshotCache
    {
        public rPDU2MQTT.Core.PduSnapshot? Latest => null;
        public rPDU2MQTT.Core.PduSnapshot? Get(string instanceId) => null;
        public IReadOnlyCollection<rPDU2MQTT.Core.PduSnapshot> All => Array.Empty<rPDU2MQTT.Core.PduSnapshot>();
    }

    [Fact]
    public async Task OnlyTheOwnedDeviceWithNoEntities_IsReported()
    {
        var stale = await Sync().StaleDevicesAsync();

        Assert.Single(stale);
        Assert.Equal("d-stale", stale[0].Id);
        Assert.Equal("Proxmox: Kube04", stale[0].Name);
        // Proof the [domain, id] pair shape was read correctly rather than the domain being taken as the id.
        Assert.Equal("energyflow_outlet_rack_pdu_1_9", stale[0].Identifiers.Single());
        Assert.Equal(["entry-mqtt"], stale[0].ConfigEntryIds);
    }

    [Fact]
    public async Task DeletingSendsTheCallHomeAssistantExpects_ForThatDeviceOnly()
    {
        var sync = Sync();
        var stale = await sync.StaleDevicesAsync();

        var removed = await sync.DeleteDevicesAsync(stale);

        Assert.Equal(1, removed);
        lock (Removals)
        {
            var call = Assert.Single(Removals);
            Assert.Equal("config/device_registry/remove_config_entry", (string?)call["type"]);
            Assert.Equal("d-stale", (string?)call["device_id"]);
            Assert.Equal("entry-mqtt", (string?)call["config_entry_id"]);
        }
    }
}
