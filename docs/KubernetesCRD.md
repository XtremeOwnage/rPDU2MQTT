# Design proposal: Kubernetes CRD as a configuration source

**Status:** proposal (not implemented) · **Audience:** Kubernetes users · **Tracking:** follow-up to the
configuration GUI (#69)

This document proposes letting rPDU2MQTT read (and write) its configuration from a Kubernetes
**Custom Resource** instead of a file, as an *optional* source for people running in Kubernetes. It
is a design for review — no code has been written yet.

## Motivation

Today configuration is a single `config.yaml` loaded at startup (see
[`YamlConfigLoader`](../rPDU2MQTT/Startup/YamlConfigLoader.cs)), optionally mounted from a ConfigMap.
That works, but in Kubernetes it has two rough edges:

1. **A ConfigMap mount is read-only.** The configuration GUI detects this and disables *Save* (see the
   `configWritable` handling in [`GuiService`](../rPDU2MQTT/Services/Gui/GuiService.cs) and
   [Configuration.md](Configuration.md#gui-with-kubernetes--read-only-config)). So in k8s the GUI is
   view/test only.
2. The config is "just a blob" to Kubernetes — no schema validation, no health/status surfaced to the
   cluster.

A Custom Resource (CR) is a first-class, **writable** API object. Backing config with a CRD would:

- Make the **GUI's Save work in Kubernetes** (it would `PATCH` the CR's `spec` instead of a file).
- Give **server-side schema validation** at `kubectl apply` time (OpenAPI v3 on the CRD).
- Let the app report **status** back to the cluster (`kubectl get rpduconfig` shows connected / device
  count / last poll).
- Stay **GitOps-friendly** — the CR is a normal manifest you can keep in source control.

It is deliberately **optional**: Docker/compose/unRAID and plain-ConfigMap users are unaffected.

## Non-goals

- Not replacing the file/env config paths; the CRD is an additional, opt-in source.
- Not a multi-tenant operator that provisions Deployments (see *Phasing → Phase 3* for that idea).
- Not required to run in Kubernetes — a ConfigMap continues to work.

## The Custom Resource

```
apiVersion: rpdu2mqtt.xtremeownage.com/v1alpha1
kind: RpduConfig
metadata:
  name: rack-pdu-1
  namespace: rpdu2mqtt
spec:
  # Mirrors the existing Config model (MQTT, PDU, HomeAssistant, Overrides, Prometheus, EmonCMS, ...)
  MQTT:
    Connection: { Host: mqtt.example.com, Port: 1883 }
    ParentTopic: Rack_PDU
  PDU:
    Connection: { Host: rack-pdu-1.example.com, Port: 80 }
    PollInterval: 5
  HomeAssistant:
    DiscoveryEnabled: true
status:
  connected: true
  deviceCount: 2
  lastPoll: "2026-06-11T10:02:00Z"
  message: "OK"
```

- **Group/Version/Kind:** `rpdu2mqtt.xtremeownage.com` / `v1alpha1` / `RpduConfig` (namespaced).
- **`spec`** is the existing [`Config`](../rPDU2MQTT/Models/Config/Config.cs) shape, 1:1. Secrets
  (MQTT/PDU passwords, EmonCMS key) should still be sourceable from env/Secret via the existing
  `RPDU2MQTT_*` overrides so they don't have to live in the CR.
- **`status`** is a [status subresource](https://kubernetes.io/docs/tasks/extend-kubernetes/custom-resources/custom-resource-definitions/#status-subresource)
  the app patches.

### Generating the CRD schema from the model (key reuse)

We already reflect over the `Config` model to build the GUI's form schema
([`ConfigSchema.Build()`](../rPDU2MQTT/Services/Gui/ConfigSchema.cs)). The same reflection can emit the
CRD's **OpenAPI v3** `spec` schema, so the CRD validation stays in sync with the model automatically
instead of being hand-maintained. (Phase 1 can ship with `x-kubernetes-preserve-unknown-fields: true`
to avoid blocking on this, then tighten the schema once generation is wired up.)

## Application integration

Introduce a small config-source abstraction and select it at startup:

```
IConfigSource
  ├─ FileConfigSource        (today's YamlConfigLoader behaviour)
  └─ KubernetesConfigSource  (reads/writes the RpduConfig CR)

  Config Load();             // map source -> Config (reusing existing deserialization)
  bool   CanWrite { get; }   // drives the GUI's configWritable
  Task   Save(Config cfg);   // file write today; CR PATCH for k8s
```

- **Selection:** `RPDU2MQTT_CONFIG_SOURCE=k8s` (and/or auto-detect in-cluster via the ServiceAccount
  token at `/var/run/secrets/kubernetes.io/serviceaccount`), with `RPDU2MQTT_CR_NAME` /
  `RPDU2MQTT_NAMESPACE` to locate the CR. Default remains the file source.
- **Load:** `GET .../namespaces/<ns>/rpduconfigs/<name>`, take `.spec`, deserialize into `Config` with
  the existing logic (`InitializeConfig`, env overrides). [`ServiceConfiguration`](../rPDU2MQTT/Startup/ServiceConfiguration.cs)
  consumes the resulting `Config` exactly as it does today — nothing downstream changes.
- **Auth:** in-cluster ServiceAccount token; the official `KubernetesClient` NuGet handles in-cluster
  and kubeconfig contexts.
- **GUI write-back:** the [`POST /api/config`](../rPDU2MQTT/Services/Gui/GuiService.cs) handler calls
  `IConfigSource.Save`, which for k8s issues a `PATCH` to the CR `spec`. `configWritable` becomes true,
  re-enabling Save in-cluster.

### Secrets (decided)

When the Kubernetes config source is used, credentials live in a **Kubernetes Secret**, never inline in
the CR `spec`. The CR references them (e.g. a `secretRef`/`secretName` field), and the existing
`RPDU2MQTT_*` env overrides continue to populate them at runtime — so the secret-handling story is the
same one the Helm chart already uses. GUI write-back **never** writes secret values into the CR.

### GitOps & exporting manifests (decided)

The CR can be the GitOps source of truth, so:

- After a GUI **Save** that writes to a CR, the UI shows a **notice to update the GitOps source** so the
  cluster's desired state doesn't silently drift from the repo.
- The GUI's existing **Export** view ([`/api/config/yaml`](../rPDU2MQTT/Services/Gui/GuiService.cs))
  gains a **"RpduConfig manifest"** export that renders the current (edited) config as a ready-to-commit
  CR, **with secrets redacted to placeholders**. This lets users round-trip GUI edits back into source
  control.
- For the *full* set of supporting manifests (Service, ServiceMonitor, Deployment, RBAC), `helm template
  ./charts/rpdu2mqtt` remains the canonical export — the GUI export focuses on the config/CR, which is
  the only thing it actually edits.

### Reacting to changes & status (Phase 2)

- **Watch** the CR; on change, the simplest correct behaviour is
  `IHostApplicationLifetime.StopApplication()` so the container restarts and reloads (mirrors how the
  existing "Restart" diagnostic works). True hot-reload without restart is a larger change and is out
  of scope for Phase 1.
- **Status:** a lightweight hosted service patches `status` (connected from the MQTT client, device
  count + last poll from `PDU.GetRootData_Public`) on the poll interval, using the values already
  surfaced by `/api/status` and `/api/livedata`.

## Manifests to ship

Under `Examples/Kubernetes/crd/`:

- `crd.yaml` — the `RpduConfig` CustomResourceDefinition (with `status` subresource).
- `rbac.yaml` — `ServiceAccount`, plus a `Role`/`RoleBinding` granting `get,list,watch` on
  `rpduconfigs` and `patch` on `rpduconfigs/status` (and `patch` on `rpduconfigs` if GUI write-back is
  enabled), scoped to the namespace.
- `rpduconfig-sample.yaml` — an example CR.
- `deployment.yaml` — a Deployment using the ServiceAccount and the `RPDU2MQTT_CONFIG_SOURCE=k8s` env.

RBAC is intentionally minimal and namespaced. Installing the CRD itself requires cluster-admin (a
one-time step), documented alongside the manifests.

## Related: Prometheus Operator scraping (ServiceMonitor / PodMonitor)

rPDU2MQTT already exposes a Prometheus `/metrics` endpoint (the
[`PrometheusExportService`](../rPDU2MQTT/Services/PrometheusExportService.cs), gated by
`Prometheus.Enabled`). In a cluster running the **Prometheus Operator**, we can ship a
`ServiceMonitor` (or `PodMonitor`) so Prometheus **auto-discovers and scrapes** the endpoint — no
hand-written scrape config, and it tracks pod restarts/scaling automatically:

```yaml
apiVersion: v1
kind: Service
metadata:
  name: rpdu2mqtt-metrics
  labels: { app: rpdu2mqtt }
spec:
  selector: { app: rpdu2mqtt }
  ports:
    - name: metrics
      port: 9184
      targetPort: 9184
---
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: rpdu2mqtt
  labels: { release: kube-prometheus-stack }   # match your Prometheus serviceMonitorSelector
spec:
  selector: { matchLabels: { app: rpdu2mqtt } }
  endpoints:
    - port: metrics
      interval: 30s
```

Notes:
- `ServiceMonitor`/`PodMonitor` are CRDs **owned by the Prometheus Operator** — we don't define them,
  we just ship instances (and the `Service`). They require the operator to be installed.
- This is **orthogonal to the `RpduConfig` CRD** and much lighter — it's manifests only, no app
  changes. It could ship independently (even first), as an `Examples/Kubernetes/monitoring/` bundle,
  regardless of whether the config-CRD work happens.
- Pairs nicely with the proposed `status` subresource: scrape metrics via the ServiceMonitor, and read
  health/last-poll via `kubectl get rpduconfig`.

## Dependencies

- [`KubernetesClient`](https://www.nuget.org/packages/KubernetesClient) (official .NET client). Only
  loaded/active when the k8s source is selected; it does not affect file/compose users.

## Phasing

- **Phase 1 (MVP):** read config from the CR + ship CRD/RBAC manifests + GUI `PATCH` write-back. CRD
  uses `preserve-unknown-fields` initially. This delivers the headline win (declarative, GUI-writable
  config in k8s).
- **Phase 2:** generate the CRD OpenAPI schema from the `Config` model; watch + restart-on-change;
  `status` subresource.
- **Phase 3 (maybe):** a real controller managing multiple `RpduConfig` instances (one per PDU), with
  leader election. Likely overkill unless there's demand — a Deployment-per-PDU with its own CR is
  simpler and covers most needs.

## Alternative considered: patch the ConfigMap instead

If the *only* goal is "GUI Save works in k8s," the GUI could `PATCH` the **mounted ConfigMap** via the
K8s API rather than introducing a CRD. That is ~10% of the work and adds no new resource type, but you
lose CRD validation, the `status` subresource, and the first-class object feel. The CRD is the more
idiomatic, more capable answer; the ConfigMap patch is the pragmatic shortcut. Worth revisiting if the
CRD proves too heavy for the audience.

## Testing strategy

There is no cluster in normal dev/CI, so:

- Unit-test the `spec` ⇄ `Config` mapping and the schema/OpenAPI generation (no cluster needed).
- Integration-test against a local [`kind`](https://kind.sigs.k8s.io/) or `k3d` cluster (install CRD,
  apply a sample CR, run the app, assert it loads and patches status). This would be a manual / opt-in
  CI job, not part of the default `dotnet test` run.

## Decisions

1. **Secrets** → stored in a **Kubernetes Secret** and referenced from the CR; never inline in `spec`,
   and never written there by the GUI. (See *Secrets* above.)
2. **Multiple CRs** → acceptable when there is a benefit (e.g. one CR per PDU). Phase 1 ships a single
   named CR; the design does not preclude reconciling several later (Phase 3).
3. **GitOps** → after a GUI save to a CR the UI warns the user to update their GitOps source, and the
   GUI can **export the CR manifest** (secrets redacted) for re-importing into source control. (See
   *GitOps & exporting manifests* above.)

## Open questions

1. **CRD installation/ownership:** ship the CRD via the Helm chart's `crds/` directory **and** a
   standalone `crd.yaml` (the app does *not* self-register it, to avoid cluster-admin RBAC). Note: Helm
   does not upgrade resources in `crds/`, so CRD schema upgrades need a documented manual/`kubectl`
   step. Confirm this approach.
2. **GUI write-back default:** default *off* (opt-in) so the CR/GitOps stays the source of truth, or
   default *on* with the drift warning? (You're OK with the warning — question is just the default.)
3. **`status` subresource:** include it in Phase 1 (adds `patch rpduconfigs/status` RBAC), or defer to
   Phase 2? It's a nice `kubectl get rpduconfig` health view but not required to load config.
4. **CRD versioning:** the upgrade/conversion story before graduating `v1alpha1` → `v1` (conversion
   webhooks vs. a documented breaking bump).
