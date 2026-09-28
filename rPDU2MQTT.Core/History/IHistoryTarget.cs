namespace rPDU2MQTT.Core.History;

/// <summary>A history backend that past readings can be written into, so history can be copied to it from another.</summary>
public interface IHistoryTarget
{
    /// <summary>The backend's id, as named in History.Provider.</summary>
    string Id { get; }

    /// <summary>Why nothing can be written to it now, or null when it can.</summary>
    string? Unavailable { get; }

    /// <summary>Why readings already there cannot be replaced, or null when they can.</summary>
    string? CannotReplace => null;

    /// <summary>Called once before a copy starts, for anything worth looking up once rather than per series.</summary>
    Task PrepareAsync(CancellationToken ct) => Task.CompletedTask;

    /// <summary>The stretches of a window a series has nothing for, so a copy reads only those; empty when it is complete. By default, all of it.</summary>
    IReadOnlyList<(DateTime From, DateTime To)> Missing(string node, string metric, DateTime fromUtc, DateTime toUtc, int intervalSeconds) => [(fromUtc, toUtc)];

    /// <summary>Write one series' readings where it holds none, or over what it holds when `replace`; returns how many were written.</summary>
    Task<int> WriteAsync(string node, string label, string kind, string metric,
                         IReadOnlyList<(DateTime At, double Value)> readings, int intervalSeconds, DateTime nowUtc, bool replace, CancellationToken ct);
}
