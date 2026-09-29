---
title: History
---

# History

The Flow, Energy and Trends pages read past readings through one backend, chosen by `History.Provider`.

```yaml
History:
  Enabled: true
  Provider: local          # which backend the pages READ from
  LocalEnabled: true       # whether the bridge KEEPS its own copy — on by default, whatever it reads from
  LocalPath: ''            # empty: the directory the deployment mounted, else one beside the program
  LocalRawKeepDays: 7        # as they arrive
  LocalMinuteKeepDays: 90    # a minute at a time
  LocalHourKeepDays: 730     # an hour at a time
  LocalDayKeepDays: 36500    # a day at a time
  ToleranceSeconds: 30
```

**Recording and reading are separate.** `LocalEnabled` says whether the bridge keeps its own copy of every
reading; `Provider` says which backend the pages read from. Keeping the copy is on by default and goes on
whatever is chosen, because a store that is only written while it is also the chosen backend is empty on the
day someone switches to it — which is the day they wanted a year of readings. Turn `LocalEnabled` off and the
bridge stores nothing of its own.

**`local` is the bridge's own store, and the default to read from.** Every node's readings are written on the same sweep
that already reads them, into a directory of fixed-interval files — one per series, per resolution, per
chunk of time. There is no index and nothing to query: a reading's place in a file is arithmetic
(`(when − start) / interval`), so a window is a seek and a sequential read, and the whole database is a
directory you can copy, tar or mount read-only.

- **Every metric the bridge understands** is recorded for every node that reports one: power, apparent power,
  energy, the day's energy, current, voltage, frequency, power factor, state of charge, any other percentage,
  and temperature — plus the return lanes (battery charge, grid export) as series of their own. A metric a
  node does not report is not stored for it, and costs nothing. A source can be bound to any of them except
  the day's energy, which the bridge works out from a counter's rise rather than reading.
- **A slot nobody wrote is "no reading"**, stored as NaN. Unknown is never a zero, in the files or out of them.
- **Four resolutions, each kept for as long as you choose.** The readings as they arrive
  (`LocalRawKeepDays`), a minute at a time (`LocalMinuteKeepDays`), an hour (`LocalHourKeepDays`), and a day
  (`LocalDayKeepDays`). A coarser tier holds the **last** reading of each bucket — what a read asks for
  anyway, and what keeps a counter's meaning, which an average would not. A chart over a month is answered a
  day at a time: thirty seeks, not a walk through a quarter of a million readings.
- **The raw tier is what costs the disk**; the rest is rounding. A century of daily readings is about 300 KB
  per series, so there is little reason to drop any — which is why there is no separate monthly tier: a year
  drawn by month is twelve reads of the daily one.
- **Retention deletes whole files**, never rewrites one: a chunk is a day, a month or a year of one series.
- **Roughly 1 GB a year** for two hundred series read every ten seconds, with the defaults.

Put it on a volume. The Helm chart does this by default (`history.persistence.enabled`, mounted at
`/data/history`) and passes that path as `RPDU2MQTT_HISTORY_DIRECTORY`; anywhere else and the readings go
with the container at the next restart. `LocalPath` overrides it when set — left empty, the History page
says which directory is in use, how many series are in it and how large it is. A read-only
mount is reported by the backend test rather than discovered at the first sweep.

**Copying history between backends.** The History page's **Copy history** panel copies every node's history
from one backend to another in the background, and shows how far it has got. Any backend can be read: `local`,
`emoncms`, `prometheus`, `homeassistant`. Only `local` and `emoncms` can be written: Prometheus takes past
samples only through a remote-write receiver, and Home Assistant only as hourly statistics. The copy reads each
local tier's span at that tier's interval (the last `LocalRawKeepDays` at the raw interval, then a minute, an
hour, a day), and by default writes only where the destination holds nothing: readings already there are kept, and a second
run writes nothing. **When both have a reading** can instead be set to replace the destination's with the
source's (`conflicts=replace`); readings only the destination has are left alone. Replacing is available for
`local` only, since EmonCMS has no way to delete a range of points. A gap in the source stays a gap. EmonCMS is written only into feeds provisioning has already
created. Only the leader writes to `local`. `days` limits how far back it reads (empty means ten years), and the
API is `POST /api/history/copy?from=emoncms&to=local&days=45&conflicts=keep`, with `GET` for progress.

The other three read from a service you already run — `prometheus`, `emoncms`, `homeassistant` — and are
unchanged: they answer for whatever was exported to them, including readings from before this bridge existed.
