# rPDU2MQTT

**Yes**, This is partially coded by AI. You can stop scrolling if that is what you came here looking for. You- can either accept that claude has been handling PRs, or- you can wait another 5 years for me to find time to do them myself. If you prefer the latter, then please feel free to use the [0.3.5 release.](https://github.com/XtremeOwnage/rPDU2MQTT/releases/tag/v0.3.5)


**Map the energy flow of an entire house, end to end — from individual solar panels to individual appliances — and publish it to MQTT, Home Assistant, Prometheus and EmonCMS.**

rPDU2MQTT is a small, container-friendly .NET service. It started as a bridge for Vertiv/Geist rack PDUs (it still is one, and a good one), but that turned out to be a single tier of a much bigger picture. The job now is the whole chain: every producer, every panel, every circuit and every device, measured wherever it can be measured, joined into one hierarchy, and rolled up so each tier's number is the sum of what's beneath it.

Data comes in over **MQTT**, **Modbus TCP** and the PDUs' own HTTP API; it goes out to **MQTT**, **Home Assistant** (auto-discovery, including the Energy Dashboard), **Prometheus** and **EmonCMS**. There's a built-in GUI for wiring it all up, and a **Helm chart + CRD** for Kubernetes.

> New to these PDUs? See this [blog post on metered/switched PDUs](https://static.xtremeownage.com/blog/2024/metered-switch-pdu/) for background on the units and their capabilities.

![rPDU2MQTT Live Data](docs/images/gui-live-data.webp)

---

## ⚡ The energy flow

This is the shape of the problem the project exists to solve — one house, measured from the panels on the roof to the plug behind the TV:

```mermaid
flowchart LR
  subgraph GEN["Generation"]
    P["Individual panels<br/>(Tigo)"] --> S["Strings"]
    S --> M["MPPTs<br/>(Modbus / MQTT)"]
    M --> INV["Inverter output<br/>(Modbus / MQTT)"]
  end

  INV --> BAT["Battery"]
  INV --> GB["GridBoss / transfer switch"]
  GRID["Grid"] --> GB

  subgraph PANELS["Load centers"]
    MAIN["Main panel"]
    SHED["Load-shedding panel"]
    SHOP["Shop panel"]
    HVAC["East HVAC panel"]
    POOL["Pool panel"]
  end

  GB --> MAIN & SHED & SHOP & HVAC & POOL

  subgraph CIRCUITS["Per-circuit metering"]
    CT["CT clamps<br/>(IotaWatt, …)"]
  end

  MAIN & SHED & SHOP & HVAC & POOL --> CT

  subgraph DEVICES["Per-device metering"]
    PDU["Vertiv rPDU outlets"]
    S31["Sonoff S31 plugs"]
    ZW["Z-Wave / Zigbee / ESPHome"]
  end

  CT --> PDU & S31 & ZW
```

Every tier is a node you define in the GUI; a node's value is whatever measures it (an MQTT topic, a Modbus register, a PDU outlet, a fixed figure), or the sum of its children when nothing measures it directly. Untracked consumption — the part of a panel its metered circuits don't account for — is a node type of its own, so the numbers add up honestly rather than silently.

Some of the hardware behind those tiers, if you're curious: [Sonoff S31 energy monitoring](https://static.xtremeownage.com/blog/2023/sonoff-s31---low-cost-energy-monitoring/), [metered/switched PDUs](https://static.xtremeownage.com/blog/2024/metered-switch-pdu/), and [an earlier version of this flow diagram](https://static.xtremeownage.com/blog/2023/home-assistant---energy-flow-diagram/) from a smaller house.

### Why not just do this in Home Assistant?

Because of the history. I keep a lot of energy data — six years of per-circuit measurements from my old house, at a 15-second interval, collected via IotaWatt. I may never use it. I like having it in case I do.

More than once, an update to Home Assistant or one of its plugins has renamed entities and broken things for me. This project owns the naming and the topology itself, and pushes it *out* to Home Assistant, EmonCMS, Prometheus and MQTT — so what those systems see is derived from one definition I control, rather than the other way round. It creates and updates the HA entities, maintains the Energy Dashboard, provisions the EmonCMS feeds, and exports Prometheus metrics for Grafana.

Should you use it? That's up to you. I built it for me, but made it public and tried to make sure it was at least half-way documented.

---

## ✨ Features

### The energy flow

- **Whole-house hierarchy** — define the tiers (panels → strings → MPPTs → inverter → transfer switch → load centers → circuits → devices) and how they feed each other; every tier rolls up the ones beneath it, per metric.
- **Any source per node** — bind a node's power/energy/current/… to an **MQTT topic** (Solar Assistant, ESPHome, Tasmota, anything already on your broker), a **Modbus TCP register** (inverters, meters, PLCs), a PDU outlet, or a fixed value.
- **Browse instead of guess** — autocomplete over the topics actually on your broker (with the metric and unit inferred from the payload), and a Modbus explorer that reads a block of registers and shows each decoding so you can pick the right one.
- **Untracked consumption** — a residual node reports what a measured parent's metered children don't account for, the way Home Assistant's energy dashboard does.
- **Sankey flow view** — the live diagram, editable by dragging, with per-tier MQTT export and Home Assistant Energy Dashboard sync.
- **Device templates** — ready-made node/register sets for known hardware (EG4 inverters, meters, …) to import and adjust.

### The PDU bridge

- **MQTT publishing** — every outlet/device/entity measurement (power, energy, current, voltage, power factor, …) published on each poll.
- **Home Assistant auto-discovery** — devices, sensors, and `problem` alarm binary-sensors created automatically; proper device hierarchy (`via_device`), MAC/IP connection info, and availability/`expire_after`.
- **Outlet control** (opt-in) — on/off **switches**, **reboot** buttons, configurable **on/off/reboot delays** (`number`), **power-on action** (`select`), and a **reset-statistics** button.
- **OneView clusters** — aggregates multiple PDUs; per-group **Sum/Avg/Min/Max** rollup sensors, plus **group actions** (All On / All Off / Reboot All) fanned out to member outlets, and the member switches mirrored onto the group device.
- **Configuration & control GUI** — a built-in web UI to view/edit/test the config, control outlets, rename PDU labels, browse live data, and see the generated MQTT/Prometheus/EmonCMS paths.
- **GUI authentication** — HTTP Basic, **OpenID Connect (SSO)** against any OIDC provider (Keycloak, Authentik, Authelia, Entra ID, Google, …), or none.
- **Prometheus** — scrape (`/metrics`) and/or Pushgateway, with a **customizable metric-name template**.
- **EmonCMS** — pushes inputs on each poll.
- **Kubernetes-native** — Helm chart, optional **`RpduConfig` CRD** as a writable config source, Argo CD example, health probes, NetworkPolicy, and Gateway API `HTTPRoute`.
- **Secrets-friendly** — credentials via `RPDU2MQTT_*` env vars / `*_FILE` Docker secrets, never required in the config file (see [environment variables & precedence](./Examples/Configuration/environment-variables.md)).

---

## 📸 Screenshots

### Home Assistant

The **bridge** device — every PDU, outlet, and OneView group as connected devices, plus Rediscover/Restart:

![Home Assistant bridge device](docs/images/home-assistant-bridge.webp)

An **outlet** as its own device — switch, sensors, configurable delays, and power-on action:

![Home Assistant outlet device](docs/images/home-assistant-outlet.webp)

A **OneView group** device — Sum/Avg/Min/Max rollup sensors, the member outlet switches, and All On / All Off / Reboot All:

![Home Assistant group device](docs/images/home-assistant-group.webp)

Standard Home Assistant history, dashboards, and automations come for free:

![Home Assistant power history](docs/images/home-assistant-history.webp)

### Configuration & control GUI

The structured **configuration** form (every option, generated from the model):

![GUI configuration](docs/images/gui-config.webp)

The **Control** tab — per-outlet On/Off/Reboot/Reset + editable label, plus group actions:

![GUI control tab](docs/images/gui-control.webp)

The **Paths** tab — the generated MQTT topic / Prometheus metric / EmonCMS key for every measurement:

![GUI paths](docs/images/gui-paths.webp)

### Metrics (Prometheus / EmonCMS)

Beyond MQTT, every measurement can be scraped by Prometheus and/or pushed to EmonCMS:

![EmonCMS inputs populated by rPDU2MQTT](docs/images/emoncms-inputs.webp)

---

## 🚀 Quick start (Docker Compose)

```yaml
services:
  rpdu2mqtt:
    image: ghcr.io/xtremeownage/rpdu2mqtt:stable
    restart: unless-stopped
    ports:
      - "8080:8080"   # optional GUI
    volumes:
      - ./config.yaml:/config/config.yaml:ro
    environment:
      RPDU2MQTT_MQTT_PASSWORD: "your-mqtt-password"
      RPDU2MQTT_PDU_PASSWORD: "your-pdu-password"   # only needed for outlet control
```

A minimal `config.yaml`:

```yaml
Mqtt:
  Connection: { Host: mqtt.example.com, Port: 1883 }
  ParentTopic: rPDU2MQTT
Pdu:
  Connection: { Host: pdu.example.com, Port: 80 }
  PollInterval: 5
HomeAssistant:
  DiscoveryEnabled: true
  DiscoveryTopic: homeassistant
Gui:
  Enabled: true
  Password: "change-me"
```

Then browse to `http://<host>:8080` for the GUI. See the full guides below.

---

## 📚 Documentation

| Guide | What's inside |
| --- | --- |
| [Configuration](./docs/Configuration.md) | Every config option — MQTT, PDU, overrides, control, Prometheus, EmonCMS, the GUI (incl. OIDC) and health checks. |
| [Environment variables & precedence](./Examples/Configuration/environment-variables.md) | All `RPDU2MQTT_*` vars and what overrides what (env vs config file vs CRD). |
| [Deployment](./docs/Deployment.md) | Docker, Docker Compose, Helm, Argo CD, the CRD config source, secrets, and verification. |
| [Aggregation (OneView)](./docs/Aggregation.md) | Multi-PDU clusters: rollup sensors and group actions. |
| [Kubernetes CRD](./docs/KubernetesCRD.md) | Using an `RpduConfig` custom resource as a writable config source. |

---

## ❓ Help

- Ask in [my Discord](https://static.xtremeownage.com/discord) (tag **@XtremeOwnage**) — preferred.
- Or open a [new issue](https://github.com/XtremeOwnage/rPDU2MQTT/issues/new/choose).

## 🤝 Contributing

This is a small project without heavy process. If you want to work on an issue or feature, comment on the issue so others know, then open a [pull request](https://github.com/XtremeOwnage/rPDU2MQTT/compare) — we'll polish it together.

## 🧭 Q&A

**Why not a native Home Assistant integration?**
It's written in .NET (what I work in daily), it doesn't *require* Home Assistant at all, and beyond HA it also feeds Prometheus and EmonCMS and works standalone. It also owns the naming and the topology, which is the point — see [why not just do this in Home Assistant](#why-not-just-do-this-in-home-assistant) above.

**Isn't this just a PDU bridge?**
It was. The PDUs are now one tier of the map — the per-outlet one. Everything else (solar, battery, transfer switch, panels, CT-clamped circuits, smart plugs) joins the same hierarchy through MQTT or Modbus.
