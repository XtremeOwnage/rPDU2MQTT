---
title: Kubernetes CRD
---

# Kubernetes CRD

Configuration stored in an `RpduConfig` custom resource instead of a ConfigMap. GUI **Save** patches the resource.

## Enable

Helm:

```yaml
kubernetesConfigSource:
  enabled: true
```

Without Helm: [`Examples/Kubernetes/crd/`](https://github.com/XtremeOwnage/rPDU2MQTT/tree/main/Examples/Kubernetes/crd) (`crd.yaml`, `rbac.yaml`, `rpduconfig-sample.yaml`, `deployment.yaml`). Installing the CRD needs cluster-admin once.

The app reads the resource when `RPDU2MQTT_CONFIG_SOURCE=k8s` and `RPDU2MQTT_CR_NAME` are set. See [Environment variables](../system/environment-variables.md#config-source).

## Resource

```yaml
apiVersion: rpdu2mqtt.xtremeownage.com/v1alpha1
kind: RpduConfig
metadata:
  name: rpdu2mqtt
  namespace: rpdu2mqtt
spec:
  MQTT:
    Connection: { Host: mqtt.example.com, Port: 1883 }
  Pdus:
    default:
      Connection: { Host: rack-pdu-1.example.com, Port: 80 }
  HomeAssistant:
    DiscoveryEnabled: true
```

- `spec` has the same shape as `config.yaml`. The CRD schema is generated from the config model.
- `status` reports `connected`, `deviceCount`, `lastPoll`, `message`, and `update` when the operator runs. `kubectl get rpduconfig` shows them.

## Secrets

- Never stored in `spec`. The GUI writes credentials to a companion Secret named by `RPDU2MQTT_SECRET_NAME` (default: the CR name).
- The chart creates the Secret once, mounts it as environment variables, and grants `get`, `patch`, `update` on it.
- Without Helm, create the Secret, mount it and grant the same RBAC yourself.

## Changes

- Changes to the resource apply live: MQTT broker and credentials, PDU pollers.
- Listen ports and GUI authentication (including OIDC) need a restart (**Diagnostics › Restart**).
- After a GUI save, the GUI reminds you to update your GitOps source. **Export › RpduConfig manifest** renders the resource with secrets redacted.

## Upgrades and GitOps

| Tool | Keeps GUI edits with |
| --- | --- |
| `helm upgrade` | `kubernetesConfigSource.preserveExisting: true` (default). `values.config` seeds the resource on install only |
| Argo CD | `ignoreDifferences` plus `RespectIgnoreDifferences=true`. See [Argo CD](argo-cd.md) |
| Either | `kubernetesConfigSource.manageResource: false`. Create the resource once yourself; the chart does not render it |

Set `preserveExisting: false` to apply `values.config` on every upgrade.

The chart renders the CRD with the release (`crds.enabled`, default on), so the schema matches the app version.

## RBAC

Namespaced Role: `get`, `list`, `watch`, `patch` on `rpduconfigs`; `patch` on `rpduconfigs/status`. With the operator: `get`, `list`, `patch` on `apps/deployments`, `get`, `list` on `pods`. Diagnostics pod logs and events: `pods`, `pods/log`, `events`.

## Operator

Separate role (`--role operator` or `RPDU2MQTT_ROLE=operator`); not part of `all`.

- Checks the registry for newer images under `Operator.Policy` (`Patch`, `Minor`, `Major`). Pre-releases and moving tags are never targets.
- Writes the result to `.status.update` and the Diagnostics page.
- With `Operator.AutoUpdate: true`, rolls the Deployment to the newest eligible tag.

```yaml
operator:
  enabled: true
kubernetesConfigSource:
  enabled: true
config:
  Operator:
    Enabled: true
    Policy: Minor
    AutoUpdate: false
```

Settings: [Operator](../system/status.md#operator).
