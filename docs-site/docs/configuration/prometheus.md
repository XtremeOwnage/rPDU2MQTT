---
title: Prometheus
---

# Prometheus

Each measurement type becomes a gauge (e.g. `rpdu2mqtt_realpower`) labelled by `device`, `source`, and
`units`. Two independent delivery methods — enable **either or both**:

- **`Exporter`** — expose a `/metrics` endpoint for Prometheus to **scrape** (pull).
- **`Pushgateway`** — **push** to a Prometheus **Pushgateway** (for setups where scraping isn't practical).

```yaml
Prometheus:
  Exporter: false       # expose /metrics for scraping
  Port: 9184            # /metrics endpoint port (Exporter)
  MetricNameTemplate: "rpdu2mqtt_{type}"  # naming template; {type} = measurement type
  Pushgateway:
    Enabled: false      # push to a Pushgateway
    Url: "http://pushgateway:9091/metrics"
    Job: "rpdu2mqtt"
    IntervalSeconds: 0  # 0 = use the PDU poll interval
```

> The older `Prometheus.Enabled: true` still works — it's treated as `Exporter: true`.

**Customizing metric names.** `MetricNameTemplate` controls the generated metric name. Placeholders:

| Placeholder | Value |
| --- | --- |
| `{type}` | measurement type (honoring its Overrides.Measurements ID) |
| `{device}` | device name |
| `{source}` / `{outlet}` | outlet or entity name |
| `{units}` | measurement units |

For example `"pdu_{device}_{type}"` yields `pdu_rack_pdu_1_realpower`. The result is lower-cased with
non-alphanumeric characters replaced by `_` (so pick a template that starts with a letter). Note that
`device`, `source`, and `units` are **also always emitted as Prometheus labels**, so you can keep the
default `rpdu2mqtt_{type}` and aggregate/filter by label (the idiomatic approach), or encode them into
the name if you prefer.

**Friendly names in labels.** The default labels are object-id forms (`device="rack_pdu_1"`,
`source="outlet_10"`) — stable, but not what the thing is *called*. `Prometheus.Labels` can add the
human forms alongside them:

```yaml
Prometheus:
  Labels: [device, device_name, source, name, type, type_name, units]
```

| Label | Example | What it is |
| --- | --- | --- |
| `device` / `device_name` | `rack_pdu_1` / `Rack PDU 1` | the PDU's id form / its display name |
| `source` / `name` | `outlet_10` / `Dell MD1200` | the outlet or entity's id form / its display name |
| `type` / `type_name` | `realpower` / `Real Power` | the measurement type / said in English |
| `number`, `units`, `instance`, `hierarchy` | `10`, `W`, `rack-b`, `Rack Circuit A` | outlet number, units, PDU instance key, the energy-flow tier feeding it |

> The default set stays `[device, source, units]` on purpose: adding a label changes the identity of every
> existing time series, which breaks continuity in dashboards that are already recording. Opt in when you
> want it.

Every gauge's **HELP** text is the measurement said in English with its unit
(`Real Power (W), measured by rPDU2MQTT.`), so series are readable in Grafana's metric browser without
adding any labels at all.

You can also rename an individual measurement type via its **Measurements override ID**, which replaces
`{type}`. For example, with the default template:

```yaml
Overrides:
  Measurements:
    realPower:
      ID: power      # -> rpdu2mqtt_power instead of rpdu2mqtt_realpower
```

The GUI **Paths** tab (and the Overrides "Preview generated paths" button) show the resulting metric
names so you can confirm them before deploying.
