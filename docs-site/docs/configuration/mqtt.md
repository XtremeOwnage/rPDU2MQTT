---
title: MQTT
---

# MQTT

## Credentials (Optional)

To connect to your MQTT broker, you can optionally specify a username and password.

If- your MQTT broker requires authentication, you will be required to provide a username and password.

```yaml
Mqtt:
  Credentials:
    Username: "user"    # Replace with your MQTT username
    Password: "password" # Replace with your MQTT password
```

## Connection (Optional)

`Scheme` selects how the broker is reached. When it is omitted, the scheme is inferred from `Port`
(8883 → `mqtts`, 8000 → `ws`, 8884 → `wss`, anything else → `mqtt`), and when `Port` is omitted it
defaults to the well-known port for the scheme.

| Scheme  | Transport             | Default port |
|---------|-----------------------|--------------|
| `mqtt`  | Plain TCP             | 1883         |
| `mqtts` | TLS                   | 8883         |
| `ws`    | WebSocket             | 8000         |
| `wss`   | WebSocket over TLS    | 8884         |

```yaml
Mqtt:
  Connection:
    Host: "broker.example.com"
    Scheme: "mqtts"          # omit to infer from Port
    ValidateCertificate: true # set false to accept a self-signed broker certificate (TLS schemes only)
```

## Parent Topic (Optional)

This defines the parent topic under which all MQTT keys will be published.

```yaml
Mqtt:
  ParentTopic: "rpdu2mqtt"  # Customize this to your desired parent topic
```

## Client ID (Optional)

This sets the client ID that the service will use when connecting to the MQTT broker.

```yaml
Mqtt:
  ClientID: "rpdu2mqtt"  # Customize as needed
```

## KeepAlive (Optional)
This defines the keep-alive interval (in seconds) for the MQTT connection.

```yaml
Mqtt:
  KeepAlive: 60  # Adjust as necessary
```

## Last Will / Availability (Optional)
By default the bridge registers an MQTT **Last-Will** message and sets an `availability_topic` on every
entity, so Home Assistant marks them **unavailable the instant the bridge disconnects**.

```yaml
Mqtt:
  LastWill: true   # default
```

Set `LastWill: false` to disable both the Last-Will and the availability topic. Entities then rely on
**`HomeAssistant.SensorExpireAfterSeconds`** (the `expire_after` timeout) to go unavailable once their
data goes stale — tune that value to control how long until they show unavailable:

```yaml
Mqtt:
  LastWill: false
HomeAssistant:
  SensorExpireAfterSeconds: 300   # how long stale sensors stay "available"
```

> Note: `expire_after` only applies to sensors/binary-sensors. Outlet **switches** have no
> `expire_after` in Home Assistant, so with `LastWill: false` switches will not auto-mark unavailable.

## Message Timestamp (Optional)

Published measurements carry **the time the PDU was read** — not the time we happened to publish — so a
consumer can tell a fresh reading from a republished one.

```yaml
Mqtt:
  MessageTimestamp: None   # None (default) | UserProperty | Payload
```

> Both non-`None` modes change what goes on the wire, so neither is on by default: turn one on deliberately
> and watch the next poll land before you walk away from it.

| Mode | What a measurement looks like |
| --- | --- |
| `UserProperty` | The payload is unchanged (a bare value); the time rides along as an MQTT v5 `timestamp` user property. **Test this against your broker before relying on it** — the payload being unchanged doesn't mean the packet is, and a broker or client that mishandles user properties on PUBLISH can drop the connection, which looks like everything stopping at once. |
| `Payload` | The payload becomes `{"value": "123.4", "timestamp": "2026-07-21T18:30:15.250Z"}`. Home Assistant discovery adapts automatically (the sensors get `value_template: {{ value_json.value }}`), but anything reading these topics by hand needs updating — which is why it isn't the default. |
| `None` | No timestamp at all — the behaviour before this option existed. **Default.** |

The timestamp is ISO-8601 UTC to milliseconds. The value stays a **string** in `Payload` mode, because that's
how the PDU reports it — re-typing it as a number would turn `0.00` into `0` and lose the device's precision.

> The energy-flow export (`EnergyFlow.MqttExport`) publishes a JSON payload already, so it always includes a
> `timestamp` field regardless of this setting. For a rolled-up tier it's the **oldest** contributing
> snapshot's time — a roll-up is only as current as its stalest input.

## Connection Details (Required)
Configure the connection to your MQTT broker:

```yaml
Mqtt:
  Connection:
    Host: "localhost"  # Replace with your MQTT broker's IP or hostname
    Port: 1883         # Replace with the MQTT broker's port number
    Timeout: 15        # Connection timeout in seconds
    ValidateCertificate: true  # Set to false if you're using self-signed certificates
```
