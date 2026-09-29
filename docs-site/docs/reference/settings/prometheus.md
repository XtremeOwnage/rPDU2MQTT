---
title: Prometheus
---

# Prometheus

Generated from `rPDU2MQTT --emit-schema`. Keys are case-insensitive. `[]` marks a list item and `<name>` a map key of your choosing. A blank default means none is declared.

Prometheus metrics exporter

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `Prometheus` | object |  | Prometheus metrics exporter |
| `Prometheus.Exporter` | bool | `false` | Expose a /metrics endpoint for Prometheus to scrape. |
| `Prometheus.NodeTags` | object |  | Limit the energy-flow metrics to nodes with particular tags. Empty exposes every node. Filtering changes only what is scraped — never a value, and never any other destination. |
| `Prometheus.NodeTags.Include` | list |  | Only send nodes carrying at least one of these tags. Empty sends every node. |
| `Prometheus.NodeTags.Exclude` | list |  | Never send nodes carrying any of these tags. Takes precedence over Include. |
| `Prometheus.Port` | int | `9184` | Port the /metrics endpoint listens on (Exporter). |
| `Prometheus.MetricNameTemplate` | string | `rpdu2mqtt_{type}` | Template for Prometheus metric names. Placeholders: {type}, {device}, {source} (a.k.a. {outlet}), {units}. e.g. 'rpdu2mqtt_{type}' -> rpdu2mqtt_realpower; 'pdu_{device}_{type}' -> pdu_rack_pdu_1_realpower. (device/source/units are also emitted as labels.) |
| `Prometheus.Labels` | list |  | Labels attached to every exported metric. Available: device, device_name (the device's display name), source, name (the outlet/entity's display name), number, type, type_name (the measurement said in English, e.g. 'Real Power'), units, instance (PDU instance key), hierarchy (the energy-flow tier feeding it). Changing this changes every metric's label set. |
| `Prometheus.Pushgateway` | object |  | Push metrics to a Prometheus Pushgateway. |
| `Prometheus.Pushgateway.Enabled` | bool | `false` | Push metrics to a Pushgateway. |
| `Prometheus.Pushgateway.Url` | string |  | Pushgateway endpoint, e.g. http://pushgateway:9091/metrics. |
| `Prometheus.Pushgateway.Job` | string | `rpdu2mqtt` | The 'job' label applied to pushed metrics. |
| `Prometheus.Pushgateway.IntervalSeconds` | int | `0` | How often to push, in seconds. Falls back to the PDU poll interval when 0. |
