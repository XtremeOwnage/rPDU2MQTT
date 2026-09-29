---
title: Installation
---

# Installation

## Container image

Images are published to GitHub Container Registry as **`ghcr.io/xtremeownage/rpdu2mqtt`**. The tags
are listed under [Deployment › Container image & tags](../deployment/index.md#container-image-tags).

```bash
docker run -d --name rpdu2mqtt --restart unless-stopped \
  -v "$(pwd)/config.yaml:/config/config.yaml:ro" \
  -p 8080:8080 \
  ghcr.io/xtremeownage/rpdu2mqtt:stable
```

The container runs `dotnet rPDU2MQTT.dll` from `/app`, as a non-root user, and reads `config.yaml`
from `/config` (or the working directory). For anything long-lived, use
[Docker Compose](../deployment/docker-compose.md).

## Kubernetes

The Helm chart lives in the repository at `charts/rpdu2mqtt`:

```bash
helm install rpdu2mqtt ./charts/rpdu2mqtt -n rpdu2mqtt --create-namespace -f my-values.yaml
```

See [Helm chart](../deployment/helm.md), [Argo CD](../deployment/argo-cd.md) and the
[Kubernetes CRD](../deployment/kubernetes-crd.md) config source.

## From source

The service targets **.NET 10**.

```bash
git clone https://github.com/XtremeOwnage/rPDU2MQTT.git
cd rPDU2MQTT
dotnet build rPDU2MQTT/rPDU2MQTT.csproj -c Release
cd rPDU2MQTT/bin/Release/net10.0
dotnet rPDU2MQTT.dll
```

The GUI bundle (`rPDU2MQTT.Web/wwwroot`) is committed. When `node` is on the `PATH`, the build
regenerates it from the TypeScript under `rPDU2MQTT.Web/web/src`; without `node` the committed bundle
is used as is.

On Linux, `config.yaml` is looked for in `/config` and then the working directory; on Windows, only the
working directory. If none is found the process logs the paths it searched, waits 15 seconds and exits.
