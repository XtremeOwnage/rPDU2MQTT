---
title: Quick start
---

# Quick start

## 1. Write a config

The smallest working `config.yaml` (from `Examples/Configuration/minimum-configuration-example.yaml`):

```yaml
Mqtt:
  Connection:
    Host: "your-mqtt-broker-ip-or-hostname"
    Port: 1883
  Credentials:
    Username: "admin"
    Password: "password"

Pdus:
  default:
    Connection:
      Host: your-pdu-ip-or-hostname
      Port: 80

HomeAssistant:
  DiscoveryEnabled: true
  DiscoveryTopic: "homeassistant"
```

Keys are case-insensitive. Credentials can come from the environment instead of the file; see
[Environment variables](../configuration/environment-variables.md).

## 2. Turn on the GUI

The GUI is off by default. Add:

```yaml
Gui:
  Enabled: true
  Port: 8080
  AuthType: Basic
  Username: admin
  Password: "change-me"
```

For the GUI's **Save** to work in a container, mount `config.yaml` writable (no `:ro`).

## 3. Run it

```yaml
services:
  rpdu2mqtt:
    image: ghcr.io/xtremeownage/rpdu2mqtt:stable
    restart: unless-stopped
    ports:
      - "8080:8080"
    volumes:
      - ./config.yaml:/config/config.yaml
```

```bash
docker compose up -d
docker compose logs -f
```

## 4. Check it

- **GUI:** browse to `http://<host>:8080`. The **Overview** page shows what the system is doing and
  whether every component is healthy; **Status** shows each hop on its own.
- **MQTT:** readings appear under the `ParentTopic` (default `rPDU2MQTT`). See
  [MQTT topics](../reference/mqtt-topics.md).
- **Home Assistant:** with discovery on, the bridge, each PDU and each outlet appear as devices.
- **Health:** `http://<host>:8081/healthz` answers `OK`; `/readyz` answers `READY` once MQTT is
  connected and a PDU poll has succeeded. See [Health checks](../reference/health.md).

![Status page: every hop from sources to destinations](../assets/screenshots/status.webp)

## Next

- Add solar, battery, grid and circuits: [Energy flow](../energy-flow/index.md).
- Tour every page: [Web GUI](../gui/index.md).
