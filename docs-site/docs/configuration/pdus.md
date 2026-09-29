---
title: PDUs
---

# PDUs

PDUs are configured under **`Pdus:`** — a map of named instances. A single PDU is just one entry
named `default`; add more entries to bridge several PDUs from one deployment. Each instance is polled
independently and published under its own MQTT/Home Assistant namespace (a lone instance is
un-namespaced, identical to a single-PDU setup).

```yaml
Pdus:
  default:                 # instance name (any key; "default" for a single PDU)
    Connection:
      Host: "10.0.0.10"
      Port: 80
    PollInterval: 5
  rack-b:                  # add more instances as needed
    Connection:
      Host: "10.0.0.11"
      Port: 80
```

> **Upgrading from v1:** the old single `PDU:` section is auto-migrated to `Pdus: { default: ... }`
> on load (with a one-time warning), so existing configs keep working — but update to `Pdus:` to
> silence it. The fields below apply **per instance** (under `Pdus.<name>`).

### Connection Details (Required)
Set up the connection details to your Power Distribution Unit (PDU).

```yaml
Pdus:
  default:
    Connection:
      Scheme: http         # http or https, based on your PDU's configuration
      Host: "localhost"    # Replace with your PDU's IP or hostname
      Port: 80             # Replace with your PDU's port number
      Timeout: 15          # Request timeout in seconds
      ValidateCertificate: true  # Set to false if using self-signed certificates
```

The same options in the GUI's **PDU** section (note **Enable Write Actions** for outlet control):


### Credentials (Optional)
Provide credentials if required to connect to the PDU.

```yaml
Pdus:
  default:
    Credentials:
      Username: "actionsUser"  # Replace with your PDU username
      Password: "actionsPass"  # Replace with your PDU password
```

### Credentials via environment / secrets (Optional)
To keep secrets out of `config.yaml`, MQTT and PDU credentials can be supplied via environment
variables. These override whatever is in the config file. For the **complete list of variables and
the full precedence rules** (env vs config file vs the Kubernetes CRD), see
[environment-variables.md](environment-variables.md).

| Variable | Overrides |
| --- | --- |
| `RPDU2MQTT_MQTT_USERNAME` / `RPDU2MQTT_MQTT_PASSWORD` | MQTT broker credentials |
| `RPDU2MQTT_PDU_USERNAME` / `RPDU2MQTT_PDU_PASSWORD` | PDU credentials |
| `RPDU2MQTT_EMONCMS_APIKEY` | EmonCMS write API key |
| `RPDU2MQTT_GUI_PASSWORD` | GUI Basic-auth password |
| `RPDU2MQTT_OIDC_CLIENT_SECRET` | GUI OIDC client secret |

For each variable, a `<NAME>_FILE` form is also supported: set it to a file path (e.g. a Docker
secret at `/run/secrets/mqtt_password`) and the value is read from that file. The `_FILE` form
takes precedence over the plain variable.

```yaml
# docker-compose example
services:
  rpdu2mqtt:
    environment:
      RPDU2MQTT_MQTT_PASSWORD_FILE: /run/secrets/mqtt_password
    secrets:
      - mqtt_password
```

### Polling Interval (Optional)
Set how often the PDU sensors should be polled and published to MQTT (in seconds).

```yaml
Pdus:
  default:
    PollInterval: 5  # Adjust the polling interval as needed
```

### Actions Enabled
Enable or disable the ability to perform write-actions on the PDU (e.g., toggling outlets).
Requires PDU `Credentials`. Disabled by default.

```yaml
Pdus:
  default:
    ActionsEnabled: true  # Set to false to disable any changes on the PDU
```

When enabled, each outlet gains the following **outlet operations** in Home Assistant
(and matching controls on the GUI's **PDU Control** page):

| Entity | Type | Action |
| --- | --- | --- |
| Switch | `switch` | Turn the outlet on / off |
| Reboot | `button` | Power-cycle the outlet |
| On Delay / Off Delay / Reboot Delay | `number` | Configure the outlet's on/off/reboot timing (seconds) |
| Power-On Action | `select` | What the outlet does when power is restored |
| Reset Statistics | `button` | Reset the outlet's accumulated energy statistics |

The GUI's **PDU Control** page is the easiest place to exercise these against a single outlet. It also
shows each outlet's current delays and power-on action so changes made from Home Assistant are
visible there, and lets you **rename the outlet's label on the PDU** (handy since the PDU's own web
UI is slow) — also gated by write actions.

> Power-On Action options are `on` / `off` / `last` (restore the pre-outage state).
