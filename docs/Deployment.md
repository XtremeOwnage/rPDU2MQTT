# Deployment Guide

How to run rPDU2MQTT. Pick the method that matches your environment:

| Method | Best for | Jump to |
| --- | --- | --- |
| **Docker Compose** | Most people / a single host | [Docker Compose](#docker-compose) |
| **Kubernetes (Helm)** | Clusters (recommended k8s path) | [Kubernetes — Helm](#kubernetes--helm-chart) |
| **Kubernetes (manifests)** | Clusters without Helm | [Kubernetes — manifests](#kubernetes--raw-manifests) |
| **unRAID** | unRAID servers | [unRAID](#unraid) |

All methods need the same two things below.

## Prerequisites

- **Network reachability** from wherever rPDU2MQTT runs to:
  - your **MQTT broker**, and
  - your **PDU** (the Geist/Vertiv web/JSON API; for a OneView cluster, the master node).
- A **`config.yaml`** — see the [Configuration Guide](Configuration.md). At minimum you need `MQTT.Connection`
  and `PDU.Connection`. Clustered PDUs: see [Aggregation (OneView)](Aggregation.md).
- **Credentials.** MQTT and PDU credentials can live in `config.yaml`, but prefer environment variables
  / secrets so they stay out of the file (see [Credentials & secrets](#credentials--secrets)).

### Container image & tags

Images are published to GitHub Container Registry: **`ghcr.io/xtremeownage/rpdu2mqtt`**.

| Tag | Meaning |
| --- | --- |
| `:stable` | Latest build of `main` — recommended for most users. |
| `:X.Y.Z` / `:X.Y` | A specific release (pin this for reproducible deploys). |
| `:dev` | Latest build of a non-`main` branch — bleeding edge. |

> The image is built on the ASP.NET Core runtime (the optional embedded GUI needs it).

## Docker Compose

1. Create a working directory with your `config.yaml` in it.
2. Add a `docker-compose.yaml` (a starting point is in
   [`Examples/Docker-Compose`](../Examples/Docker-Compose/README.md)):

```yaml
services:
  rpdu2mqtt:
    image: ghcr.io/xtremeownage/rpdu2mqtt:stable
    container_name: rpdu2mqtt
    restart: unless-stopped
    volumes:
      # Mount your config. Keep it writable (no :ro) if you want to edit it from the GUI.
      - ./config.yaml:/config/config.yaml
    environment:
      # Prefer secrets over putting credentials in config.yaml:
      RPDU2MQTT_MQTT_USERNAME: rpdu2mqtt
      RPDU2MQTT_MQTT_PASSWORD: "change-me"
      RPDU2MQTT_PDU_USERNAME: hass
      RPDU2MQTT_PDU_PASSWORD: "change-me"
    ports:
      # Only needed if you enable the optional features:
      - "8080:8080"   # Gui.Enabled  -> the configuration web GUI
      - "9184:9184"   # Prometheus.Exporter -> the /metrics endpoint
```

3. `docker compose up -d`, then check it connected: `docker compose logs -f`.

Notes:
- The container reads `config.yaml` from `/config` (or the working directory).
- Each `RPDU2MQTT_*` variable also has a `*_FILE` form pointing at a file (e.g. a Docker secret) —
  see [Credentials & secrets](#credentials--secrets).

## Kubernetes — Helm chart

The chart at [`charts/rpdu2mqtt`](../charts/rpdu2mqtt/README.md) is the easiest k8s path. It renders
your config into a ConfigMap, injects credentials via a Secret, and can optionally create a GUI
Service/Ingress and a Prometheus Operator `ServiceMonitor`.

```bash
helm install rpdu2mqtt ./charts/rpdu2mqtt -n rpdu2mqtt --create-namespace -f my-values.yaml
```

A minimal `my-values.yaml`:

```yaml
config:
  MQTT:
    Connection: { Host: mqtt.lan, Port: 1883 }
    ParentTopic: Rack_PDU
  PDU:
    Connection: { Host: pdu.lan, Port: 80 }
    PollInterval: 5
  HomeAssistant:
    DiscoveryEnabled: true
    DiscoveryTopic: homeassistant

credentials:
  mqtt: { username: rpdu2mqtt, password: "change-me" }
  pdu:  { username: hass, password: "change-me" }
```

Common toggles (full list in the [chart README](../charts/rpdu2mqtt/README.md)):

- `serviceMonitor.enabled=true` — scrape `/metrics` via the Prometheus Operator (also set
  `config.Prometheus.Exporter: true`).
- `ingress.enabled=true` — expose the GUI (also set `config.Gui.Enabled: true` + a password).
- `kubernetesConfigSource.enabled=true` — store config in a writable **`RpduConfig` custom resource**
  instead of a ConfigMap, so the **GUI's Save works in-cluster**. See
  [KubernetesCRD.md](KubernetesCRD.md).

> **GUI Save in Kubernetes:** a ConfigMap mount is read-only, so the GUI is view/test-only by default.
> Either edit values and `helm upgrade`, or use the CRD config source above.

## Kubernetes — raw manifests

Without Helm:

- Plain Deployment: [`Examples/Kubernetes/manifests.yaml`](../Examples/Kubernetes/manifests.yaml).
- CRD config source (writable config + status): [`Examples/Kubernetes/crd`](../Examples/Kubernetes/crd/README.md).

## unRAID

Deploy via the unRAID Docker GUI — step-by-step guide:
[`Examples/unRAID`](../Examples/unRAID/README.md).

## Credentials & secrets

Keep secrets out of `config.yaml` by supplying them via environment variables (these override the file):

| Variable | Overrides |
| --- | --- |
| `RPDU2MQTT_MQTT_USERNAME` / `RPDU2MQTT_MQTT_PASSWORD` | MQTT broker credentials |
| `RPDU2MQTT_PDU_USERNAME` / `RPDU2MQTT_PDU_PASSWORD` | PDU credentials (needed for outlet control) |
| `RPDU2MQTT_EMONCMS_APIKEY` | EmonCMS write API key |
| `RPDU2MQTT_GUI_PASSWORD` | Configuration GUI password |

Each variable also supports a **`<NAME>_FILE`** form: point it at a file path (e.g. a Docker/Kubernetes
secret) and the value is read from that file. `_FILE` takes precedence. The Helm chart wires these up
for you from `credentials.*` (or an `existingSecret`).

## After deploying

1. **Check the logs** — you should see it connect to the broker and start publishing:
   `Successfully connected to broker!` then per-cycle publish logs.
2. **Home Assistant** — with `HomeAssistant.DiscoveryEnabled: true`, devices/entities for the PDU,
   outlets, and any OneView groups appear automatically under MQTT discovery.
3. **Configuration GUI** (optional) — set `Gui.Enabled: true` + `Gui.Password`, publish the port, and
   browse to `http://<host>:8080` to view/edit config and test the MQTT/PDU connections.
   See [Configuration.md](Configuration.md#configuration-gui-optional).
4. **Prometheus** (optional) — `Prometheus.Exporter: true` exposes `/metrics`; or push to a Pushgateway
   with `Prometheus.Pushgateway`.

## Updating

- **Compose:** `docker compose pull && docker compose up -d`.
- **Helm:** `helm upgrade rpdu2mqtt ./charts/rpdu2mqtt -n rpdu2mqtt -f my-values.yaml`.
- Pin `:X.Y.Z` for predictable upgrades; `:stable` tracks `main`.

## Troubleshooting

| Symptom | Likely cause / fix |
| --- | --- |
| `MQTT broker refused the connection` | Bad MQTT credentials/permissions. Fix `MQTT.Credentials` or the `RPDU2MQTT_MQTT_*` vars. |
| No data / can't reach PDU | PDU host/port wrong or unreachable from the container; for `https` PDUs set `PDU.Connection.Scheme: https` (and `ValidateCertificate: false` for self-signed). |
| Nothing appears in Home Assistant | `HomeAssistant.DiscoveryEnabled` is false, or HA's MQTT discovery prefix differs from `DiscoveryTopic`. |
| Outlet switches missing | Outlet control is opt-in: set `PDU.ActionsEnabled: true` (a.k.a. "Enable Write Actions") **and** provide PDU credentials. |
| GUI "Save" disabled in Kubernetes | The ConfigMap mount is read-only — use `helm upgrade`, or the [CRD config source](KubernetesCRD.md). |
