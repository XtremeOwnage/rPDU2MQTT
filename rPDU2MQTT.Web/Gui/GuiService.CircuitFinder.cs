using System.Collections.Concurrent;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using rPDU2MQTT.Classes;
using rPDU2MQTT.Core.Flow;

namespace rPDU2MQTT.Services.Gui;

/// <summary>Circuit Finder (#494): the channels recorded while a session is open, read back by the page.</summary>
public sealed partial class GuiService
{
    /// <summary>How often the channels are read while recording. Faster than any PDU polls, so no poll is missed.</summary>
    private static readonly TimeSpan CircuitSampleEvery = TimeSpan.FromSeconds(1);

    private readonly ConcurrentDictionary<string, CircuitSampler> circuitSamplers = new(StringComparer.Ordinal);

    private void MapCircuitFinderEndpoints(WebApplication app)
    {
        // Asking is what keeps recording going: the first call starts it, each call extends it.
        app.MapGet("/api/circuit-finder/samples", (HttpContext ctx) =>
        {
            var id = ResolveInstanceId(ctx.Request.Query["instance"]);
            var sampler = circuitSamplers.GetOrAdd(id, _ => new CircuitSampler());
            var now = DateTime.UtcNow;
            if (sampler.Arm(now)) _ = Task.Run(() => RecordCircuitsAsync(id, sampler));

            var since = long.TryParse(ctx.Request.Query["since"].ToString(), out var ms)
                ? DateTimeOffset.FromUnixTimeMilliseconds(ms).UtcDateTime : DateTime.MinValue;
            var (samples, channels) = sampler.Since(since);
            config.Pdus.TryGetValue(id, out var pdu);
            return Results.Json(new
            {
                ok = true,
                // The server's clock, so the page can place its taps on the same timeline as the readings.
                now = new DateTimeOffset(now).ToUnixTimeMilliseconds(),
                pollSeconds = pdu?.PollInterval ?? 5,
                keepMinutes = (int)CircuitSampler.Keep.TotalMinutes,
                channels = channels.Select(c => new { id = c.Key, label = c.Value.Label, kind = c.Value.Kind }),
                samples = samples.Select(s => new { t = new DateTimeOffset(s.At).ToUnixTimeMilliseconds(), v = s.Values }),
            }, ConfigSchema.Json);
        });
    }

    private async Task RecordCircuitsAsync(string id, CircuitSampler sampler)
    {
        var ct = lifetime.ApplicationStopping;
        while (!ct.IsCancellationRequested && sampler.KeepGoing(DateTime.UtcNow))
        {
            try
            {
                var (_, pdu, _) = ResolveInstance(id);
                var data = await ResolveData(id, pdu, ct);
                var graph = FlowGraphBuilder.Build(data, config.EnergyFlow, FlowGraphBuilder.DefaultMetric, live);
                sampler.Record(DateTime.UtcNow, graph.Nodes);
            }
            catch (OperationCanceledException) { return; }
            catch (Exception ex) { Log.Debug($"Circuit Finder: could not read the channels ({ex.Message})."); }
            try { await Task.Delay(CircuitSampleEvery, ct); } catch (OperationCanceledException) { return; }
        }
    }
}
