---
title: Totals and counters
---

# Totals and counters

## Daily and lifetime energy

| Field | Meaning | Resets |
| --- | --- | --- |
| `energy` | Lifetime counter | Never |
| `energy_d` | Energy since the day boundary | Daily, at `PeriodStartHour` in `PeriodTimeZone` |

- Lifetime counters from different devices start at different times and do not add up across tiers. Use **Energy (kWh)** on the Flow page, which draws `energy_d`.
- For a node with an energy source, `energy_d` is the counter's rise since the boundary.
- For a node with power only, `energy_d` needs **Derive kWh from power** (`Aggregation.Enabled`).
- A counter that goes backwards is treated as a reset. Energy before it is kept.
- Set `PeriodTimeZone` or `TZ`. Diagnostics flags an unset or unknown zone.

Settings: [Flow settings](flow.md#settings).

## Where daily totals are stored

| `Cache.Enabled` | Store | Survives restart |
| --- | --- | --- |
| on | Valkey / Redis | Yes, with persistence (chart default) |
| off | `energy-totals.json` beside the binary | Only on a persistent volume |

When totals do not carry over, the log says `Daily energy totals did not carry over`, and the Overview labels figures `only since HH:MM`.

## Lifetime counters never go backwards

`energy` and `energy_in` are published as `state_class: total_increasing`. A value lower than one already published is held back and logged:

```
Holding back main_panel|energy: 9800 is below the 14616.54 already published.
```

Publishing resumes when the value passes the old figure (`… is being published again`), or after a restart. `energy_d` is not held back.

## Repairing Home Assistant statistics

For `sensor.energyflow_*` statistics already corrupted by a counter drop:

```bash
pip install websockets
export HA_URL=http://homeassistant.local:8123
export HA_TOKEN=<long-lived access token>
python3 scripts/ha-clear-energyflow-statistics.py --dry-run
python3 scripts/ha-clear-energyflow-statistics.py --yes
```

Or **Developer tools › Statistics** in Home Assistant, one entity at a time.

## Published fields

| Destination | Fields |
| --- | --- |
| MQTT tier export | `value`, `power`, `energy`, `energy_out`, `energy_in`, `energy_d`, `soc` |
| Home Assistant | Power, Energy, Energy Daily sensors per tier |
| Prometheus | `rpdu2mqtt_flow_realpower`, `rpdu2mqtt_flow_energy`, `rpdu2mqtt_flow_energy_d`, labels `node`, `name`, `kind`, `tier` |

A tier with no value is absent from the scrape.
