---
title: EmonCMS
---

# EmonCMS

Pushes measurements to EmonCMS each poll (EmonCMS auto-creates the inputs). Delivery is either the
HTTP `input/post` API or EmonCMS's **MQTT input** on the broker rPDU2MQTT already uses.

```yaml
EmonCMS:
  Enabled: false
  Transport: Http                     # Http (input/post API) or Mqtt (publish to EmonCMS's MQTT input)
  Url: "http://emoncms.example.com"   # required for the Http transport (or set RPDU2MQTT_EMONCMS_APIKEY)
  ApiKey: "your-write-apikey"         # or set RPDU2MQTT_EMONCMS_APIKEY    (Http transport)
  Node: "rpdu2mqtt"
  Path: "input/post"                  # API path (relative to Url) to post to (Http transport)
  InputNameTemplate: "{device}_{source}_{type}"  # EmonCMS input key template (see below)
  MqttBaseTopic: "emon"               # values published to <base>/<node> as JSON (Mqtt transport)
```

**Input names (templating).** `InputNameTemplate` controls the per-measurement input key, the same way
`Prometheus.MetricNameTemplate` does. Placeholders: `{device}`, `{source}` (object-id form), `{name}`
(the formatted display name), `{number}` (outlet number; blank for circuits/phase/total), `{type}`
(honoring its `Overrides.Measurements` ID), and `{units}`. For example `{device}_{source}_{type}` →
`rack_pdu_1_dell_md1200_realpower`. Leave it **blank** to fall back to the full raw identifier (the old,
verbose default). The result is lower-cased with non-alphanumeric characters replaced by `_`.

**MQTT transport.** With `Transport: Mqtt`, measurements are published as a JSON object to
`<MqttBaseTopic>/<Node>` (e.g. `emon/rpdu2mqtt`) — point EmonCMS's [MQTT input](https://docs.openenergymonitor.org/emoncms/postingdata.html#sending-data-to-emoncms-using-mqtt)
at the same broker. No `Url`/`ApiKey` needed.

**Testing & health.** The GUI's EmonCMS section has a **Test EmonCMS connection** button (validates the
server + API key for HTTP, or broker connectivity for MQTT), and the **Diagnostics** page shows the last
export result (ok / error, transport, input count).
