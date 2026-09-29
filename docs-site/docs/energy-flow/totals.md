---
title: Totals and counters
---

# Totals and counters

## Where today's totals are kept

`EnergyFlow.Aggregation` accumulates each node's energy since the period boundary. That state has to
outlive the process, or every restart starts the day again:

| `Cache.Enabled` | Store | Survives a restart |
| --- | --- | --- |
| on | the shared cache (Valkey/Redis) | yes, if the cache persists — the chart's `valkey.persistence` is on by default |
| off | `energy-totals.json` beside the binary | only if that path is on a volume, which the chart does not mount |

In Kubernetes with the cache off, the file lives in the container's own filesystem, so **every rollout
loses the day's totals**. On a deployment tracking a moving tag that is several times a day.

When nothing carries over the bridge says so, once, at startup:

```
Daily energy totals did not carry over: the file store held nothing. Today's figures accumulate from
now, not from the period boundary …
```

…and the Overview labels the figures `only since HH:MM — totals did not carry over` rather than "since the
day rolled over". Trends is unaffected: it reads the history backend, which still holds the whole day.

## Lifetime counters never go backwards

The `energy` and `energy_in` fields feed sensors declared `state_class: total_increasing`. Home Assistant
reads a decrease in such a series as a meter reset and records the next reading as a delta from zero, so a
single dip writes a whole counter into one period.

A roll-up dips without anything being wrong at the meter: a parent's total is the sum of the links whose
flow is *known*, so a contributor going stale makes the parent smaller. That figure is the energy of the
part that happened to be reporting, not the node's energy.

So a value below one already published is **withheld**, and logged once:

```
Holding back main_panel|energy: 9800 is below the 14616.54 already published. …
```

The sensor holds its last good value until the reading passes that figure again, which happens by itself
when the missing contributor comes back — logged as `… is being published again`. A counter that genuinely
restarts (a replaced meter) stays withheld until it passes its old peak or the bridge restarts; that is the
safer way round, because the alternative rewrites statistics that cannot be recovered.

`energy_d` is not guarded: it re-bases every period by design, and that reset is one Home Assistant
handles correctly.

## Repairing Home Assistant statistics

A tier's `energy` field feeds a sensor declared `state_class: total_increasing`. Home Assistant reads a
drop in such a series as a meter reset and takes the next reading as a delta from zero, so anything that
makes the value fall records a whole counter as one period's usage.

If the Energy dashboard shows megawatt-hours a day, the statistics already stored have to be cleared —
fixing the publisher stops new corruption but cannot repair what the recorder wrote:

```bash
pip install websockets
export HA_URL=http://homeassistant.local:8123
export HA_TOKEN=<long-lived access token>

python3 scripts/ha-clear-energyflow-statistics.py --dry-run   # list what would go
python3 scripts/ha-clear-energyflow-statistics.py --yes       # clear it
```

It touches only `sensor.energyflow_*` — the sensors this bridge publishes. The same thing can be done by
hand in **Developer tools → Statistics**, which offers to fix or clear one entity at a time.

Run it *after* the corrected build is live, or the next bad reading lands on top of the corrected total.

## Gauges

A node with a **Gauge max** set gets a dial on the Energy page showing its reading as a proportion of that
maximum — a PV array's peak output, an inverter's rating, a main breaker's size. Set it per node on the
**Nodes** tab (solar, battery, grid, load and inverter kinds).

Leave it blank and the tile shows the plain reading instead. **No ceiling is ever inferred**: deriving one
from the highest value seen would redefine "full" on the first spike and make the same needle position mean
something different tomorrow. A reading past the maximum draws full and is flagged rather than running off
the end — the reading isn't wrong, the stated maximum is too low, and those are different problems.

## Nothing is computed behind your back

Every number the flow shows is either measured, summed from measured children, or **inferred** — and the
diagram says which. An inferred value is labelled `· inferred` on the chart and explained in the hover card;
it is never rendered the way a metered reading is.

Two behaviours compute rather than read, and both are switches you can see on the **Flow** tab under
*Energy roll-up*:

| Switch | What it does | Default |
| --- | --- | --- |
| Derive kWh from power | Integrates watts over time for nodes with no energy counter. An estimate — a real energy source always wins. | Off |
| Infer from a single supply path | Fills in an unmeasured node from what it feeds, when only one of several possible routes could have supplied it. | On |

