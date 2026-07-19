namespace rPDU2MQTT.Updates;

/// <summary>The outcome of an update check — deployable-tag decisions, no I/O.</summary>
/// <param name="Applicable">
/// False when the deployed tag isn't a clean release version (e.g. a moving channel like <c>stable</c>/
/// <c>edge</c>, or a digest pin) — there's nothing to compare by version, so the resolver stays silent.
/// </param>
/// <param name="Current">The currently-deployed release, when parseable.</param>
/// <param name="Latest">The newest eligible release found under the policy (may equal <see cref="Current"/>).</param>
public readonly record struct UpdateCheck(bool Applicable, SemVer? Current, SemVer? Latest)
{
    /// <summary>True when a strictly-newer eligible release than the deployed one exists.</summary>
    public bool UpdateAvailable => Applicable && Current is not null && Latest is not null && Latest.CompareTo(Current) > 0;

    public static UpdateCheck NotApplicable => new(false, null, null);
}

/// <summary>
/// Pure update-resolution logic for the operator (#210): given the currently-deployed image tag and the
/// list of tags the registry offers, decide the newest release the operator may move to under a
/// <see cref="UpdatePolicy"/>. Pre-releases and non-version (channel) tags are ignored as candidates.
/// </summary>
public static class UpdateResolver
{
    public static UpdateCheck Resolve(string? currentTag, IEnumerable<string> availableTags, UpdatePolicy policy)
    {
        if (!SemVer.TryParse(currentTag, out var current))
            return UpdateCheck.NotApplicable;

        SemVer? best = current;
        foreach (var tag in availableTags)
        {
            if (!SemVer.TryParse(tag, out var candidate)) continue;
            if (candidate.IsPreRelease) continue;              // never auto-move onto a pre-release
            if (!WithinPolicy(current, candidate, policy)) continue;
            if (candidate.CompareTo(best!) > 0) best = candidate;
        }

        return new UpdateCheck(true, current, best);
    }

    private static bool WithinPolicy(SemVer current, SemVer candidate, UpdatePolicy policy) => policy switch
    {
        UpdatePolicy.Patch => candidate.Major == current.Major && candidate.Minor == current.Minor,
        UpdatePolicy.Minor => candidate.Major == current.Major,
        UpdatePolicy.Major => true,
        _ => false,
    };
}
