using rPDU2MQTT.Classes;
using rPDU2MQTT.Core.Flow;

namespace rPDU2MQTT.Core.History;

/// <summary>An integration that past readings can be read from, and optionally copied into.</summary>
public interface IHistoryBackend
{
    /// <summary>The id <c>History.Provider</c> names it by.</summary>
    string HistoryId { get; }

    /// <summary>A reader using <paramref name="http"/>, whose timeout suits the caller.</summary>
    IMeasurementHistory CreateHistory(HttpClient http, Config cfg);

    /// <summary>A writer for copied history, or null when it takes none.</summary>
    IHistoryTarget? CreateHistoryTarget(HttpClient http, Config cfg) => null;

    /// <summary>Why it cannot be read from now, or null when it can.</summary>
    string? HistoryUnavailable(Config cfg) => null;
}
