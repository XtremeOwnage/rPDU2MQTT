# Deployment

## via Docker Compose

For docker-compose, see [Docker-Compose](./../Examples/Docker-Compose/README.md)

## Kubernetes

The easiest option is the **Helm chart** at [`charts/rpdu2mqtt`](./../charts/rpdu2mqtt/README.md):

```bash
helm install rpdu2mqtt ./charts/rpdu2mqtt -n rpdu2mqtt --create-namespace -f my-values.yaml
```

It renders your config into a ConfigMap, injects credentials via a Secret, and can optionally create
a GUI Service/Ingress and a Prometheus Operator `ServiceMonitor`. See the
[chart README](./../charts/rpdu2mqtt/README.md) for values.

Alternatively, download and modify the plain [Kubernetes Manifests](./../Examples/Kubernetes/manifests.yaml).

## unRAID

For deploying via unRAID GUI, see [unRAID](./../Examples/unRAID/README.md)
