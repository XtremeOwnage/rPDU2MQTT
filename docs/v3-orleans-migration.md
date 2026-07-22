# v3 — Orleans migration plan (RFC)

Status: **landed** (#225). This was written as a proposal — a plan, not a commitment, to make the trade-offs
concrete before any code moved. It is kept as the record of *why* v3 looks the way it does; the sections
below are the reasoning at the time of writing, not a description of the current code.

What actually shipped, against the plan:

- **Single-activation ownership** — as proposed, and it went further than the plan: a `PduGrain` per
  instance that hands each child its own document, one grain per outlet and per OneView group owning that
  thing's writes, and single-owner grains for EmonCMS provisioning and the Modbus devices. The `if (worker)`
  gating for single-owner work is gone; it's a property of the topology now.
- **Energy flow as actors** — this is the part the plan got wrong. It said the graph math should stay
  centralised ("node *state* may be distributed; node *computation* is centralised"). It didn't: each node
  is a grain that subscribes to the nodes it depends on, recomputes on a push, and publishes onward, so a
  change touches only the path from the node that moved to the root. `Value()` is a cached read rather than
  a tree walk.
- **Membership replaced the heartbeat** — `HeartbeatService`'s retained-topic beacons are gone; the Status
  board is component grains that publish their own verdicts.
- **Location-transparent reads** replaced `MqttBusBridge`'s MQTT mirroring of PDU snapshots.

Caveats worth re-reading below: the "not free" section held up, particularly around serialization at the
grain boundary and the cost of a chatty grain call in a hot path.

## Why

Every split-deployment fix so far has been us paying, by hand, for cluster coordination:

- **Single-owner work.** A Modbus gateway accepts one TCP client at a time, so the poller had to be pinned
  to the Worker role (`if (worker)`), and PDU pollers likewise. That's a static, deployment-shaped hack for
  a "exactly one of these, cluster-wide" requirement.
- **Cross-node reads.** The API/UI can't see the worker's Modbus values without us building propagation
  (`MqttBusBridge` mirrors PDU snapshots over MQTT; flow values aren't propagated at all). The Nodes editor
  works around it by opening its own device connection.
- **Fire-and-forget commands.** Operator check / set-tag / redeploy and tier restarts are published to MQTT
  command topics and the result is polled back off the CR status. No request/response, no return value.
- **Liveness.** `HeartbeatService` hand-rolls a retained-topic beacon + tombstone scheme so the GUI can list
  processes — i.e. re-implements cluster membership.
- **Topology-coupled wiring.** `ServiceConfiguration` branches on `worker/api/ui/operator` to decide which
  hosted services start where, and `KubernetesConfigWatcher.RequiresRestart` bounces pods for a subset of
  changes. Local (`all`) and split-k8s run materially different code paths.

[Microsoft Orleans](https://learn.microsoft.com/dotnet/orleans/) (virtual-actor framework) is a direct fit
for this class of problem: **single-activation** grains give "exactly one, cluster-wide" for free;
**location-transparent** grain calls replace the bespoke propagation and command plumbing; **membership**
replaces the heartbeat scheme; and grains decouple *what work exists* from *which process runs it*, which is
the topology coupling we keep fighting.

Secondary goal (explicitly stated): **organization.** A grain-per-responsibility model with a hard rule —
grains orchestrate, `Core` computes, adapters do I/O — gives the codebase a spine it currently lacks.

## Non-goals

- **MQTT is not going away.** Publishing to the broker (HA discovery, tier export, availability) is the
  product's *output*, not internal coordination. It stays. Orleans replaces the *internal* MQTT plumbing
  (bus bridge, command topics, heartbeat), not the external contract.
- **No domain rewrite.** `FlowGraphBuilder`, `FlowUnits`, `ModbusDecode`, `ConfigSchema`, mapping/overrides,
  the exporters' logic — all transport-agnostic, all reused unchanged.
- **No persistence/event-sourcing** unless a concrete need appears. Grain state is rebuilt from config + the
  device/registry on activation.
- **Not a big-bang.** Orleans co-exists with the current host; concerns migrate one at a time behind the
  seams we already have (`IFlowValueSource`, `IMessageBus`).

## Guiding principles

1. **Strangler-fig.** Each phase is independently shippable and reversible. The old path stays behind its
   interface until the grain path is proven, then it's deleted.
2. **Layering rule (the organization win):**
   - `Core` — pure domain + math. **No Orleans, no I/O.** Stays unit-testable exactly as today.
   - **Adapters** (`Engine`) — Modbus client, MQTT client, PDU HTTP, registry, k8s client. Thin, injectable.
   - **Grains** — orchestration only: hold identity + state, run timers/reminders, call Core + adapters.
   - Host — silo bootstrap + Kestrel.
3. **One identity per grain.** Device grain keyed by connection id, node grain by node id, PDU grain by
   instance id, topic grain by topic. Placement and single-activation follow from identity.
4. **Local dev stays trivial.** `UseLocalhostClustering` + in-memory streams ⇒ a single-process `--role all`
   behaves exactly like today.

## Target architecture

Every process becomes an **Orleans silo**. The only remaining "role" distinction is **web-facing silo**
(also hosts Kestrel for API/GUI) vs **headless silo** — because grains don't serve HTTP. Everything else is
grains placed by Orleans across whatever silos exist.

**Clustering provider** (the one real new dependency):
- In-cluster: `Microsoft.Orleans.Clustering.Kubernetes` — membership via the k8s API, **no external DB**.
  Needs RBAC for its membership objects (documented like the existing CRD RBAC).
- Local / single node: `UseLocalhostClustering()`.
- Multi-host non-k8s (compose across machines): ADO.NET/Redis provider — call this out as the one topology
  that gains a dependency; most users are single-node or k8s.

**Stream provider:** start with the in-memory provider (in-cluster fan-out is all we need). Revisit a
persistent provider only if at-least-once across silo restarts becomes a requirement.

### Component → grain map

| Today | Becomes | Grain kind |
| --- | --- | --- |
| `EnergyFlowModbusSourceService` (+ worker-only gate, "Test device read") | `IDeviceGrain` per Modbus connection id — owns the connection, timer-polls, serves `GetLatest()`/`Read()` | single-activation |
| `EnergyFlowMqttSourceService` (self-gates in every process) | `IMqttIngestGrain` (single-activation) owns the flow-topic subscription, publishes to a stream | single-activation + streams |
| `FlowValueCache` / `CompositeFlowValueSource` (per-process) | `IFlowValueGrain` per node id (holds latest per metric) + `IFlowGraphGrain` (builds graph on demand via Core) | keyed / singleton |
| `InstanceManager` + `PduPoller` (worker-only) | `IPduGrain` per instance id — single-activation, distributes across silos automatically | single-activation |
| `OperatorService` + `OperatorCommand` MQTT topics + CR-status polling | `IOperatorGrain` (singleton): `CheckNow()`, `SetTag()`, `Redeploy()` as calls with **return values**; reminder drives the periodic check | singleton + reminder |
| `HeartbeatService` (retained beacons + tombstones) | Orleans **membership** + the management grain; GUI lists silos, not hand-rolled processes | framework |
| `MqttBusBridge` (mirror snapshots over MQTT for split) | gone — cross-process reads are grain calls | — |
| `RestartCommandService` (restart-over-bus) | grain calls / silo lifecycle; k8s rollout stays in `IOperatorGrain` | — |
| `KubernetesConfigWatcher.RequiresRestart` | config-change stream → grains reconcile live; only Kestrel rebinds still restart (see caveat) | streams |
| Exporters (`MQTTPublishing`, `EnergyFlowMqttExport`, `Prometheus`, `EmonCms*`, `HADiscovery`, `HaEnergyDashboard`, `OutletCommand`) | stay hosted services **or** become grains later; they consume grain state | unchanged first |
| `ApiService`, `GuiService`, `HealthService` | stay Kestrel; call grains instead of in-process singletons | unchanged |

### Project restructure (organization)

```
rPDU2MQTT.Core            domain + math. no Orleans, no I/O.  (unchanged)
rPDU2MQTT.Grains.Abstractions   grain interfaces + DTOs. tiny deps. referenced everywhere.
rPDU2MQTT.Grains          grain implementations. references Core + Engine adapters + Abstractions.
rPDU2MQTT.Engine          shrinks to adapters: Modbus/MQTT/PDU/registry/k8s clients + protocol helpers.
rPDU2MQTT.Api / .Web      Kestrel endpoints; depend on Grains.Abstractions (call grains via IGrainFactory).
rPDU2MQTT                 silo host (Orleans + Kestrel bootstrap).
```

The abstractions project having near-zero dependencies is what keeps the graph clean: API/GUI/exporters
depend on *interfaces*, not implementations.

## Phased plan

Each phase builds, tests, and ships on its own.

- **Phase 0 — Silo bootstrap, no behavior change.** Add Orleans to the host; every process co-hosts a silo
  alongside the current Generic Host + Kestrel. Localhost clustering locally, k8s clustering in-cluster. No
  real grains yet (a trivial ping grain to prove the cluster forms). De-risks the infra + clustering RBAC
  before any logic moves. *Exit:* silos form a cluster in k8s and locally; nothing else changed.

- **Phase 1 — `IDeviceGrain` (highest pain, cleanest win).** Per Modbus connection: single-activation, owns
  the connection, grain-timer polls, serves cached values; the connection lock lives *in the grain*. Rewire
  the Modbus half of `IFlowValueSource` to call the grain. Delete the worker-only gate and the contention.
  This one phase validates single-activation + remote calls + kills the current bug. *Exit:* one poller
  cluster-wide regardless of silo count; UI reads values via grain call, no direct device connection.

- **Phase 2 — `IMqttIngestGrain` + streams.** One grain owns the flow-topic MQTT subscription and streams
  events to per-node value grains. Remove the per-process `EnergyFlowMqttSourceService` duplication. *Exit:*
  exactly one subscriber per topic cluster-wide; failover is automatic (single-activation + reminder).

- **Phase 3 — flow value/graph grains.** Replace `FlowValueCache`/composite with `IFlowValueGrain` +
  `IFlowGraphGrain`; API/GUI read the graph via grain call. Delete `MqttBusBridge`. *Exit:* split API/UI show
  live Modbus + MQTT values without polling anything themselves (closes the gap Phase-1's caveat left).

- **Phase 4 — `IPduGrain`.** `InstanceManager`/`PduPoller` → per-instance grains, distributed across silos.
  *Exit:* multiple worker silos share PDU load, each instance polled exactly once — multi-worker is now free.

- **Phase 5 — `IOperatorGrain`.** Replace the operator MQTT command topics + CR-status polling with grain
  calls that return results; reminder drives the periodic check. *Exit:* check/switch/redeploy are
  synchronous calls with real success/failure.

- **Phase 6 — retire the hand-rolled plane.** Delete `HeartbeatService` (membership), `RestartCommandService`
  (grain/lifecycle), and collapse `ServiceConfiguration`'s role branching into silo placement + "web-facing
  vs headless." *Exit:* the tier/role concept is gone except for who hosts Kestrel.

Exporters (Phase 7+, optional) can stay hosted services indefinitely; move them to grains only if they need
single-activation (e.g. HA discovery should publish once, not per silo — worth grain-ifying).

## Caveats — where this is *not* free (read before committing)

1. **Single-activation is not a distributed lock.** Orleans guarantees single activation under normal
   operation, but a network partition can *transiently* double-activate a grain. For a one-client Modbus
   device that matters: the device grain must still hold a real connection lock and tolerate a brief double
   gracefully (fail the second reader, don't corrupt). Design for it; don't assume the framework makes it
   impossible.
2. **Kestrel still rebinds.** The restarts we hit today are mostly **listening-socket / OIDC-auth** changes —
   Orleans doesn't fix those; a port change still needs a Kestrel rebind. The *domain* config already
   live-reloads. So "grains end all restarts" is false; be honest that it's the data plane that improves.
3. **HTTP hosting stays topological.** Someone binds ports and takes ingress. The tier concept shrinks to
   "web-facing silo," it doesn't vanish.
4. **Blocking reads vs single-threaded grains.** A grain activation is single-threaded; a slow Modbus read
   would block that grain. Poll on a timer into cached state and serve callers from cache (non-blocking);
   keep the actual device I/O off the calling path.
5. **New dependency + operational surface.** Clustering membership (mitigated: k8s provider = no DB, local =
   localhost), silo lifecycle, rolling-upgrade grain-interface versioning, membership/split-brain edge cases.
   Real, but well-trodden. Weigh against the "MQTT-and-nothing-else" self-host ethos.
6. **.NET target.** Orleans 9.x — verify the current release supports the repo's `net10.0` TFM (or pin the
   latest 9.x that does). Confirm in Phase 0.
7. **Migration cost.** Weeks, not days — but concentrated in the coordination layer we already fight, with
   domain logic reused. Phases 0–1 alone (a spike) tell you whether the operational weight is worth it before
   you commit the rest.

## Testing

- `Core` stays unit-tested as-is (no Orleans dependency — the layering rule pays off here).
- Grains tested with `Microsoft.Orleans.TestingHost` (in-memory test cluster) — activation, single-activation,
  timers/reminders, stream fan-out.
- Keep the existing xUnit suite; add a test-cluster fixture. CI gains an Orleans test project.

## Decisions to confirm before Phase 0

1. **Is multi-node actually a goal**, or is "one worker is basically always fine"? If the latter, the honest
   answer may be "don't" — Phases 1–3 still help, but 4–6 are speculative.
2. **Clustering provider** for each topology (k8s provider in-cluster is the default recommendation).
3. **Do we keep the internal MQTT bus** for anything external consumers rely on, or is it fully internal and
   safe to remove in Phase 3?
4. **Stream provider** — in-memory to start, or is at-least-once-across-restart needed day one?

## Recommendation

Do **Phase 0 + Phase 1** as a time-boxed spike (silo bootstrap + `IDeviceGrain`). It's contained, it kills a
real current bug, and it's the honest test of whether Orleans's operational weight is worth it for this app —
before committing to the full migration. Decide 2–6 on the evidence from that spike, not on paper.
