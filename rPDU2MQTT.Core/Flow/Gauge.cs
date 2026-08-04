namespace rPDU2MQTT.Core.Flow;

/// <summary>
/// The arithmetic behind a gauge, kept away from the drawing so it can be reasoned about and tested.
///
/// <para>
/// A gauge is a claim about proportion — "this much of what is possible" — and it is only ever as honest as
/// the ceiling it is drawn against. So the ceiling has to be stated, never inferred: deriving one from the
/// highest reading seen would redefine "full" on the first spike and make the same needle position mean
/// something different tomorrow.
/// </para>
/// </summary>
public static class Gauge
{
    /// <summary>
    /// How full the gauge is, 0..1 — or <see langword="null"/> when it should not be drawn at all.
    ///
    /// <para>
    /// Null for an unknown reading (nothing measured it) and for a missing or non-positive ceiling. In each
    /// case the caller shows the plain figure instead: a needle with nothing behind it is worse than no
    /// needle, because it looks like information.
    /// </para>
    /// <para>
    /// A reading beyond the ceiling clamps to full, and <see cref="Exceeds"/> says so separately. Letting the
    /// arc run past the end would draw a shape the dial cannot mean, and silently rescaling to fit would
    /// move the ceiling the operator set — the reading is not wrong, the stated maximum is simply too low,
    /// and those are different problems.
    /// </para>
    /// </summary>
    public static double? Fraction(double? value, double? max)
    {
        if (value is not { } v || max is not { } m || m <= 0) return null;
        if (double.IsNaN(v) || double.IsInfinity(v)) return null;
        return Math.Clamp(v / m, 0, 1);
    }

    /// <summary>Is the reading past the stated ceiling? Drawn full, and flagged rather than hidden.</summary>
    public static bool Exceeds(double? value, double? max)
        => value is { } v && max is { } m && m > 0 && v > m;
}
