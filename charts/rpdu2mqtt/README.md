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
    ParentTopic: rPDU2MQTT
  Pdus:
    default:
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
  stay out of the ConfigMap. With `kubernetesConfigSource.enabled`, the GUI also writes credentials
  (incl. the OIDC client secret) **into this Secret** — kept out of the CR `spec` — and the chart grants
  the pod `get,patch,update` on just that Secret. Create-once preserves GUI-written values on upgrade.
- The pod rolls automatically when the rendered config changes (config checksum annotation).

## Key values

| Key | Default | Description |
| --- | --- | --- |
| `image.repository` / `image.tag` | `ghcr.io/xtremeownage/rpdu2mqtt` / chart `appVersion` | Container image. |
| `config` | see `values.yaml` | The full app config (rendered to `config.yaml`). |
| `credentials.{mqtt,pdu}.{username,password}` | `""` | Injected as `RPDU2MQTT_*`; chart creates a Secret. |
| `credentials.emoncmsApiKey` | `""` | EmonCMS write key (`RPDU2MQTT_EMONCMS_APIKEY`). |
| `credentials.apiKey` | `""` | REST API key enabling its write/control endpoints (`RPDU2MQTT_API_KEY`). Required to use control via the API when `kubernetesConfigSource.enabled`, since secrets are stripped from the CR. |
| `existingSecret` | `""` | Use a Secret you manage instead of creating one. |
| `split.enabled` | `false` | Deploy the app's roles as separate Deployments (`-worker`, `-api`, `-ui`) so they scale independently. Off = one Deployment runs every role. The gui Service targets the `ui` pods and the metrics Service the `worker` pods. |
| `split.{worker,api,ui}.replicaCount` | `1` | Replicas per role Deployment (only with `split.enabled`). Keep `worker` at `1` — it owns the single PDU session. |
| `split.{worker,api,ui}.resources` | `{}` | Per-role resource requests/limits (falls back to `resources`). |
| `service.gui.enabled` | `true` | Create a Service for the GUI (when `config.Gui.Enabled`). |
| `service.api.enabled` | `true` | Create a Service for the REST API + its OpenAPI/Scalar docs (when `config.Api.Enabled`). |
| `service.metrics.enabled` | `true` | Create a Service for `/metrics` (when `config.Prometheus.Exporter`). |
| `serviceMonitor.enabled` | `false` | Create a Prometheus Operator `ServiceMonitor` for `/metrics`. |
| `serviceMonitor.labels` | `{}` | Extra labels so your Prometheus adopts the ServiceMonitor (e.g. `release: <kube-prometheus-stack release>`); without a match it is silently ignored. |
| `kubernetesConfigSource.enabled` | `false` | Store config in an `RpduConfig` CR (writable by the GUI) instead of a ConfigMap; creates the CR + RBAC and wires the app to read it. Requires the CRD (in this chart's `crds/`). |
| `kubernetesConfigSource.preserveExisting` | `true` | Create-once: keep the live CR `spec` on upgrade so GUI edits aren't reverted (`values.config` only seeds it on install). Set `false` for declarative config. Relies on Helm `lookup`, so it is a **no-op under Argo CD** (`helm template`) — see *Argo CD and GUI edits* under [Notes](#notes). |
| `kubernetesConfigSource.manageResource` | `true` | Whether the chart renders the `RpduConfig` CR and the GUI-written credentials `Secret`. Set `false` to manage them out of band so GitOps (Argo/Flux) never syncs over GUI edits; RBAC + the config source stay on, but you must create the CR (and Secret, if used) once yourself. |
| `ingress.enabled` | `false` | Expose the GUI and/or REST API via an Ingress. Each `ingress.hosts[].paths[]` entry takes an optional `service:` of `gui` (default) or `api`. |
| `httpRoute.enabled` | `false` | Expose the GUI and/or REST API via a Gateway API `HTTPRoute` (set `httpRoute.parentRefs`/`hostnames`). Requires the Gateway API CRDs. |
| `httpRoute.paths` | `[]` | Path-based rules mirroring `ingress`, each with an optional `service:` (`gui`/`api`). Empty routes everything to the GUI. `httpRoute.rules` overrides this with raw rules. |
| `healthProbes.enabled` | `true` | Liveness/readiness probes against the app's health endpoints. |
| `networkPolicy.enabled` | `false` | Restrict pod access: GUI/API/metrics ingress only from `networkPolicy.guiIngressFrom` / `apiIngressFrom` / `metricsIngressFrom`; health probes always allowed. Optionally restrict egress with `restrictEgress` + `egress`. Requires a NetworkPolicy-enforcing CNI. |
| `serviceAccount.create` | `true` | Create a ServiceAccount. |
| `autoRestart.enabled` | `false` | Add a CronJob that rolling-restarts this release's Deployment(s) on a schedule. Also re-pulls the image when the tag is mutable (`stable`/`latest`), so it doubles as an update mechanism. |
| `autoRestart.schedule` | `"0 4 * * *"` | When to restart (standard cron). |
| `autoRestart.timeZone` | `""` | IANA zone for the schedule (Kubernetes 1.27+); empty uses the cluster's. |
| `autoRestart.image.repository` / `.tag` | `bitnami/kubectl` / `1.34` | Image the restart job runs. |
| `resources`, `nodeSelector`, `tolerations`, `affinity` | `{}` / `[]` | Standard pod scheduling/limits. |

## Notes

- **Where the device work runs (`split.enabled`):** roles decide which *background services* start in each
  pod — they don't decide where grains live. The grains that hold a device open (the PDU session, a Modbus
  device) now use a placement strategy that **prefers a silo running the `worker` role**, so in a split
  deployment that work lands in the worker pod rather than wherever Orleans happened to put it. It's a
  preference, not a requirement: with no worker silo available it falls back to any silo and logs a warning,
  because a grain that can't be placed is worse than one placed in the wrong pod. In the default
  single-Deployment fleet every silo runs every role, so nothing changes.

