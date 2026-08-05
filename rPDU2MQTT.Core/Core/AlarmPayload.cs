using rPDU2MQTT.Models.PDU;

namespace rPDU2MQTT.Core;

/// <summary>
/// What the bridge says about an entity's alarm, as payloads.
///
/// <para>
/// Home Assistant reads the alarm state through <c>{{ 'OFF' if value == 'none' else 'ON' }}</c> — so
/// <em>anything</em> that isn't exactly "none" is displayed as an active problem. That makes every
/// odd-shaped payload a fabricated alarm, which is the one thing this project must never produce, and it is
/// why these rules live in one tested place rather than inline at two call sites.
/// </para>
/// </summary>
public static class AlarmPayload
{
    /// <summary>
    /// The PDU reported an alarm object for this reading, so it is alarm-capable — whether or not one is
    /// currently active.
    /// </summary>
    /// <remarks>
    /// A clear alarm still counts. An entity that is being watched and is currently fine is worth showing:
    /// it tells you the threshold exists. What isn't worth showing is a reading the hardware has no alarm
    /// for at all — surfacing those would put an always-off "problem" on every measurement of every outlet.
    /// </remarks>
    public static bool Reported(Alarm? alarm) => alarm is not null;

    /// <summary>
    /// The alarm state to publish. "none" when there is no alarm, and when the PDU reported the field
    /// empty.
    /// </summary>
    /// <remarks>
    /// The empty case is the one that matters. A blank state is the PDU declining to say, and because
    /// Home Assistant treats everything that isn't "none" as a problem, publishing it verbatim would light
    /// up an alarm nobody raised. Reporting it as clear is the honest reading of "no alarm was stated".
    /// </remarks>
    public static string State(Alarm? alarm) =>
        string.IsNullOrWhiteSpace(alarm?.State) ? "none" : alarm.State.Trim();

    /// <summary>
    /// The alarm's detail as a JSON object, for the entity's attributes — today the PDU's own severity
    /// (its alarm-vs-warning distinction), which used to be parsed off the wire and then dropped.
    /// </summary>
    /// <remarks>
    /// An absent severity is reported as absent. Defaulting it to "warning" or "alarm" would state
    /// something the PDU never said, on the exact field an operator would use to decide whether to care.
    /// Always a JSON object, never null or empty text: Home Assistant discards an attributes payload it
    /// cannot parse as one, and would leave the previous value showing.
    /// </remarks>
    public static string Attributes(Alarm? alarm) =>
        string.IsNullOrWhiteSpace(alarm?.Severity)
            ? "{}"
            : System.Text.Json.JsonSerializer.Serialize(new Dictionary<string, string> { ["severity"] = alarm.Severity.Trim() });
}
