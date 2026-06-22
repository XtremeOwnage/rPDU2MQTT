# Deploying `rpdu2mqtt` with Argo CD

Deploy the Helm chart from this repo as an Argo CD `Application`.

## Quick start

Edit [`rpdu2mqtt-application.yaml`](./rpdu2mqtt-application.yaml) (MQTT/PDU hosts, secret name), then:

```bash
kubectl apply -f rpdu2mqtt-application.yaml
```

It points `source` at `charts/rpdu2mqtt` in this repo and supplies values inline via `helm.valuesObject`.

## Keeping GUI edits (important)

If you use the **RpduConfig config source** (`kubernetesConfigSource.enabled: true`) so the GUI's **Save**
works, Argo would otherwise revert those edits on every sync — Argo renders with `helm template`, which
can't read the live CR (or the live Secret the GUI writes credentials into). The example includes an
`ignoreDifferences` for the `RpduConfig` `/spec` **and** the companion Secret's `/data` to prevent that:

```yaml
ignoreDifferences:
  - group: rpdu2mqtt.xtremeownage.com
    kind: RpduConfig
    jsonPointers:
      - /spec
  - group: ""
    kind: Secret
    name: rpdu2mqtt          # the release Secret (RPDU2MQTT_SECRET_NAME)
    jsonPointers:
      - /data
```

See [KubernetesCRD.md](../../../docs/KubernetesCRD.md) for the full discussion.

## Pattern: chart here, values in your repo (multi-source)

A common GitOps layout keeps the chart in this repo but your environment's values (and any
cluster-specific extras the chart doesn't ship) in your own repo:

```yaml
spec:
  sources:
    # 1) the chart from this repo, with values referenced from your repo ($values)
    - repoURL: https://github.com/XtremeOwnage/rPDU2MQTT.git
      targetRevision: main
      path: charts/rpdu2mqtt
      helm:
        releaseName: rpdu2mqtt
        valueFiles:
          - $values/rpdu2mqtt/values.yaml
    # 2) your repo, exposed as $values
    - repoURL: https://git.example.com/you/homelab.git
      targetRevision: main
      ref: values
    # 3) (optional) cluster-specific extras the chart doesn't ship (e.g. HTTPRoute, IP pools)
    - repoURL: https://git.example.com/you/homelab.git
      targetRevision: main
      path: rpdu2mqtt/extras
  destination:
    server: https://kubernetes.default.svc
    namespace: rpdu2mqtt
```

(The chart already ships NetworkPolicy + Gateway API `HTTPRoute` templates — enable them in values
rather than adding extras, unless you need something bespoke.)