- **Orleans membership CRDs:** the chart ships `crds/orleans-membership.yaml`
  (`clusterversions.orleans.dot.net`, `silos.orleans.dot.net`). The silos store cluster membership in those
  resources instead of an external database, and without them **every pod crash-loops** on *"Failure reading
  all silo entries"*. Helm applies `crds/` on **install only, never on upgrade** — so a release that predates
  them needs a one-off `kubectl apply -f charts/rpdu2mqtt/crds/orleans-membership.yaml`. Argo CD renders with
  `--include-crds` and applies them on every sync, so it needs nothing extra.

- **Scheduled restarts:** `autoRestart.enabled=true` adds a CronJob that runs
  `kubectl rollout restart` against the Deployments *this release* renders — matched by label, so it can
  never wander onto anything else in the namespace. It gets its own ServiceAccount with nothing but
  `get`/`list`/`patch` on Deployments (a rollout restart is a patch of the pod template's annotations).
  Missed runs are skipped rather than fired on recovery. With a mutable tag this is also how you get
  updated images without a `helm upgrade`.

- **GUI in Kubernetes:** by default the config is mounted read-only from a ConfigMap, so the GUI's
  *Save* is disabled — change config by editing values and running `helm upgrade`. To make the GUI
  *Save* work, set `kubernetesConfigSource.enabled=true` to store config in a writable `RpduConfig`
  custom resource (see [docs/KubernetesCRD.md](../../docs/KubernetesCRD.md)).
- **Metrics scraping:** enable `config.Prometheus.Exporter` and `serviceMonitor.enabled` (requires the
  Prometheus Operator) to have Prometheus auto-discover the `/metrics` endpoint. A Prometheus only
  adopts ServiceMonitors matching its `serviceMonitorSelector` — for kube-prometheus-stack that's
  usually `release: <your-stack>`, so set `serviceMonitor.labels` to match or the ServiceMonitor is
  silently ignored.
- **Argo CD and GUI edits:** if you let the GUI write config (`kubernetesConfigSource.enabled`), Argo
  will sync `values.config` back over those edits — `preserveExisting` cannot help, because the Helm
  `lookup` it relies on is always empty under `helm template`. Add this to your **Application**:

  ```yaml
  spec:
    ignoreDifferences:
      - group: rpdu2mqtt.xtremeownage.com
        kind: RpduConfig
        jsonPointers:
          - /spec
      - group: ""
        kind: Secret
        name: <release-name>   # only if the GUI manages credentials
        jsonPointers:
          - /data
    syncPolicy:
      syncOptions:
        - RespectIgnoreDifferences=true
  ```

  **`ignoreDifferences` alone is not enough:** without `RespectIgnoreDifferences=true` it only hides the
  OutOfSync status while the sync still reverts your config — a green "Synced" app that clobbers you
  anyway. The first sync still seeds the CR from `values.config` (the option has no effect on resources
  that don't exist yet), so this behaves exactly like `preserveExisting` does under plain Helm.

  Prefer not to touch the Application? Set `kubernetesConfigSource.manageResource: false` and create the
  CR yourself once — the chart then renders neither the CR nor the Secret, so Argo never manages them.
  See [docs/KubernetesCRD.md](../../docs/KubernetesCRD.md).
- **Exposing the REST API:** enable `config.Api.Enabled` (the chart then creates a `<release>-api`
  Service on `config.Api.Port`), then route to it with `service: api` on an Ingress or HTTPRoute path:

  ```yaml
  config:
    Api:
      Enabled: true
  ingress:
    enabled: true
    hosts:
      - host: rpdu2mqtt.example.com
        paths:
          - path: /
            pathType: Prefix          # -> GUI
          - path: /api
            pathType: Prefix
            service: api              # -> REST API
          - path: /scalar             # the docs UI; add /openapi too if you want the raw document
            pathType: Prefix
            service: api
  ```

  The API's docs live at `/scalar/v1` and `/openapi/v1.json` — routing only `/api` leaves them
  unreachable, so give the API its own host or add those paths as above. Routing to `service: api`
  while the API is disabled fails the render rather than emitting a dangling backend. The API is
  unauthenticated for reads: put auth at your ingress, or restrict `networkPolicy.apiIngressFrom`.
- **Single replica:** the bridge owns a PDU session and has no leader election; keep `replicaCount: 1`
  (the Deployment uses the `Recreate` strategy).
