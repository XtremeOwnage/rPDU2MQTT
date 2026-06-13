# rPDU2MQTT with a Kubernetes CRD config source

Store the configuration in an `RpduConfig` custom resource instead of a ConfigMap. The app reads its
config from the CR, the GUI's **Save** writes back to it, and a `status` subresource reports health
(`kubectl get rpduconfig`). See [docs/KubernetesCRD.md](../../../docs/KubernetesCRD.md) for the design.

> The Helm chart ([`charts/rpdu2mqtt`](../../../charts/rpdu2mqtt)) can do all of this for you with
> `kubernetesConfigSource.enabled=true`. These raw manifests are the manual alternative.

## Install

```bash
kubectl create namespace rpdu2mqtt

# 1. Install the CRD (cluster-admin; one-time).
kubectl apply -f crd.yaml

# 2. ServiceAccount + RBAC to read/write the CR and patch its status.
kubectl apply -f rbac.yaml

# 3. Your configuration as an RpduConfig (edit first).
kubectl apply -f rpduconfig-sample.yaml

# 4. Credentials Secret + Deployment (edit the Secret first).
kubectl apply -f deployment.yaml
```

## Notes

- **Secrets** are never stored in the CR — set them in the Secret (`RPDU2MQTT_*` env vars).
- The app **restarts** when the CR's `spec` changes, to reload the new config.
- The CRD (`crd.yaml`) is generated from the app's config model (`rPDU2MQTT --emit-crd`); regenerate it
  rather than hand-editing.
- Check health: `kubectl -n rpdu2mqtt get rpduconfig`.
