---
title: Argo CD
---

# Argo CD

Example Application: [`rpdu2mqtt-application.yaml`](https://github.com/XtremeOwnage/rPDU2MQTT/blob/main/Examples/Kubernetes/argo/rpdu2mqtt-application.yaml). Set the MQTT and PDU hosts and the secret name, then:

```bash
kubectl apply -f rpdu2mqtt-application.yaml
```

It uses `charts/rpdu2mqtt` from the repository with inline `helm.valuesObject`.

## Keeping GUI edits

With `kubernetesConfigSource.enabled`, add to the Application:

```yaml
spec:
  ignoreDifferences:
    - group: rpdu2mqtt.xtremeownage.com
      kind: RpduConfig
      jsonPointers:
        - /spec
    - group: ""
      kind: Secret
      name: rpdu2mqtt          # RPDU2MQTT_SECRET_NAME
      jsonPointers:
        - /data
  syncPolicy:
    syncOptions:
      - RespectIgnoreDifferences=true
```

- `RespectIgnoreDifferences=true` is required. Without it, sync still overwrites `/spec`.
- The first sync creates the resource from `values.config`.
- `preserveExisting` has no effect under Argo CD (`helm template` has no `lookup`).
- Alternative: `kubernetesConfigSource.manageResource: false` and create the resource yourself.

## Chart here, values in your repo

```yaml
spec:
  sources:
    - repoURL: https://github.com/XtremeOwnage/rPDU2MQTT.git
      targetRevision: main
      path: charts/rpdu2mqtt
      helm:
        releaseName: rpdu2mqtt
        valueFiles:
          - $values/rpdu2mqtt/values.yaml
    - repoURL: https://git.example.com/you/homelab.git
      targetRevision: main
      ref: values
  destination:
    server: https://kubernetes.default.svc
    namespace: rpdu2mqtt
```

The chart includes NetworkPolicy and Gateway API `HTTPRoute` templates (`networkPolicy.enabled`, `httpRoute.enabled`).
