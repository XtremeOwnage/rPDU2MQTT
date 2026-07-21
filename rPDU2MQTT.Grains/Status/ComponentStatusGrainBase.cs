using rPDU2MQTT.Grains.Abstractions.Status;

namespace rPDU2MQTT.Grains.Status;

/// <summary>
/// Shared base for every Status-board component grain, so a component type is nothing but its verdict rule.
/// <para>
/// The base owns the lifecycle of a status: hold the last report and when it arrived, evaluate on demand (so
/// an "…ago" never goes stale between publishes), publish to the <see cref="IStatusBoardGrain"/> whenever the
/// verdict changes, re-evaluate on a tick so a component that goes quiet turns amber on its own, and finally
/// drop itself from the board once nothing has reported it for long enough to conclude it's gone.
/// </para>
/// <para>
/// Silence is handled here, uniformly: no component has to know how to say "I haven't heard from anyone".
/// </para>
/// </summary>
public abstract class ComponentStatusGrainBase : Grain, IComponentStatusGrain
{
    /// <summary>Re-evaluate this often, so a fresh→silent transition reaches the board without a reader.</summary>
    private static readonly TimeSpan Tick = TimeSpan.FromSeconds(10);

    /// <summary>Past this with no report, the verdict is "nobody is telling us about this any more".</summary>
    private const int SilentAfterSeconds = 90;

    /// <summary>Past this, the component is gone rather than quiet — retire the card and the grain.</summary>
    private const int GiveUpAfterSeconds = 300;

    /// <summary>A component's verdict: the dot, the badge, and the static part of the detail line.</summary>
    protected readonly record struct Verdict(StatusLevel Level, string State, string? Detail);

    protected ComponentReport report = new() { Enabled = false };

    private DateTime? reportedUtc;
    private ComponentStatus? published;
    private IGrainTimer? timer;

    /// <summary>Where this component sorts on the board (broker first, nodes last).</summary>
    protected abstract int Order { get; }

    /// <summary>Card title when the reporter doesn't supply one.</summary>
    protected abstract string DefaultTitle { get; }

    /// <summary>How the consumer should render this card's instant, if it shows one.</summary>
    protected virtual AgeStyle Age => AgeStyle.None;

    /// <summary>The rule: this component's facts → its verdict. Pure; no awaits, no grain calls.</summary>
    protected abstract Verdict Evaluate(DateTime nowUtc);

    protected string Id => this.GetPrimaryKeyString();

    private IStatusBoardGrain Board => GrainFactory.GetGrain<IStatusBoardGrain>(0);

    public virtual async Task Report(ComponentReport incoming)
    {
        report = incoming;
        reportedUtc = DateTime.UtcNow;
        // KeepAlive: the component has to keep re-evaluating (and eventually retire itself) with nobody reading.
        timer ??= this.RegisterGrainTimer(TickAsync, new GrainTimerCreationOptions(Tick, Tick) { KeepAlive = true });
        await PublishIfChanged();
    }

    public Task<ComponentStatus> Current() => Task.FromResult(Compose(DateTime.UtcNow));

    public override Task OnDeactivateAsync(DeactivationReason reason, CancellationToken cancellationToken)
    {
        timer?.Dispose();
        return base.OnDeactivateAsync(reason, cancellationToken);
    }

    private ComponentStatus Compose(DateTime now)
    {
        var silentFor = reportedUtc is { } at ? (now - at).TotalSeconds : double.MaxValue;

        // Never reported / gone quiet: the base answers, not the component — it has no facts to reason from.
        var verdict =
            reportedUtc is null ? new Verdict(StatusLevel.Off, "Unknown", "Nothing has reported this")
            : silentFor > SilentAfterSeconds ? new Verdict(StatusLevel.Warn, "No report", "Last reported")
            : Evaluate(now);

        var silent = reportedUtc is not null && silentFor > SilentAfterSeconds;
        return new ComponentStatus
        {
            Id = Id,
            Title = string.IsNullOrWhiteSpace(report.Title) ? DefaultTitle : report.Title!,
            Level = verdict.Level,
            State = verdict.State,
            Detail = verdict.Detail,
            EventUtc = silent ? reportedUtc : report.EventUtc,
            Age = silent ? AgeStyle.Ago : Age,
            UpdatedUtc = now,
            Order = Order,
        };
    }

    private async Task PublishIfChanged()
    {
        var next = Compose(DateTime.UtcNow);
        if (published is { } p && Same(p, next)) return;
        published = next;
        await Board.Publish(next);
    }

    private async Task TickAsync(CancellationToken ct)
    {
        // Nobody has reported this for ages: the component isn't quiet, it's gone. Retire the card, then us.
        if (reportedUtc is { } at && (DateTime.UtcNow - at).TotalSeconds > GiveUpAfterSeconds)
        {
            await Board.Drop(Id);
            timer?.Dispose();
            timer = null;
            DeactivateOnIdle();
            return;
        }
        await PublishIfChanged();
    }

    /// <summary>Same card? Compares the verdict and its inputs — not <c>UpdatedUtc</c>, which always moves.</summary>
    private static bool Same(ComponentStatus a, ComponentStatus b)
        => a.Level == b.Level && a.State == b.State && a.Detail == b.Detail
        && a.Title == b.Title && a.EventUtc == b.EventUtc && a.Age == b.Age;
}
