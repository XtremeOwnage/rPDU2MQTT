# rPDU2MQTT Helm chart

Deploys [rPDU2MQTT](https://github.com/XtremeOwnage/rPDU2MQTT) — a bridge from a Vertiv/Geist rPDU to
MQTT, with Home Assistant discovery and optional Prometheus/EmonCMS exporters.

## Install

```bash
# From a checkout of the repo:
helm install rpdu2mqtt ./charts/rpdu2mqtt -n rpdu2mqtt --create-namespace \
  -f my-values.yaml
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
  mqtt: { username: rpdu2mqtt, password: "s3cret" }
  pdu:  { username: hass, password: "homeassistant" }
```

## How it works

- The entire `config:` block is rendered verbatim into a **ConfigMap** mounted at `/config/config.yaml`
  — it is the single source of truth for app behaviour. See
  [docs/Configuration.md](../../docs/Configuration.md) for every option.
- `credentials.*` (or `existingSecret`) become `RPDU2MQTT_*` env vars via a **Secret**, so passwords
  stay out of the ConfigMap.
- The pod rolls automatically when the rendered config changes (config checksum annotation).

## Key values

| Key | Default | Description |
| --- | --- | --- |
| `image.repository` / `image.tag` | `ghcr.io/xtremeownage/rpdu2mqtt` / chart `appVersion` | Container image. |
| `config` | see `values.yaml` | The full app config (rendered to `config.yaml`). |
| `credentials.{mqtt,pdu}.{username,password}` | `""` | Injected as `RPDU2MQTT_*`; chart creates a Secret. |
| `credentials.emoncmsApiKey` | `""` | EmonCMS write key (`RPDU2MQTT_EMONCMS_APIKEY`). |
| `existingSecret` | `""` | Use a Secret you manage instead of creating one. |
| `service.gui.enabled` | `true` | Create a Service for the GUI (when `config.Gui.Enabled`). |
| `service.metrics.enabled` | `true` | Create a Service for `/metrics` (when `config.Prometheus.Enabled`). |
| `serviceMonitor.enabled` | `false` | Create a Prometheus Operator `ServiceMonitor` for `/metrics`. |
| `kubernetesConfigSource.enabled` | `false` | Store config in an `RpduConfig` CR (writable by the GUI) instead of a ConfigMap; creates the CR + RBAC and wires the app to read it. Requires the CRD (in this chart's `crds/`). |
| `kubernetesConfigSource.preserveExisting` | `true` | Create-once: keep the live CR `spec` on upgrade so GUI edits aren't reverted (`values.config` only seeds it on install). Set `false` for declarative config. Under Argo CD, use an `ignoreDifferences` on the CR `spec` instead — see [KubernetesCRD.md](../../docs/KubernetesCRD.md#keeping-gui-edits-across-chart-upgrades--argo-syncs). |
| `ingress.enabled` | `false` | Expose the GUI via an Ingress. |
| `httpRoute.enabled` | `false` | Expose the GUI via a Gateway API `HTTPRoute` (set `httpRoute.parentRefs`/`hostnames`). Requires the Gateway API CRDs. |
| `healthProbes.enabled` | `true` | Liveness/readiness probes against the app's health endpoints. |
| `networkPolicy.enabled` | `false` | Restrict pod access: GUI/metrics ingress only from `networkPolicy.guiIngressFrom` / `metricsIngressFrom`; health probes always allowed. Optionally restrict egress with `restrictEgress` + `egress`. Requires a NetworkPolicy-enforcing CNI. |
| `serviceAccount.create` | `true` | Create a ServiceAccount. |
| `resources`, `nodeSelector`, `tolerations`, `affinity` | `{}` / `[]` | Standard pod scheduling/limits. |

## Notes

- **GUI in Kubernetes:** by default the config is mounted read-only from a ConfigMap, so the GUI's
  *Save* is disabled — change config by editing values and running `helm upgrade`. To make the GUI
  *Save* work, set `kubernetesConfigSource.enabled=true` to store config in a writable `RpduConfig`
  custom resource (see [docs/KubernetesCRD.md](../../docs/KubernetesCRD.md)).
- **Metrics scraping:** enable `config.Prometheus.Enabled` and `serviceMonitor.enabled` (requires the
  Prometheus Operator) to have Prometheus auto-discover the `/metrics` endpoint.
- **Single replica:** the bridge owns a PDU session and has no leader election; keep `replicaCount: 1`
  (the Deployment uses the `Recreate` strategy).
