# Deploying `rpdu2mqtt` with the Helm chart

The chart lives in [`charts/rpdu2mqtt`](../../../charts/rpdu2mqtt). See
[`values-example.yaml`](./values-example.yaml) here for a starting point, and the full
[Deployment guide](../../../docs/Deployment.md#kubernetes--helm-chart).

## Install

```bash
# from a clone of this repo
helm install rpdu2mqtt ./charts/rpdu2mqtt \
  -n rpdu2mqtt --create-namespace \
  -f Examples/Kubernetes/helm/values-example.yaml
```

## Upgrade

```bash
helm upgrade rpdu2mqtt ./charts/rpdu2mqtt -n rpdu2mqtt \
  -f Examples/Kubernetes/helm/values-example.yaml
```

## Notes

- The CRD (`RpduConfig`) is shipped in the chart's `crds/` directory and installed automatically on first install. Helm does not upgrade CRDs — apply changes manually if the CRD schema changes.
- For GitOps (Argo CD), see [`../argo`](../argo/).
- To let the GUI's **Save** persist (and survive upgrades), enable `kubernetesConfigSource.enabled` — the config is then stored in a writable `RpduConfig` CR. See [KubernetesCRD.md](../../../docs/KubernetesCRD.md).
