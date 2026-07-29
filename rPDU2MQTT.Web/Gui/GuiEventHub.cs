using System.Collections.Concurrent;
using System.Text.Json;
using System.Threading.Channels;
using Microsoft.AspNetCore.Http;

namespace rPDU2MQTT.Services.Gui;

/// <summary>
/// Server-Sent-Events fan-out for the GUI, so the browser is pushed to instead of polling.
///
/// Why SSE and not SignalR/WebSockets: the GUI is built with the Node binary alone (no npm — see
/// rPDU2MQTT.Web.csproj), so a client library can't be pulled in, and SSE's client is <c>EventSource</c>,
/// built into every browser, with reconnection handled for us. One connection carries every feed.
///
/// A single pump recomputes each *subscribed* feed no faster than its interval, and only writes a frame
/// when the payload actually changed. So N open tabs cost one computation, an idle system costs no
/// traffic, and a value that moves reaches the browser within one tick instead of on the next poll.
/// </summary>
internal sealed class GuiEventHub : IAsyncDisposable
{
    /// <summary>How often the pump wakes; a feed's own interval decides whether it recomputes.</summary>
    private static readonly TimeSpan Tick = TimeSpan.FromMilliseconds(250);

    /// <summary>Comment frame cadence — keeps idle connections alive through proxies.</summary>
    private static readonly TimeSpan Heartbeat = TimeSpan.FromSeconds(15);

    /// <summary>
    /// A pushable feed. <paramref name="Produce"/> receives the subscription key's ':' suffix, so one
    /// feed serves parameterised variants (e.g. "flow:realpower" -> arg "realpower").
    /// </summary>
    internal sealed record Feed(string Name, TimeSpan Interval, Func<string?, CancellationToken, Task<object>> Produce);

    private sealed class Subscriber
    {
        public required IReadOnlySet<string> Keys { get; init; }

        // Latest-wins: a slow client drops stale frames rather than stalling the pump.
        public readonly Channel<string> Queue = Channel.CreateBounded<string>(
            new BoundedChannelOptions(32) { FullMode = BoundedChannelFullMode.DropOldest, SingleReader = true });
    }

    private readonly Dictionary<string, Feed> feeds;
    private readonly JsonSerializerOptions json;
    private readonly List<Subscriber> subscribers = new();
    private readonly object gate = new();
    private readonly ConcurrentDictionary<string, (string Frame, DateTime NextDue)> cache = new();
    private readonly CancellationTokenSource cts = new();
    private Task? pump;
    private DateTime lastBeat = DateTime.UtcNow;

    public GuiEventHub(JsonSerializerOptions json, params Feed[] feeds)
    {
        this.json = json;
        this.feeds = feeds.ToDictionary(f => f.Name, StringComparer.OrdinalIgnoreCase);
    }

    /// <summary>The feed a subscription key maps to ("flow:realpower" -> "flow").</summary>
    private static string FeedName(string key)
    {
        var i = key.IndexOf(':');
        return i < 0 ? key : key[..i];
    }

    private static string? FeedArg(string key)
    {
        var i = key.IndexOf(':');
        return i < 0 ? null : key[(i + 1)..];
    }

    /// <summary>Hold an SSE connection open, pushing the frames for the requested comma-separated keys.</summary>
    public async Task StreamAsync(HttpContext ctx, string? topics)
    {
        var keys = (topics ?? "")
            .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Where(k => feeds.ContainsKey(FeedName(k)))
            .ToHashSet(StringComparer.Ordinal);

        var res = ctx.Response;
        res.Headers.ContentType = "text/event-stream";
        res.Headers.CacheControl = "no-cache, no-transform";
        // Nginx and friends buffer proxied responses by default, which would hold every frame back.
        res.Headers["X-Accel-Buffering"] = "no";

        var sub = new Subscriber { Keys = keys };
        lock (gate)
            subscribers.Add(sub);

        // A key nobody has computed yet becomes due immediately, so a fresh tab paints within a tick.
        foreach (var key in keys)
            if (!cache.ContainsKey(key))
                cache[key] = ("", DateTime.MinValue);

        EnsurePump();

        try
        {
            // Tell the browser how soon to retry, then prime the page with whatever is already known.
            await WriteAsync(ctx, "retry: 3000\n\n");
            foreach (var key in keys)
                if (cache.TryGetValue(key, out var known) && known.Frame.Length > 0)
                    await WriteAsync(ctx, known.Frame);

            await foreach (var frame in sub.Queue.Reader.ReadAllAsync(ctx.RequestAborted))
                await WriteAsync(ctx, frame);
        }
        catch (OperationCanceledException) { /* the tab went away */ }
        catch (Exception ex) when (ex is IOException or ObjectDisposedException) { /* connection dropped mid-write */ }
        finally
        {
            lock (gate)
                subscribers.Remove(sub);
        }
    }

    private static async Task WriteAsync(HttpContext ctx, string frame)
    {
        await ctx.Response.WriteAsync(frame, ctx.RequestAborted);
        await ctx.Response.Body.FlushAsync(ctx.RequestAborted);
    }

    private void EnsurePump()
    {
        lock (gate)
            pump ??= Task.Run(PumpAsync);
    }

    private async Task PumpAsync()
    {
        while (!cts.IsCancellationRequested)
        {
            try { await Task.Delay(Tick, cts.Token); }
            catch (OperationCanceledException) { return; }

            List<Subscriber> current;
            lock (gate)
                current = subscribers.ToList();

            if (current.Count == 0)
                continue;

            foreach (var key in current.SelectMany(s => s.Keys).Distinct(StringComparer.Ordinal))
                await PublishIfChangedAsync(key, current);

            if (DateTime.UtcNow - lastBeat >= Heartbeat)
            {
                lastBeat = DateTime.UtcNow;
                foreach (var s in current)
                    s.Queue.Writer.TryWrite(": ping\n\n");
            }
        }
    }

    /// <summary>Recompute a feed if it is due, and fan the frame out only when the payload changed.</summary>
    private async Task PublishIfChangedAsync(string key, List<Subscriber> current)
    {
        if (!feeds.TryGetValue(FeedName(key), out var feed))
            return;

        (string Frame, DateTime NextDue) known = cache.TryGetValue(key, out var c) ? c : ("", DateTime.MinValue);
        if (DateTime.UtcNow < known.NextDue)
            return;

        string payload;
        try
        {
            var value = await feed.Produce(FeedArg(key), cts.Token);
            payload = JsonSerializer.Serialize(value, json);
        }
        catch (OperationCanceledException) { return; }
        catch (Exception ex)
        {
            // Surface the failure to the tab rather than going quiet — the UI shows it in place.
            payload = JsonSerializer.Serialize(new { ok = false, message = ex.Message }, json);
        }

        var frame = $"event: {key}\ndata: {payload}\n\n";
        var due = DateTime.UtcNow + feed.Interval;

        if (frame == known.Frame)
        {
            cache[key] = (known.Frame, due);
            return;
        }

        cache[key] = (frame, due);
        foreach (var s in current)
            if (s.Keys.Contains(key))
                s.Queue.Writer.TryWrite(frame);
    }

    public async ValueTask DisposeAsync()
    {
        await cts.CancelAsync();

        Subscriber[] current;
        lock (gate)
        {
            current = subscribers.ToArray();
            subscribers.Clear();
        }

        foreach (var s in current)
            s.Queue.Writer.TryComplete();

        if (pump is not null)
        {
            try { await pump; }
            catch (Exception ex) { Log.Debug($"GUI event pump ended: {ex.Message}"); }
        }

        cts.Dispose();
    }
}
