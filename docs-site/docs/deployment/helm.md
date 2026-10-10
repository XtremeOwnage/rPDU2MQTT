---
title: Helm chart
---

# Helm chart

Chart: `charts/rpdu2mqtt` in the repository.

```bash
helm install rpdu2mqtt ./charts/rpdu2mqtt -n rpdu2mqtt --create-namespace -f my-values.yaml
```

Minimal `my-values.yaml`:

```yaml
config:
  MQTT:
    Connection: { Host: mqtt.lan, Port: 1883 }
  Pdus:
    default:
      Connection: { Host: pdu.lan, Port: 80 }
  HomeAssistant:
    DiscoveryEnabled: true
  Gui:
    Enabled: true

credentials:
  mqtt: { username: rpdu2mqtt, password: "change-me" }
  pdu:  { username: hass, password: "change-me" }
```

- `config:` is rendered into a ConfigMap at `/config/config.yaml`. All keys: [Configuration](../getting-started/configuration.md).
- `credentials.*` (or `existingSecret`) become `RPDU2MQTT_*` variables from a Secret.
- The pod restarts when the rendered config changes.
- A ConfigMap is read-only, so GUI Save is disabled. For GUI Save set `kubernetesConfigSource.enabled: true` ([Kubernetes CRD](kubernetes-crd.md)).
- Valkey is deployed by default (`valkey.enabled: true`, 1Gi volume).

## Key values

