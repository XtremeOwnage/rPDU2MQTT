using rPDU2MQTT.Classes;
using rPDU2MQTT.Models.PDU;

namespace rPDU2MQTT.Core.Integrations;

/// <summary>
/// An integration that polls hardware and produces a snapshot of it — a second PDU vendor, a smart plug
/// strip, an inverter with its own outlets.
///
/// <para>
/// This is the capability that makes supporting another make of hardware a contribution rather than a fork.
/// A snapshot goes into the same cache the built-in Vertiv poller feeds, so everything downstream is
/// already written: MQTT publishing, Home Assistant discovery, the energy-flow graph, every destination and
/// the history behind them. None of them knows or asks what kind of device produced a reading.
/// </para>
/// <para>
/// Produce the shape, not the transport: build a <see cref="PduData"/> with devices, outlets and
/// measurements, and the bridge does the rest. Polling cadence, freshness, staleness and the leader gate
/// are the host's, exactly as they are for the built-in poller.
/// </para>
/// </summary>
public interface IDeviceSourcePlugin
{
    /// <summary>
    /// The instance id its snapshots are filed under, unique across every configured device. It becomes
    /// the Prometheus <c>instance</c> label and the key the Status board reports this device by, so it
    /// wants to be stable across restarts — a device that changes id looks like a new one appearing and
    /// the old one going silent.
    /// </summary>
    string InstanceId { get; }

    /// <summary>How often to poll. The host owns the timer so every device ages the same way.</summary>
    TimeSpan PollInterval(Config cfg) => TimeSpan.FromSeconds(Math.Max(5, cfg.Primary.PollInterval));

    /// <summary>
    /// Read the device now, or return null when there is nothing to report this pass.
    /// </summary>
    /// <remarks>
    /// Throwing is how a failed poll is reported: it is recorded against this integration and the previous
    /// snapshot is left to go stale on its own. Returning an empty or partial snapshot instead would be far
    /// worse — a device that answers with nothing reads downstream as a device whose outlets all went to
    /// zero, which is a reading nobody took.
    /// </remarks>
    Task<PduData?> PollAsync(Config cfg, CancellationToken ct);
}