The second one is worth understanding. When a node has exactly **one** feeder, propagating demand up it is
arithmetic, not a guess — a PDU's total is its outlets' — and that is always done. When a node has
**several** feeders and all but one are ruled out (by `Mode: none`, or by their source having gone silent),
picking the survivor is a claim about the hierarchy you drew rather than anything measured. That is what this
switch governs, and what gets labelled `inferred`. Turn it off and such a node reads "no data" instead;
plain roll-ups are unaffected either way.

## Daily energy vs. lifetime energy

Two cumulative counters can only be compared if they started counting at the same moment, and the ones on
your system did not. A PDU's `energy` measurement comes from firmware and has been running since the unit
was commissioned; a node's comes from whenever you bound its source. Put both on one diagram and the
arithmetic breaks in a way that looks like a bug in the chart:

```
EG4 FlexBoss 21 · 740 kWh  ──▶  Main Panel · 8,358.187 kWh  ──▶  Rack-PDU-1 · 7,371.006 kWh
                                                             └─▶  Rack-PDU-2 ·   987.181 kWh
```

The right-hand side adds up exactly. The panel and its feeder disagree by a factor of eleven — not because
anything is measured wrong, but because 740 and 8,358 are counted from different years.

**Daily totals fix this.** Every node and outlet is re-based at local midnight, so every figure covers the
same window and legitimately sums. Pick **Energy (kWh)** in the Flow page's measurement selector: it draws
each tier's energy since the period boundary (`energy_d`), the energy view whose numbers reconcile. The
lifetime `energy` counter is still published — it is what Home Assistant and EmonCMS have recorded history
against.

```yaml
EnergyFlow:
  Aggregation:
    TrackPeriods: true              # default. Daily totals per node AND per outlet.
    PeriodTimeZone: America/Chicago # blank = the host's zone (UTC in most containers)
    PeriodStartHour: 0              # 0 = midnight. 6 for a utility day that runs 06:00–06:00.
```

All three are edited on the **Flow** tab, under *Energy roll-up* (`EnergyFlow` is hidden from the generic
config form, since the Flow/Nodes editors replace it). `PeriodTimeZone` is a dropdown of the zones the server
can actually resolve — one that isn't listed wouldn't resolve at runtime either. The server's own clock and
the next rollover are shown right beneath it, and again on **Diagnostics**. Worth checking once: the boundary
is the server's clock, not your browser's.

Notes:

- **Not an estimate.** For an outlet — or any node bound to a real `energy` source — the daily figure is the
  *rise* of that counter since midnight: measured, not inferred, and independent of `Aggregation.Enabled`.
  A node that reports only power is the exception: there is no counter to take a rise of, so it needs
  `Aggregation.Enabled: true` to be integrated first. That stays opt-in because an integral of watts
  genuinely is an estimate.
- **Set `PeriodTimeZone`** (or `TZ` on the container). A day that rolls over at UTC midnight is not the day
  you or your utility are looking at. Diagnostics flags it in amber while it's unset, and in red if the zone
  you named doesn't exist on the server.
- A counter that goes backwards — a PDU reboot, a firmware clear — is treated as a reset, and the energy
  recorded before it is kept rather than subtracted.
- Unlike integration, a gap loses nothing: if a PDU is unreachable for an hour its counter kept running, so
  the whole hour arrives in the next reading.
- Nodes bound today are only incomparable until the next rollover, not forever.
- With `MqttExport` on, each tier also publishes `energy_d` and gets an **Energy Daily** sensor in Home
  Assistant (`total_increasing`, so HA reads the midnight drop as the start of a new day).
- Prometheus exports every tier as `rpdu2mqtt_flow_realpower`, `rpdu2mqtt_flow_energy` and
  `rpdu2mqtt_flow_energy_d`, labelled `node` / `name` / `kind` / `tier`. A tier nothing determines is
  **absent** from the scrape rather than scraped as `0`, so a dashboard shows a gap instead of a reading
  nobody took.
- Where two sides of a node still can't both be true, the diagram marks the node **⚠** and the hover card
  says how much more leaves it than arrives. On lifetime energy that is expected; on daily energy it means
  a feeder is missing or not reporting.
