---
title: MQTT
---

# MQTT

Generated from `rPDU2MQTT --emit-schema`. Keys are case-insensitive. `[]` marks a list item and `<name>` a map key of your choosing. A blank default means none is declared.

MQTT Configuration

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `MQTT` | object |  | MQTT Configuration |
| `MQTT.Credentials` | object |  | Optional credentials to connect to MQTT |
| `MQTT.Credentials.Username` | string |  | Username to log in as |
| `MQTT.Credentials.Password` | string (secret) |  | Password to login with |
| `MQTT.ClientID` | string |  | The client-id used when connecting to MQTT. |
| `MQTT.ImportProfiles` | list |  | How to read another publisher's topics on the MQTT Import page, for publishers with no built-in profile (ESPHome and Z-Wave JS are built in). A profile says which topics to look at and what each one measures, so the page can offer them as energy-flow nodes. For a publisher sending 'tele/kitchen/SENSOR/Power', the pattern 'tele/{device}/SENSOR/{measure}' captures device 'kitchen' and measure 'Power', and a Metrics entry of Power -> realpower says what that measure is. |
| `MQTT.ImportProfiles[].Name` | string |  | Name shown in the MQTT Import source list. |
| `MQTT.ImportProfiles[].Filter` | string |  | Subscription filter to browse, e.g. 'tele/#'. Narrow it: a broker's ACL may refuse '#'. |
| `MQTT.ImportProfiles[].Pattern` | string |  | Topic shape, with {device} and {measure} marking the parts to capture and '+' matching any single segment, e.g. 'tele/{device}/SENSOR/{measure}'. Both may share one segment where a publisher names its channel and its measure together: 'esphome/devices/+/sensor/{device}_{measure}/state' reads 'n30_2_1_current' as channel 'n30_2_1' measuring current. Where such a segment splits is decided by the Metrics map below, so a measure that itself contains the separator (apparent_power) still resolves. |
| `MQTT.ImportProfiles[].JsonField` | string |  | Field holding the value when the payload is JSON — dotted for nesting. Leave blank when the payload is the bare number. |
| `MQTT.ImportProfiles[].Metrics` | map |  | Which captured {measure} supplies which metric. A measure that is not listed is ignored, so this is also the filter for the readings worth importing. Choose 'energy_d' for a counter the device zeroes each day (e.g. ESPHome's energy_d); it is imported as energy with a daily-reset counter. |
| `MQTT.ImportProfiles[].Tags` | list |  | Tags put on every node imported through this profile, on top of the tag typed on the MQTT Import page. Use them in a destination's tag filter to keep these readings from being exported back where they came from. |
| `MQTT.ParentTopic` | string | `rPDU2MQTT` | The parent topic for MQTT messages. |
| `MQTT.Connection` | object |  | Connection details for MQTT Broker |
| `MQTT.Connection.Scheme` | one of `mqtt`, `mqtts`, `ws`, `wss` |  | How to reach the broker: mqtt (plain TCP), mqtts (TLS), ws (WebSocket) or wss (WebSocket over TLS). Leave unset to infer from the port. |
| `MQTT.Connection.Host` | string |  | Hostname or IP to connect to. |
| `MQTT.Connection.Port` | int |  | The port to connect to. Range 0–65535. |
| `MQTT.Connection.Timeout` | int |  | Default connection timeout. Range 1–3600. |
| `MQTT.Connection.ValidateCertificate` | bool | `true` | Enables certificate validation |
| `MQTT.PublishTimeoutSeconds` | int | `15` | Seconds to wait for the broker to acknowledge a publish before abandoning it and failing the pass loudly. Stops one unacknowledged message from silently wedging publishing altogether. Range 1–600. |
| `MQTT.KeepAlive` | int |  | The keepalive interval for the MQTT connection in seconds. Range 1–2147483647. |
| `MQTT.LastWill` | bool | `true` | Publish a Last-Will message and set an availability topic on entities, so Home Assistant marks them unavailable immediately when the bridge disconnects. When off, entities instead rely on HomeAssistant.SensorExpireAfterSeconds (expire_after) to go unavailable. |
| `MQTT.MessageTimestamp` | one of `None`, `UserProperty`, `Payload` | `None` | Carry the time a measurement was read. 'None' (default) publishes exactly as before. 'UserProperty' adds an MQTT v5 'timestamp' property and leaves the payload alone — verify it against your broker first, since a broker or client that mishandles user properties on PUBLISH can drop the connection. 'Payload' publishes {"value": …, "timestamp": …} instead of a bare value (Home Assistant discovery adapts automatically). |
