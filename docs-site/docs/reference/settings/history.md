---
title: History
---

# History

Generated from `rPDU2MQTT --emit-schema`. Keys are case-insensitive. `[]` marks a list item and `<name>` a map key of your choosing. A blank default means none is declared.

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `History` | object |  |  |
| `History.ValueFallback` | bool | `false` | Let the history backend supply a value for any node nothing live is reporting. Off by default: a stored value is older than a live one, and for a node whose source has stopped it replaces an honest "no data" with a figure that looks current. |
| `History.Enabled` | bool | `false` | Let the Flow and Energy pages show a past moment, read from Prometheus or EmonCMS. |
| `History.Provider` | one of `local`, `prometheus`, `emoncms`, `homeassistant` | `local` | Where past readings come from: 'local' (kept by the bridge itself, no other service needed), 'prometheus', 'emoncms' or 'homeassistant'. |
| `History.PrometheusUrl` | string |  | Prometheus base URL to query, e.g. http://prometheus:9090 . This is the server that scrapes this bridge, not the /metrics endpoint it exposes. |
| `History.LocalEnabled` | bool | `true` | Keep a copy of every reading in the bridge's own store, whether or not it is the backend the pages read from. On by default: a store nothing wrote to is empty on the day you want it. |
| `History.LocalPath` | string |  | Where the bridge keeps its own history: a directory of fixed-interval files, one per series. Left empty it uses the directory the deployment mounted for it (RPDU2MQTT_HISTORY_DIRECTORY), else one beside the program — which goes with the container when it restarts. |
| `History.LocalRawKeepDays` | int | `7` | How many days of readings are kept at the rate they arrive. Older ones are still there a minute at a time. Range 1–3650. |
| `History.LocalMinuteKeepDays` | int | `90` | How many days are kept a minute at a time. Range 1–3650. |
| `History.LocalHourKeepDays` | int | `730` | How many days are kept an hour at a time. Two years of hourly readings for two hundred series is about 3 MB. Range 1–36500. |
| `History.LocalDayKeepDays` | int | `36500` | How many days are kept a day at a time — the resolution a month or a year of history is drawn from. A century of them for two hundred series is about 60 MB, so there is little reason to drop any. Range 1–36500. |
| `History.ToleranceSeconds` | int | `30` | How far either side of the requested moment to look for a sample, in seconds. A scrape or feed interval longer than this returns nothing rather than a value from a different time. Range 1–600. |