| Key | Default | Description |
| --- | --- | --- |
| `image.repository` / `image.tag` | `ghcr.io/xtremeownage/rpdu2mqtt` / chart `appVersion` | Container image. |
| `config` | see `values.yaml` | The full app config (rendered to `config.yaml`). |
| `credentials.{mqtt,pdu}.{username,password}` | `""` | Injected as `RPDU2MQTT_*`; chart creates a Secret. |
| `credentials.emoncmsApiKey` | `""` | EmonCMS write key (`RPDU2MQTT_EMONCMS_APIKEY`). |
| `credentials.apiKey` | `""` | REST API key (`RPDU2MQTT_API_KEY`). Required for API control with `kubernetesConfigSource.enabled`. |
| `credentials.plansSecretKey` | `""` | Secret access key for an S3-compatible floor plan image store (`RPDU2MQTT_PLANS_SECRET_KEY`). |
| `history.persistence.enabled` | `true` | PVC for local history, mounted at `history.mountPath` (`/data/history`). Kept on uninstall. |
| `history.persistence.existingClaim` / `.size` / `.storageClass` / `.accessMode` | `""` / `5Gi` / `""` / `ReadWriteOnce` | Existing claim, or size of the created one. About 1 GB per year for 200 series. With `split.enabled`, use `ReadWriteMany`. |
| `floorPlans.persistence.enabled` | `false` | PVC for floor plan images, mounted at `floorPlans.mountPath` (`/data/plans`) on the GUI pod. Kept on uninstall. |
| `floorPlans.persistence.existingClaim` / `.size` / `.storageClass` / `.accessMode` | `""` / `1Gi` / `""` / `ReadWriteOnce` | Use your own claim, or size the one the chart creates. |
| `gracefulRollout.enabled` | `true` | Start the new pod and wait for Ready before stopping the old one (`RollingUpdate`, `maxSurge: 1`, `maxUnavailable: 0`). Needs a cache (`valkey.enabled` or `config.Cache.Enabled`); otherwise `Recreate`. `ReadWriteOncePod` volumes turn it off. See [Notes](#notes). |
| `existingSecret` | `""` | Use a Secret you manage instead of creating one. |
| `split.enabled` | `false` | Run roles as separate Deployments (`-worker`, `-api`, `-ui`). The gui Service targets `ui`, the metrics Service `worker`. |
| `split.{worker,api,ui}.replicaCount` | `1` | Replicas per role (with `split.enabled`). Keep `worker` at `1`. |
| `split.{worker,api,ui}.resources` | `{}` | Per-role resource requests/limits (falls back to `resources`). |
| `service.gui.enabled` | `true` | Create a Service for the GUI (when `config.Gui.Enabled`). |
| `service.api.enabled` | `true` | Create a Service for the REST API + its OpenAPI/Scalar docs (when `config.Api.Enabled`). |
| `service.metrics.enabled` | `true` | Create a Service for `/metrics` (when `config.Prometheus.Exporter`). |
| `serviceMonitor.enabled` | `false` | Create a Prometheus Operator `ServiceMonitor` for `/metrics`. |
| `serviceMonitor.labels` | `{}` | Extra labels so your Prometheus adopts the ServiceMonitor (e.g. `release: <kube-prometheus-stack release>`); without a match it is silently ignored. |
| `crds.enabled` | `true` | Render the `RpduConfig` CRD with the release so its schema matches the app. Kept on uninstall. Turn off only if something else owns the CRD. |
| `kubernetesConfigSource.enabled` | `false` | Store config in an `RpduConfig` CR writable by the GUI; creates the CR and RBAC. |
| `kubernetesConfigSource.preserveExisting` | `true` | Keep the live CR `spec` on upgrade; `values.config` seeds it on install only. `false` applies `values.config` every upgrade. No effect under Argo CD. |
| `kubernetesConfigSource.manageResource` | `true` | `false`: the chart renders neither the CR nor the credentials Secret; create them once yourself. RBAC and the config source stay on. |
| `ingress.enabled` | `false` | Expose the GUI and/or REST API via an Ingress. Each `ingress.hosts[].paths[]` entry takes an optional `service:` of `gui` (default) or `api`. |
| `httpRoute.enabled` | `false` | Expose the GUI and/or REST API via a Gateway API `HTTPRoute` (set `httpRoute.parentRefs`/`hostnames`). Requires the Gateway API CRDs. |
| `httpRoute.paths` | `[]` | Path-based rules mirroring `ingress`, each with an optional `service:` (`gui`/`api`). Empty routes everything to the GUI. `httpRoute.rules` overrides this with raw rules. |
| `healthProbes.enabled` | `true` | Liveness/readiness probes against the app's health endpoints. |
| `networkPolicy.enabled` | `false` | Restrict ingress to GUI, API and metrics from `networkPolicy.guiIngressFrom` / `apiIngressFrom` / `metricsIngressFrom`. Health probes always allowed. Egress: `restrictEgress` + `egress`. Needs a NetworkPolicy CNI. |
| `serviceAccount.create` | `true` | Create a ServiceAccount. |
| `autoRestart.enabled` | `false` | CronJob that rolling-restarts this release's Deployments on a schedule. Re-pulls mutable tags. |
| `autoRestart.schedule` | `"0 4 * * *"` | When to restart (standard cron). |
| `autoRestart.timeZone` | `""` | IANA zone for the schedule (Kubernetes 1.27+); empty uses the cluster's. |
| `autoRestart.image.repository` / `.tag` | `bitnami/kubectl` / `1.34` | Image the restart job runs. |
| `resources`, `nodeSelector`, `tolerations`, `affinity` | `{}` / `[]` | Standard pod scheduling/limits. |

## Notes

- **Graceful rollout.** With a cache, the new pod starts as a standby and takes the leader lease when the old pod stops. Only the lease holder polls and publishes. The old pod keeps serving for `RPDU2MQTT_SHUTDOWN_DRAIN_SECONDS` (10 s) with `/readyz` failing. A killed pod holds the lease for at most `RPDU2MQTT_LEADER_LEASE_SECONDS` (15 s). GUI **Restart** rolls the Deployment. See [Updates and restarts](updates.md).
- **Replicas.** Without the leader lease keep `replicaCount: 1` (`Recreate` strategy). With it, extra replicas are standbys.
- **Split roles.** With `split.enabled`, the `worker` Deployment runs the PDU session, Modbus and exporters; `api` and `ui` only read. Keep `worker` at one replica. History needs a `ReadWriteMany` class.
- **Scheduled restarts.** `autoRestart.enabled` adds a CronJob running `kubectl rollout restart` on this release's Deployments, with its own ServiceAccount (`get`, `list`, `patch` on Deployments). Missed runs are skipped.
- **Metrics.** Set `config.Prometheus.Exporter: true` and `serviceMonitor.enabled: true`. Set `serviceMonitor.labels` to match your Prometheus `serviceMonitorSelector` (e.g. `release: kube-prometheus-stack`).
- **Argo CD.** See [Argo CD](argo-cd.md) for `ignoreDifferences` with the CRD source.

## Exposing the REST API

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
          pathType: Prefix          # GUI
        - path: /api
          pathType: Prefix
          service: api
        - path: /scalar
          pathType: Prefix
          service: api
```

- API docs: `/scalar/v1` and `/openapi/v1.json`.
- `service: api` with the API disabled fails the render.
- Reads are unauthenticated. Put auth at the ingress, or restrict `networkPolicy.apiIngressFrom`.
