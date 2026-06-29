# Version 2.0 Architecture (design)

**Status:** draft for review · **Tracking:** #127 · **Audience:** maintainers/contributors

This is the design for the Version 2.0 refactor. It captures the target architecture, the decisions
behind it, and an **incremental** migration plan that keeps v1.x working at every step. Nothing here is
built yet — it's the plan to review and steer before code churn.

## Goals (from #127)

1. **Multiple PDU instances** — connect to many PDUs, not one. Instances can be **added/removed from the
   GUI and loaded/unloaded at runtime** without a restart.
2. **Strict producer/consumer separation** — sources (PDUs, later MQTT inputs, inverters, etc.) are
   decoupled from sinks (MQTT/HA discovery, Prometheus, EmonCMS, future energy-flow mapping).
3. **Three components** — User Interface · Middle tier / API (config + cached data) · Automation / data
   processing (polls sources, moves data).
4. **REST API + Swagger** — a documented HTTP API for integration.
5. Enables later v2.0 features: energy-flow mapping into Home Assistant, extra producers (Tigo #130,
   inverter/transfer-switch streams), Sankey (#97).

## Decisions

- **Runtime model: in-process `System.Threading.Channels`.** A poll-producer per source publishes
  snapshots to a bus; sinks subscribe. This is more than enough for the workload (a handful of PDUs polled
  every few seconds → a few sinks) and needs **zero extra infrastructure**.
  - *Considered and rejected for now: Microsoft Orleans.* Grains/streams are built for cloud-scale,
    distributed, on-demand-activated stateful entities. Here they'd be overkill: a silo + clustering +
    (realistically) Redis, and the grain **idle-deactivation** lifecycle actively fights a long-lived
    polling loop. Channels deliver the same producer/consumer separation, multi-instance, and live
    add/remove with far less complexity.
- **Keep an Orleans-ready seam.** The bus sits behind a small **`IMessageBus`** abstraction so a different
  backend (incl. Orleans) could be slotted in later **if** a genuine distributed need appears — without
  re-plumbing producers/consumers.
- **No new required infra.** Single process, single container by default; Redis/queues only if a future
  distributed mode is actually pursued.
- **Design-doc-first**, then incremental PRs that each keep the app shippable.

## Current architecture (v1.x) and why it must change

```
Program.cs ─ Host ─ DI singletons: Config, IHiveMQClient, PDU, PduApiHandler
                     hosted services (all share the one PDU + broker):
                       MQTTPublishingService ─┐
                       PrometheusExportService ├─ each calls PDU.GetRootData_Public() (shared cache)
                       EmonCmsExportService    │
                       HomeAssistantDiscovery ─┘
                     GuiService (embedded web UI + REST-ish endpoints)
```

Limitations for v2.0:
- **Single instance everywhere** — `Config.PDU`, one `PDU` singleton, one MQTT client, wired once at
  startup. No notion of N sources.
- **No producer/consumer boundary** — consumers reach into the shared poll cache; there's no bus, so you
  can't add/remove sources or sinks independently, or at runtime.
- **One process, one project** — UI, API, and data processing are intermixed.

## Target architecture (v2.0)

### Component / project split

| Project | Role (#127 component) | Contents |
| --- | --- | --- |
| `rPDU2MQTT.Core` | shared | Contracts, DTOs (the snapshot/reading model), config schema, the `IMessageBus` interface. No infra. |
| `rPDU2MQTT.Engine` | Automation / data processing | The pipeline: source pollers, the bus (Channels), sink consumers, and the instance manager. |
| `rPDU2MQTT.Api` | Middle tier / API | REST API + Swagger; reads/writes configuration; exposes cached data + control; drives the engine. |
| `rPDU2MQTT.Web` | User Interface | The GUI (today's embedded web app), talking only to the API. |
| `rPDU2MQTT.Tests` | — | Unit/integration tests. |

> Packaging stays a **single container** that hosts the engine + API + UI together. The project
> boundaries enforce the producer/consumer/UI separation regardless of deployment.

### The pipeline (Channels)

- **`PduPoller`** (one per configured PDU) — owns the connection/session to a single PDU, polls on its
  interval, and **writes `PduSnapshot` items to the bus**. Each poller is a hosted loop with its own
  `CancellationTokenSource`; **starting/stopping it = load/unload** (the natural fit a grain wouldn't be).
- **`IMessageBus`** — a thin pub/sub over `System.Threading.Channels`: producers `Publish(snapshot)`;
  each consumer gets its own bounded channel (independent back-pressure, one slow sink can't stall
  others). This is the single seam an alternate backend would implement.
- **`InstanceManager`** — the registry of sources: add/remove/list, start/stop pollers at runtime, and
  persist the set (config source). Drives live add/remove from the GUI/API.
- **Consumers** — subscribe to the bus: `MqttSink`, `PrometheusSink`, `EmonCmsSink`,
  `HomeAssistantDiscoverySink`. Each is independent; adding/removing a sink never touches producers.

```
InstanceManager ──manages──> PduPoller (×N)
                                  │ polls each PDU
                                  ▼
                            IMessageBus  ──fan-out──> MqttSink
                          (Channels pub/sub)          PrometheusSink
                                                       EmonCmsSink
                                                       HomeAssistantDiscoverySink
                                                       (future) EnergyFlowMapper, Sankey…
```

### Configuration model

- `Config.PDU` (single) → **`Config.Pdus`**: a keyed collection of named PDU instances (each with its own
  connection, poll interval, credentials, overrides).
- Sinks (MQTT/Prometheus/EmonCMS/HA) become **consumer configs**, decoupled from any single source.
- The **CRD / GUI** gain add/remove for instances; the instance manager applies changes live.
- **Back-compat:** a v1 single-`PDU` config is auto-migrated to a one-entry `Pdus` map on load, so
  existing deployments keep working.

### REST API + Swagger

- `rPDU2MQTT.Api` exposes the operations the GUI already needs (config CRUD, live data, control, paths,
  diagnostics) as a documented REST API with Swagger/OpenAPI, plus instance add/remove/start/stop. The UI
  becomes a pure client of this API.

## Migration plan (incremental — each step ships)

**Status: all phases complete (#127).** Each shipped as its own PR; the pipeline is in place.

1. ✅ **Bus + snapshot model** — `IMessageBus` (Channels) + `PduSnapshot` in `Core`.
2. ✅ **`PduPoller`** — polling moved into a producer publishing snapshots to the bus.
3. ✅ **Consumers on the snapshot pipeline** — MQTT/Prometheus/EmonCMS/HA read the cached snapshots
   (pull-cache) instead of polling the PDU directly.
4. ✅ **Multi-instance config + `InstanceManager`** — `Config.Pdus` (with v1 `PDU:` auto-migration);
   per-instance PDU construction + output namespacing; GUI per-tab instance selection.
5. ✅ **Live add/remove** — `InstanceManager` reconciles pollers at runtime when instances are
   saved in the GUI (the primary stays fixed; its connection change still needs a restart).
6. ✅ **REST API + project split** — read + control REST API with OpenAPI/Scalar (`Api.*`); the code
   is split into `rPDU2MQTT.Core` / `.Engine` / `.Api` / `.Web` + the host exe.

Later (separate issues, built on this): energy-flow mapping (#128/#129), Tigo producer (#130),
Sankey (#97).

## Distributed mode — running roles as separate processes (#127)

The single executable can run a subset of the workloads, so the three components can scale out across
processes (or stay one node by default). The project boundaries already enforce the producer/consumer/UI
split; this is the *runtime* split, behind the same `IMessageBus` seam.

- **Role selection** — `--role` / `RPDU2MQTT_ROLE` picks `worker` (data processing), `api`, `ui`, or a
  comma list. Unset → `all` (one node, everything; the default — unchanged). Singletons are always
  registered; only the *hosted services* (the work) are gated by role.
- **Cross-process bus** — `MqttBusBridge` (loaded only when roles are split) carries snapshots over the
  existing broker: a `worker` mirrors each snapshot to a retained `‹parent›/_bus/snapshot/‹id›` topic; a
  consumer-only node ingests them back onto its own bus → its `SnapshotCache`.
- **Wire contract** — `RawSnapshot` (a plain, round-trippable DTO) carries the *finished* poll: raw
  source name/label plus the computed display identity (`Entity_Name`/`DisplayName`/`Make`/`Model`) and
  measurements. The worker transforms once (as it already does for its own sinks); the consumer renders
  without re-running the non-idempotent transform.
- **Read path** — the GUI/API read PDU data through the `SnapshotCache` (filled by the local poller, or by
  the bridge on a consumer), falling back to a direct poll while the cache is cold. So a `ui`/`api` node
  serves a worker's data without reaching a PDU itself.

Still worker-side (need the live connection): polling, control/actions, discovery. Cross-process operation
needs end-to-end verification against a real broker + two processes.

## Risks / open questions

- **Back-pressure / slow sinks** — per-consumer bounded channels isolate a slow/broken sink; decide the
  bounded-channel policy (drop-oldest vs wait) per sink. A blocked sink must not stall polling.
- **Config breaking change** — `PDU` → `Pdus`; covered by auto-migration, but the CRD schema + examples
  change. Needs a clear upgrade note at the v2.0 release.
- **Project split churn** — extracting four projects touches namespaces/build/Docker/CI; do it as its own
  step (6) after the pipeline is in place, not up front.
- **Scope** — this is several PRs. Each migration step above is its own reviewable change.

## Not in scope here

- The actual energy-flow mapping / Sankey / Tigo features (separate v2.0 issues).
