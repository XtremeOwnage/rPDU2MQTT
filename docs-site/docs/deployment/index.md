---
title: Deployment
---

# Deployment

| Method | Page |
| --- | --- |
| `docker run` | [Docker](docker.md) |
| Docker Compose | [Docker Compose](docker-compose.md) |
| Kubernetes, Helm | [Helm chart](helm.md) |
| Kubernetes, GitOps | [Argo CD](argo-cd.md) |
| Kubernetes, writable config | [Kubernetes CRD](kubernetes-crd.md) |
| Kubernetes, seamless restarts and automatic updates | [Updates and restarts](updates.md) |
| Kubernetes, no Helm | [`manifests.yaml`](https://github.com/XtremeOwnage/rPDU2MQTT/blob/main/Examples/Kubernetes/manifests.yaml), [CRD manifests](https://github.com/XtremeOwnage/rPDU2MQTT/blob/main/Examples/Kubernetes/crd/README.md) |

Requirements: network access to the MQTT broker and the PDU, and a `config.yaml` ([Configuration](../getting-started/configuration.md)).

## Container image

`ghcr.io/xtremeownage/rpdu2mqtt`

| Tag | Points at |
| --- | --- |
| `:latest`, `:stable`, `:release` | Newest release |
| `:X` (e.g. `:2`) | Newest release in major version X |
| `:X.Y` (e.g. `:2.0`) | Newest patch of X.Y |
| `:X.Y.Z` | One exact release |
| `:edge`, `:main` | Latest `main` build |
| `:dev`, `:unstable` | Latest build of any other branch |

Releases follow [SemVer](https://semver.org/). Non-release builds report a version like `0.0.0-main.42+abc1234`.

## Ports

| Port | Listener | Needed when |
| --- | --- | --- |
| 8080 | GUI | `Gui.Enabled` |
| 8081 | Health (`/healthz`, `/readyz`) | `Health.Enabled` |
| 8082 | REST API | `Api.Enabled` |
| 9184 | Prometheus `/metrics` | `Prometheus.Exporter` |

## Persistent data

| Data | Location | Needed for |
| --- | --- | --- |
| `config.yaml` | `/config` | GUI Save (mount writable) |
| Local history | `History.LocalPath`, else `RPDU2MQTT_HISTORY_DIRECTORY` | [History](../system/history.md) |
| Floor plan images | `PlanStorage.Directory`, else `RPDU2MQTT_PLANS_DIRECTORY` | [Floor plans](../energy-flow/floor-plans.md#plan-storage) |
| Daily energy totals | Valkey (`Cache.Enabled`), else `energy-totals.json` beside the binary | [Totals](../energy-flow/totals.md#where-daily-totals-are-stored) |

## Updating

- Compose: `docker compose pull && docker compose up -d`
- Helm: `helm upgrade rpdu2mqtt ./charts/rpdu2mqtt -n rpdu2mqtt -f my-values.yaml`
- With Valkey on, the Helm chart rolls the Deployment with no gap (`gracefulRollout.enabled`, default). See [Updates and restarts](updates.md). Elsewhere, set `RPDU2MQTT_LEADER_LEASE=true` on every instance with `Cache` enabled; only the lease holder polls and publishes.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `MQTT broker refused the connection` | Check `MQTT.Credentials` or `RPDU2MQTT_MQTT_*` |
| No PDU data | Check host and port. For HTTPS set `Connection.Scheme: https`, and `ValidateCertificate: false` for self-signed |
| Nothing in Home Assistant | `HomeAssistant.DiscoveryEnabled: true`, and **Discovery Topic** matches Home Assistant's prefix |
| No outlet switches | **Enable Write Actions** on, and PDU credentials set |
| GUI Save disabled | Config is read-only (ConfigMap or `:ro`). Mount writable, or use the [CRD](kubernetes-crd.md) |
