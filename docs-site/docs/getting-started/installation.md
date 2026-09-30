---
title: Installation
---

# Installation

## Container

Image: `ghcr.io/xtremeownage/rpdu2mqtt`. Tags: [Container image](../deployment/index.md#container-image).

```bash
docker run -d --name rpdu2mqtt --restart unless-stopped \
  -v "$(pwd)/config.yaml:/config/config.yaml" \
  -p 8080:8080 \
  ghcr.io/xtremeownage/rpdu2mqtt:stable
```

- Runs as a non-root user from `/app`.
- Reads `config.yaml` from `/config`, then the working directory.
- Long-lived installs: [Docker Compose](../deployment/docker-compose.md).

## Kubernetes

```bash
helm install rpdu2mqtt ./charts/rpdu2mqtt -n rpdu2mqtt --create-namespace -f my-values.yaml
```

See [Helm chart](../deployment/helm.md), [Argo CD](../deployment/argo-cd.md), [Kubernetes CRD](../deployment/kubernetes-crd.md).

## From source

Requires .NET 10.

```bash
git clone https://github.com/XtremeOwnage/rPDU2MQTT.git
cd rPDU2MQTT
dotnet build rPDU2MQTT/rPDU2MQTT.csproj -c Release
cd rPDU2MQTT/bin/Release/net10.0
dotnet rPDU2MQTT.dll
```

The GUI bundle (`rPDU2MQTT.Web/wwwroot`) is committed. With `node` on the `PATH`, the build regenerates it from `rPDU2MQTT.Web/web/src`.
