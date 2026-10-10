using System.Net.WebSockets;
using System.Text;
using System.Text.Json.Nodes;

namespace rPDU2MQTT.Plugin.Locations;

/// <summary>
/// One signed-in session on Home Assistant's WebSocket API, with the shared URL and token under HomeAssistant.
/// Nothing is subscribed, so the reply to each command is the next frame.
/// </summary>
internal sealed class HomeAssistantSocket : IDisposable
{
    private readonly ClientWebSocket ws = new();
    private readonly CancellationToken ct;
    private int nextId = 1;

    private HomeAssistantSocket(CancellationToken ct) => this.ct = ct;

    public static async Task<HomeAssistantSocket> OpenAsync(string? url, string? token, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(url) || string.IsNullOrWhiteSpace(token))
            throw new InvalidOperationException("Home Assistant URL and access token are required.");

        var socket = new HomeAssistantSocket(ct);
        try
        {
            var wsUrl = url.TrimEnd('/').Replace("https://", "wss://").Replace("http://", "ws://") + "/api/websocket";
            await socket.ws.ConnectAsync(new Uri(wsUrl), ct);
            await socket.ReceiveAsync();                                                    // auth_required
            await socket.SendAsync(new JsonObject { ["type"] = "auth", ["access_token"] = token });
            if ((string?)(await socket.ReceiveAsync())?["type"] != "auth_ok")
                throw new InvalidOperationException("Home Assistant rejected the access token.");
            return socket;
        }
        catch { socket.Dispose(); throw; }
    }

    /// <summary>Sends a command such as "config/area_registry/list" and returns Home Assistant's reply.</summary>
    public async Task<JsonNode?> CallAsync(string type, JsonObject? args = null)
    {
        var msg = new JsonObject { ["id"] = nextId++, ["type"] = type };
        if (args is not null) foreach (var kv in args) msg[kv.Key] = kv.Value?.DeepClone();
        await SendAsync(msg);
        return await ReceiveAsync();
    }

    private Task SendAsync(JsonNode message) =>
        ws.SendAsync(Encoding.UTF8.GetBytes(message.ToJsonString()), WebSocketMessageType.Text, true, ct);

    private async Task<JsonNode?> ReceiveAsync()
    {
        var buffer = new ArraySegment<byte>(new byte[64 * 1024]);
        using var ms = new MemoryStream();
        WebSocketReceiveResult result;
        do
        {
            result = await ws.ReceiveAsync(buffer, ct);
            ms.Write(buffer.Array!, 0, result.Count);
        }
        while (!result.EndOfMessage);
        return JsonNode.Parse(Encoding.UTF8.GetString(ms.ToArray()));
    }

    public void Dispose() => ws.Dispose();
}
