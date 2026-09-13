namespace rPDU2MQTT.Core.Flow;

/// <summary>The instants a chart window is sampled at, bounded so a long window at a fine step stays drawable.</summary>
public static class SeriesWindow
{
    /// <summary>The finest step history is asked for.</summary>
    public const int MinStepSeconds = 60;

    /// <summary>The coarsest sampled step; a per-period total answers anything longer.</summary>
    public const int MaxStepSeconds = 86400;

    /// <summary>The most instants one request is sampled at, whatever step was asked for.</summary>
    public const int MaxPoints = 2000;

    /// <summary>The longest sampled window, in minutes: a year.</summary>
    public const int MaxMinutes = 366 * 24 * 60;

    /// <summary>A requested step held to the supported range, or <paramref name="fallback"/> when none was given.</summary>
    public static int ClampStep(int? requested, int fallback)
        => Math.Clamp(requested ?? fallback, MinStepSeconds, MaxStepSeconds);

    /// <summary>The step actually used: the one asked for, widened until the window fits in <see cref="MaxPoints"/> instants.</summary>
    public static int Fit(TimeSpan span, int stepSeconds)
    {
        var step = Math.Clamp(stepSeconds, MinStepSeconds, MaxStepSeconds);
        var needed = (int)Math.Ceiling(Math.Max(0, span.TotalSeconds) / (MaxPoints - 1));
        return Math.Max(step, needed);
    }

    /// <summary>Instants from <paramref name="start"/> to <paramref name="end"/> at the fitted step, oldest first, never empty.</summary>
    public static IReadOnlyList<DateTime> Instants(DateTime start, DateTime end, int stepSeconds)
    {
        var step = Fit(end - start, stepSeconds);
        var list = new List<DateTime>();
        for (var t = start; t <= end; t = t.AddSeconds(step)) list.Add(t);
        if (list.Count == 0) list.Add(end);
        return list;
    }
}
