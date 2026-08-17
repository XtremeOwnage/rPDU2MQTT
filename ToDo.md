Branch feat/v4-plugin-architecture. Plan: [PLUGINS.md](PLUGINS.md).

One branch, not one PR per slice. `[x]` done, `[—]` a decision recorded rather than work outstanding. Every numbered item leaves the tree green: `dotnet build` (0 warnings),
`dotnet test`, and the GUI checks that run inside the build. Commit SHAs land beside each heading as it
finishes.

1. Contracts + registry
    [x] `IIntegration` — a vendor's identity: `Id`, `DisplayName`, `Group`, `Enabled`, `Misconfigured`, probe.
    [x] `IMeasurementDestination` — receives an `ExportPass`; declares its own tag filter and whether its
        output is per-process (Prometheus) or cluster-wide (everything else).
    [x] `IMeasurementHistory` — renamed from `IFlowHistory`; node-addressed, so it answers for an outlet
        exactly as for a virtual tier.
    [x] `IConfigurationPublisher` — pushing structure to the far end is its own direction of travel, not a
        footnote on the destination. Owns its sweep.
    [x] `IIntegrationApi` + `IntegrationAction` — transport-free actions. No ASP.NET in Core.
    [x] `IntegrationActions.For()` — capabilities imply their actions (`probe`, `publish`, `sweep`); the
        API declaration is only for what nothing else implies.
    [x] `ExportPass` — snapshot + readings + flow tiers + timestamp, built once per poll. Readings carry
        their instance id, which a merged snapshot would otherwise lose.
    [x] `IntegrationRegistry` — reflection over the Engine assembly, no hand-maintained list.
    [x] `IntegrationStatus` — one status per id, replacing the bespoke holders.
    [x] `ISingleOwnerLease` — the one coordination hook, `SoleOwnerLease` for single-process.
    [x] `DestinationHost` — builds the pass once, fans it out, records status per integration.
    [x] `INodeProvider` — "what have you got that I could model?" Discovery only; never writes config.
        (No `INodeExporter`: publishing what a node *is* is `IConfigurationPublisher`, publishing what it
        *reads* is `IMeasurementDestination`. A third name would be a synonym.)
    [x] `FlowNodeId` — one spelling of `pdu:{device}` / `outlet:{device}:{key}`, and every reading carries
        its own `NodeId`. Eight places rebuilt those strings; two disagreed on 0- vs 1-based.
    [x] The lease is keyed by the resource, so one device is decided in one place. An owner that cannot be
        determined returns "not owner" rather than assuming: two readers on one serial gateway is the
        failure this exists to prevent. (Item 15 replaced the grain-backed implementation with
        `SoleOwnerLease`; the seam and the rule are unchanged.)
    [x] `MqttNodeProvider` — the broker's topics offered as nodes through `INodeProvider`, reading the
        same index and the same payload analyzer the node editor uses, so a discovered node and a
        hand-bound one agree about what a topic is. Served at `/api/discover/nodes`, which asks every
        provider. Verified against the existing picker: same 5 results, with metric hints and suggested ids.
    [x] `ModbusNodeProvider` offers the configured devices. Deliberately does NOT scan registers on every
        keystroke: `DiscoverAsync` backs a picker, and a scan is a real round-trip to a shared gateway —
        the constraint that gave devices a lease in the first place. The deep browse stays in the register
        explorer, opened against one device on purpose.

2. Prometheus onto the contracts (the proving case)
    [x] `PrometheusIntegration` implements `IMeasurementDestination` + `IMeasurementHistory` — one vendor,
        two capabilities, one config section.
    [x] `PrometheusExportService` deleted; registration replaced by `DestinationHost`.
    [x] `/metrics` output verified identical before and after — 9 series, exact diff, A/B against
        the pre-conversion binary on one rig. (The energy store lives beside the binary, so both stores
        have to be wiped or the comparison is against a different day's state.)
    [x] Its banner line and status branch are gone — both come from the registry now.
    [x] `/api/integrations/{id}/{action}` is mounted, and the bespoke endpoints it replaced are DELETED:
        `/api/test/emoncms`, `/api/emoncms/provision-feeds`, `/api/emoncms/delete-feeds`. The GUI buttons
        call the generic route, so a button and the API cannot do different things.
    [x] EmonCMS provisioning holds the single-owner lease. The deleted endpoint got that from a grain;
        losing it would have let two instances race and create duplicate feeds.
    [x] `/api/test/mqtt` and `/api/test/pdu` deleted. Resolving the overlap meant making the probes do
        real work rather than renaming: `mqtt/probe` reports the live broker connection instead of the
        configured address ("Publishing" while disconnected is the card that sends someone looking at the
        wrong thing), and `vertiv/probe` actually dials each PDU instead of reporting snapshot age — a
        probe is what an operator triggers when the board is ALREADY wrong, so "last poll was 4 minutes
        ago" is the question, not the answer.
    [x] `/api/test/history` kept but no longer a second implementation: it resolves which integration the
        History setting selected and runs THAT integration's own probe. The question is still its own (the
        answer changes when the setting changes, not when an integration does); only the duplicate probe
        went.

3. The other destinations
    [x] EmonCMS — destination + history + configuration publisher (feed provisioning + sweep). Three
        capabilities on one vendor, one config section. `EmonCmsExportService` deleted.
    [x] `IMessagePublisher` — publishing to the broker without inheriting `baseMQTTService`'s whole hosting
        model. EmonCMS's MQTT transport needed it; HA discovery will too.
    [x] MQTT energy-flow export — `IMeasurementDestination` (tier state topics) + `IConfigurationPublisher`
        (the HA discovery documents describing those topics). `EnergyFlowMqttExportService` deleted.
    [x] Home Assistant Energy Dashboard — pure `IConfigurationPublisher`; it never sends a reading, which is
        the clearest case for that contract existing. `HaEnergyDashboardService` deleted.
    [x] `ConfigurationPublisherHost` — publishers run on their own slow cadence, always leader-gated.
    [x] `MQTTPublishingService` converted. Its helpers moved off `basePublishingService` onto
        `MqttPduPublisher` (the publish seam), and `MqttPduIntegration` is a destination like any other.
        It publishes from `ExportPass.Snapshots`, not the merged view, so each device carries its OWN poll
        time — `expire_after` is judged against exactly that.
    [x] Home Assistant discovery is reachable through `HomeAssistantIntegration`: publish republishes the
        discovery documents AND syncs the dashboard, sweep clears both. Two halves of "what HA knows about
        us" behind one integration instead of two unrelated buttons. The discovery service still owns the
        periodic publish.

4. Generic health, test and faults
    [x] `IStatusProvider` — an integration decides what its own health means, with a shared default
        (off / misconfigured / whatever it last did). The verdict used to be a branch per integration in
        StatusReporter, which a plugin could not participate in at all.
    [x] `IntegrationStatusGrain` — the board card for anything without a bespoke grain, so a plugin is no
        longer simply absent (indistinguishable from one that failed to load).
    [x] Microsoft.Extensions health checks: every integration becomes a standard `IHealthCheck`, served at
        `/health/integrations`, tagged so a readiness probe is NOT failed by a degraded optional exporter.
        The adapter lives in Engine so a plugin author never sees the health-check package.
    [x] `/api/integrations/{id}/{action}` replaces the per-destination test endpoints (probe is derived).
    [x] Startup banner built from the registry. Fixed while verifying: it reported a switched-OFF EmonCMS
        as "DISABLED (misconfigured)" because the fault was read without checking Enabled first.
    [x] EmonCMS, Prometheus and Home Assistant adopted `IStatusProvider`. The verdicts moved onto the
        integrations that own them; the grains keep only their cross-process judgement (EmonCMS still
        refuses to let an outcome-free report overwrite a known one, which is about WHO is reporting rather
        than what healthy means). Three branches gone from StatusReporter.
    [x] Generic action buttons: `integrationActionBar()` renders whatever an integration says it can do,
        naming none of them. Destructive actions confirm, and say what they will remove, first. The
        hand-wired per-destination functions stay until every built-in is converted onto the contracts.
    [x] `DestinationRequirements.EmonCms` retired — the rule lives on `EmonCmsIntegration.Misconfigured`,
        which is the only place a plugin can put one. Its test moved onto the live rule; it had been
        passing against a static helper the production path no longer called.
    [x] `IntegrationFaultReporter` records every enabled-but-unusable integration into the SAME
        `ConfigurationFaults` the board and GUI read. (A DI factory would have replaced the instance
        already holding the logging-sink faults — caught before committing.)
    [x] Verified: EmonCMS enabled with no URL logs an error, reads Unhealthy on /health/integrations, and
        the bridge keeps serving.

5. Nav and grouping from the schema
    [x] `group` on `SchemaNode`, set from the integration's own `IntegrationGroup`. A plugin now lands in
        Destinations rather than among the logging and diagnostics pages.
    [x] Plugin sections bind to `Config.Plugins[id]` — Config was compiled before the plugin existed —
        while rendering and change-tracking identically to a built-in.
    [x] Fixed while here: `build()` pushed ungrouped sections into the module-level `NAV_GROUPS` constant,
        so every rebuild of the form appended them again and saving twice listed a page three times.
    [x] `[NavGroup]` on the config model, emitted on the schema, so EVERY section is placed by what the
        schema says — built-in and plugin alike. `NAV_GROUPS` keeps only the visual editors (Flow, Nodes,
        Trends), which have no schema section to declare a group on. Schema sections lead each group so a
        `child` tool still indents under the page it belongs to.
    [x] `plugin.check.mjs` renders a plugin the GUI has never heard of and asserts it gets a nav entry in
        its declared group, generated fields bound under `Plugins/`, and buttons from its declared actions.
        Runs in the build. Verified by sabotage: removing the action bar fails it.

6. Sources onto the contracts
    [x] `IValueSourcePlugin` — a plugin supplies live values for bindings naming its own type, joining the
        same `CompositeFlowValueSource` the built-in ingests feed. The graph cannot tell where a value came
        from, which it never could.
    [x] `EnergyFlowSource.Settings` — an open bag for a plugin type's fields. NOT the nested per-type
        migration this item originally called for: the built-ins keep their typed fields, because
        rewriting every existing node's wiring buys nothing for anyone already using them and is the one
        change on this branch that could lose an operator's configuration.
    [x] Plugin source types are offered in the node editor's dropdown, appended to the declared set and
        marked dynamic so the CRD keeps the plain one — it cannot validate a type that exists only on one
        machine, and an unknown type is not rejected at runtime, it simply has nothing supplying it.
    [x] `ValueSourcePluginHost` reconciles on a timer with change detection, so a binding added in the GUI
        takes effect without a restart and an expensive ReconcileAsync is not paid every tick.
    [x] Verified: HelloWorld as a source fed 1234 W into a node, which rolled up through the inverter and
        reached Prometheus.
    [x] MQTT and Modbus ingests declare `IIntegration` + `IStatusProvider` — the SAME instances the flow
        already reads, registered as integrations so the registry, banner and health board describe what is
        actually running. Their hosting stays their own: one is a subscriber with no cadence to share, the
        other polls per connection with framing probes and gateway-contention rules the shared host knows
        nothing about. "Withheld" is surfaced as its own amber state — the binding is right, the publisher
        stopped, and the node reads no-data rather than a stale number.
    [x] `source-editors.ts` — a registry keyed by source type. MQTT and Modbus keep their bespoke editors
        (a topic browser and a register scanner are not a form); anything else gets a generic editor over
        the binding's `Settings` bag, so a plugin source is editable without shipping any TypeScript.
    [x] `SOURCE_TYPES` is gone. The dropdown reads the schema's own enum, which the server already fills
        with the plugin types it loaded — duplicating that list is how the dropdown ends up missing a type
        the backend accepts.

7. Devices
    [x] `IDeviceSourcePlugin` — a plugin polls hardware into a `PduData` snapshot and publishes it on the
        same bus the built-in poller uses, so publishing, discovery, the flow graph and every destination
        work on it unchanged. This is what makes a second PDU vendor a contribution rather than a fork.
    [x] `DeviceSourcePluginHost` owns the timer, the failure reporting and the single-owner lease, so a
        plugin author never writes any of them. A failed poll leaves the previous snapshot to go stale
        rather than publishing an empty one, which downstream would read as every outlet going to zero.
    [x] `VertivIntegration` — the hardware this bridge was written for is a first-class integration:
        registry, banner, Status board, /health/integrations, per-instance freshness judged against each
        instance's own poll interval. It is no longer the one thing that is special.
    [x] The dependency is inverted. The poller reads through `IDeviceReader` — `VertivDeviceReader` for a
        configured PDU, `PluginDeviceReader` for a plugin device — so a plugin device inherits the cadence,
        the ownership lease and the write path instead of reimplementing them. `DeviceSourcePluginHost`
        (the parallel poller) is deleted.
    [x] The poll drives and collects plugin device instances too. Caught on the rig: the plugin device was
        polled correctly and nothing downstream saw it, because the collecting side still iterated only the
        configured PDUs.
    [x] Verified end to end: the plugin device reports 77 W per outlet, and switching outlet 0 took it to 0
        while outlet 1 stayed at 77.
    [x] `IDeviceControlPlugin` — a plugin device's outlets can be switched. The write path routes to the
        plugin that owns the device id, holding the single-owner lease; a device with no reboot says so
        via Supports() rather than failing the command.
    [x] Verified end to end: the example plugin as a device publishes outlet names, state and power to
        MQTT, appears as `rpdu2mqtt_realpower{device="hello_device"}` and as flow tiers under its own PDU
        tier — indistinguishable from a real PDU downstream.
    [x] The GUI's control endpoint goes through `IOutletControl` now, not the Vertiv client, so it can
        switch a plugin device too. Verified: outlet 0 of the example plugin device went 77 W -> 0 through
        `/api/control/outlet` while outlet 1 was untouched.

8. External plugins (built — the earlier "in-tree only" call was reversed)
    [x] `PluginLoader` — scans `plugins/` (or `RPDU2MQTT_PLUGINS`), one `AssemblyLoadContext` each, host
        types shared. A plugin that will not load is reported and skipped.
    [x] `IConfigurablePlugin` + `PluginConfigBinder` — a plugin declares a settings class; its section is
        stored under `Config.Plugins[id]` and bound on load.
    [x] `Config.Plugins` is `Dictionary<string, object?>`, NOT JsonNode: YamlDotNet cannot construct a
        JsonNode, and typing it that way made any config with a Plugins section fail to parse — taking the
        whole bridge down rather than one plugin. Caught on the rig, fixed, CRDs regenerated.
    [x] YAML scalars are re-typed on the way to JSON (`"true"` -> true, `"10"` -> 10), or every bool and
        number silently falls back to its default.
    [x] `Examples/Plugins/HelloWorld` — a working out-of-tree destination in ~60 lines, referencing only
        Core. Verified end to end: loaded from a DLL, bound its own YAML config, received the ExportPass
        and wrote every reading and tier to a file.
    [x] Plugin config pages render. The live `/api/schema` (GuiService, not the CLI emitter) now serves
        `ConfigSchema.Build(pluginSections)`, so a plugin's settings class becomes a page with typed
        inputs, defaults and descriptions — verified end to end with HelloWorld.
    [x] `GET /api/integrations` lists every integration with its capabilities and actions.
    [x] `POST /api/integrations/{id}/{action}` invokes any of them. Verified: the plugin's own `peek`
        action and a built-in derived `probe` both round-trip, and an unknown action is refused by name.
    [x] Nav grouping for plugin sections — verified: helloworld lands in Destinations.
    [x] The GUI renders a plugin's action buttons from `/api/integrations`.

9. Extend — only once everything above is converted
    [x] Done via `HistoryValueSource` (see item 8 above).
    [x] `HomeAssistantValueSource` — a node valued from an HA entity, for the meter or inverter that is
        already in HA through some other integration. Unavailable/non-numeric is nothing, never zero, and
        values convert to canonical units on the way in so a W and a kW entity roll up together.
    [x] `HomeAssistantHistory` — the recorder as a third history backend. Matched by the unique_id this
        bridge publishes discovery under, so the lookup is exact rather than a guess at a display name.
        One request for the whole node set, not one per node.

9. Tests for the contracts themselves
    [x] `IntegrationHostTests` (10) — one pass shared by every destination, a failing destination recorded
        against itself without stopping the others, per-process destinations running on a non-leader, stale
        snapshots not exported, instance identity surviving the merge, configuration published on its own
        cadence and never from a non-leader, and an integration's own verdict beating the shared one.
    [x] `ValueSourceContractTests` (6) — a source handed only its own bindings, the storage key accounting
        for direction and accumulation, unchanged config not re-applied, a changed binding applied without
        a restart, stored values refusing to answer before a fetch or after going stale, and an unreadable
        backend leaving what it had rather than blanking every node.
    [x] `DeviceContractTests` (8) — a reader owning exactly its instance, null meaning "nothing to report"
        rather than zero, a failed poll throwing so the host attributes it, control reporting what happened
        rather than what was asked, and each device keeping its own interval.
    [x] Verified by sabotage: leader-gating everything and letting one failure abort the pass each fail
        the tests written for them.

10. Duplication the conversions exposed
    [x] `Core.Ticks.Next` replaces fifteen copies of the same `SafeWait` helper. Twelve predate this branch;
        I copied the convention into three more before noticing. The subtlety is worth having in one place:
        in `do { … } while (await timer.WaitForNextTickAsync(ct))` the await sits in the while-CONDITION,
        outside the try, so cancelling on shutdown throws past the loop's own handler and the host reports a
        background-service crash on every clean stop.
    [x] Verified: a real run now stops on SIGTERM with zero unhandled/crash lines.
    [x] `EmonCmsStatus` is now a VIEW over `IntegrationStatus`, not a second store. Its name and shape are
        kept because the Status board, the heartbeat and the GUI all read them; only the storage merged.
        Two holders for one idea is how a card and an endpoint end up disagreeing about the same export,
        with neither looking wrong on its own. Existing EmonCMS status tests pass unchanged, and health,
        probe, /api/integrations and /api/diagnostics were checked against one running bridge.

11. Documentation
    [x] `docs/v4-plugins.md` — what shipped and why, following the v2/v3 convention.
    [x] `Examples/Plugins/README.md` covers supplying values and being a device, including the two rules
        that are not negotiable: return null rather than an empty snapshot, and report what happened rather
        than what was asked.
    [x] Root `README.md` mentions plugins, so someone finds this without reading the source.
    [x] `web/schema.fixture.json` regenerated — it drives the smoke tests and had drifted well behind the
        config model. Plugin sections are stripped from it deliberately: the fixture describes the BUILD,
        and `plugin.check.mjs` supplies its own.

12. Making plugins usable where the bridge actually runs
    [x] Dockerfile creates `/app/plugins`, so a bind mount has somewhere to land and the loader's
        "directory does not exist" path is not the normal case.
    [x] Helm chart mounts a plugins volume when `plugins.enabled`. Read-only on purpose: a plugin directory
        the workload can write to is a way to change what code runs without changing the image. The volume
        SOURCE is left to the operator (PVC, init container, ConfigMap binaryData) because how a DLL reaches
        a cluster is not a decision this chart should make.
    [x] CI templates both plugin combinations and greps for the mount. Plugins are off by default, so the
        existing default render never reached the block — it would have been untested template.
    [x] Verified locally after all: helm downloads and runs here (it just wasn't installed). All ten
        combinations render — default, split, operator, replicaCount=3, NetworkPolicy with egress, plugins,
        autoRestart, the CRD config source, everything at once, and --include-crds.
        This caught a real break: removing the `rpdu2mqtt.clustered` helper left a dangling `{{- end -}}`
        in `_helpers.tpl`, so EVERY render failed with a parse error and I had reported the chart edits as
        fine. `helm lint` says so in one second. A CI step now renders each combination and fails if
        orleans/silo ports reappear.
        Lesson: "reviewed by eye" is not a verification, and the tool I assumed was missing was one curl
        away.

13. Found in the GUI, not in the tests
    [x] The raw `Plugins` dictionary rendered as its own page with a free-text key box — while every loaded
        plugin ALSO rendered its own typed section. Two editors for one thing, and the raw one is a text
        input over a dictionary of objects nobody can usefully type into. Hidden like `EnergyFlow`, which
        has the same relationship to the Flow/Nodes editors.
    [x] `plugin.check.mjs` fails if it comes back. Sabotage-verified.
    Lesson: every check I wrote asserted a plugin's page IS rendered. None asserted the storage behind it
    is NOT. "The right thing appears" and "nothing else appears" are different assertions.

14. The shutdown exception (reported from the debugger)
    [x] `ChannelMessageBus.Read` enumerated with `ReadAllAsync(token)`, which THROWS on cancellation. An
        iterator cannot catch around a `yield return` — only try/finally is legal — so the exception escaped
        into whatever was enumerating: `SnapshotCache`, a BackgroundService, and the host reported a crashed
        background service on every clean stop. Rewritten as a manual read loop: await inside the try, yield
        outside it.
    [x] `SnapshotCache.ExecuteAsync` guards too — an already-cancelled token can throw before the first read.
    [x] `MessageBusShutdownTests` (3). Verified against the original code: two of the three fail on it.
    Pre-existing (v2), not introduced by this branch — but the same family as the `Ticks.Next` bug, which
    is three occurrences of "cancellation is an ending, not a fault" in one codebase.

15. Remove Orleans (v4 continued)
    Why it is tractable: Orleans persists NOTHING here — zero IPersistentState, zero reminders, zero
    streams — so this is a coordination swap, not a state migration. And Core/Abstractions/Engine/Api
    reference it zero times already; it reaches only the host (17 files), Grains (2,818 lines) and
    GuiService.

    What it costs, stated plainly: split-role multi-process deployment and multi-replica single-owner
    guarantees. In ONE process every grain is an in-process singleton. The chart already defaults to
    `split.enabled: false` + `replicaCount: 1`, which is the target. The seams stay (`ISingleOwnerLease`,
    `LeaderState`), so a Redis-backed implementation could bring clustering back without touching an
    integration.

    [x] Decoupling first (asked for mid-flight, and the right order — removing a framework is exactly when
        coupling sneaks in). `IBrokerConnection` replaces a concrete `IHiveMQClient` inside the MQTT
        integration: an integration should no more be able to tell which MQTT library this build uses than
        it can tell that coordination happens to be Orleans. `VertivIntegration` asks its `IDeviceReader`
        to read rather than reaching into `PduInstanceRegistry` for the HTTP clients.
        Remaining Engine references are each an integration's OWN machinery (EmonCMS's feed sync, HA's
        discovery coordinator, the MQTT publisher, Vertiv's client) — the thing that speaks that protocol,
        which is the one dependency an integration is supposed to have.

    [~] A. Projections in memory.
        [x] Status board. `Core.Status.StatusBoard` replaces a grain per component plus a projection grain:
            each held one report and ran its own 10s timer purely to re-evaluate and push a card that had
            probably not changed. Evaluated ON READ now, which also removes the staleness those timers
            existed to paper over — an "…ago" is computed when someone looks, so it cannot be out of date.
            The verdict rules moved to Core as pure functions, 8 tests. 15 cards verified identical on a
            running bridge.
        [x] Topic index. `Core.Discovery.TopicIndex` — both bounds survive (a lease in time, a cap in
            size) and both are checked on READ now, so a leased index has nothing running in the
            background, which is what "leased" was always supposed to mean.
        [x] Process registry. `Core.Diagnostics.ProcessRegistry`. In one process this is a list of one and
            that is the honest shape; the type stays so the board and diagnostics page are unchanged.

    INCIDENT: I wrote `rPDU2MQTT.Tests/TopicIndexTests.cs` with a heredoc without checking whether the file
    existed. It did — 13 tests (`TopicSampleAnalyzerTests`, `TopicIndexGrainTests`) — and I destroyed all of
    them. Caught only because the suite total dropped from 813 to 806 and I chased the seven I could not
    account for. Restored from HEAD, and the 8 grain tests retargeted at the in-memory index rather than
    deleted: the behaviour and the assertions are identical, only where it lives changed, which is the whole
    claim of the move. Now 819 = 813 + 6 new.
    Lesson: `cat > file` and `Write` silently clobber. Check the path exists first, ALWAYS, and treat a
    falling test count as a defect to explain rather than noise.
    [x] B. Ownership in memory.
        [x] Flow values. `FlowValueSink` writes straight into the `FlowValueCache` the graph reads. The old
            path was: sink -> flow grain -> the grain's OWN FlowValueCache -> a service polling that grain
            every 2s -> this process's cache. In one process that is a write, a read, and up to a two-second
            delay before a reading is visible, for data that was already local. `FlowGrainSink` and
            `FlowGrainSyncService` deleted; the source-ordering rule (stale by BOTH version and time, so a
            restarted source is not locked out) came with it.
        [x] PDU supervision + outlet/group control. `DevicePollService` replaces an activator driving a PDU
            grain that handed each device its own document, each device grain each outlet its own, each
            outlet a measured node, and a sync service polling the PDU grain every second to publish the
            snapshot onto the local bus. In one process all of that is: read the device, publish the
            snapshot. The roll-up was never lost — `FlowGraphBuilder` computes it from the same snapshot
            and always did; the tree was a second implementation whose only reader was a diagnostics panel.
            Writes are `DeviceOutletControl`, and the ownership rule is kept exactly: a write goes to the
            PDU that REPORTED the device (resolved from the same poll the grains learned it from), never to
            whichever is primary, and nothing polled means the write goes nowhere rather than guessing. The
            four ownership tests were retargeted, not deleted — 5 now, including "the same group name on two
            PDUs is two groups".
        [x] Modbus. `ModbusPollService` folds the reconciler and the per-device grain into one loop. The
            part that matters is unchanged: two config connections to the same host:port:unitId are ONE
            reader, because a single-client RS485 gateway can only answer one. Health moved to
            `Core.Modbus.ModbusDevices`, which is what the diagnostics page reads.
        [x] EmonCMS feeds. Deleted outright rather than ported: `IConfigurationPublisher` + the lease
            already do this, on the publisher's own cadence, gated by `PublishingEnabled`. The grain and its
            poker were a second path to the same `EmonCmsFeedSync`. Its gating tests were retargeted at the
            integration (3), so "disabled/unconfigured/auto-configure-off provisions nothing" still holds.
        [x] Operator. `KubernetesOperator` behind `Core.Operator.IOperatorControl`; the GUI depends on the
            seam, so outside Kubernetes there is simply no implementation and every endpoint says so once,
            in one place, instead of each inventing an answer.
    [x] C. Leader + period audit. `LeaderState.IsLeader` is set true at startup — one process is always the
        leader — and the gate stays because it is real and because a clustered build would set it from
        outside. `Core.Flow.PeriodAuditor` replaces the audit grain the ingests blocked on with
        `GetAwaiter().GetResult()`; it is synchronous because withholding is a correctness decision that has
        to be made before the reading goes anywhere.
    [x] D. Deleted: both Grains projects, the silo config, the placement director, the test cluster, and the
        five Orleans packages. Also out of the chart: the membership CRDs, the silo/gateway ports and their
        NetworkPolicy rules, the orleans RBAC Role, `RPDU2MQTT_ORLEANS_CLUSTERING`, and the CI step that
        checked the CRDs ship. `/api/grains` and the Diagnostics "Grains" panel are gone — there are no
        grains to count, and the Components panel already lists the processes.
        Tests: 813 -> 804. Removed 15 (6 status-grain, 6 placement, 1 leader-election, 1 Orleans smoke,
        1 process-registry-grain), added 6 (3 board rules the grain tests covered and the board's did not,
        3 process registry). The suite runs in ~1s rather than ~3s: no in-memory cluster to stand up.

    WHAT THIS COSTS, restated now that it is done: multi-replica coordination. There is no leader election
    and no cross-process lease, so `replicaCount: 1` is not a default any more, it is the supported shape —
    two replicas would each poll the PDUs and each publish. The chart says so, and `split.enabled` still
    works because roles gate services and only the worker produces data. The seams (`ISingleOwnerLease`,
    `LeaderState`) are untouched, so a Redis/Valkey-backed implementation is two files, not a redesign.
    [x] E. Measured, same rig, same config, same 60s sample point (stub broker + stub EmonCMS, no PDU):

        |                        | with Orleans | without | change |
        | ---------------------- | ------------ | ------- | ------ |
        | start -> /metrics answers | 1.29s / 1.28s | 0.64s / 0.75s | ~2x faster |
        | RSS at 60s             | 166 MB / 170 MB | 133 MB / 135 MB | -20% |
        | threads                | 25-26        | 23      | -3 |
        | Prometheus series      | 6            | 6       | same |
        | MQTT topics published  | 3            | 3       | identical set |
        | test suite             | ~3s          | ~1s     | no cluster to stand up |

        Output equivalence is only over the flow path and status here — the rig has no PDU stub, so the PDU
        object model is not in that comparison. It is covered by DevicePollServiceTests instead (read,
        publish, cadence, and "nothing to report publishes nothing"), sabotage-verified.

    [x] F. Nothing in the tree says "grain" any more. The prose went with the code — including five
        abstractions nothing implemented once the grains were gone (`IFlowMiddleware`, `NodeSpec`,
        `PduChildren`, `DeviceState`, `OutletState`) and `RawValue`, which existed only to sync a grain's
        values out to each process.

Notes
    - Branched off `fix/export-flow-nodes-and-tag-picker` (#386), which carries `FlowTiers`. Rebase
      `--onto origin/main` once that squash-merges.
    - Docs to update before this branch opens a PR: `docs/v2-architecture.md` pointer, `README.md`
      integration list, and a `docs/v4-plugins.md` written from `PLUGINS.md` if it outgrows the root file.

16. Found by running it, not by the tests
    [x] A plugin device's outlet could not be switched. The write path matched a plugin by its INSTANCE id
        (`helloworld`), but a write addresses a DEVICE id (`hello_device`) — so it fell through to the PDU
        path, was refused as "not configured", and the GUI reported success anyway. Both halves were wrong
        and each hid the other: the plugin route now resolves the instance that reported the device (the
        same fact the poll already established), and it accepts either spelling.
    [x] `IOutletControl` returns `OutletWriteResult(Ok, Message)` instead of a bare string. Every caller had
        to decide something on it and none could: the GUI answered ok to a refusal, and the MQTT subscriber
        echoed the new state to Home Assistant for a write that never reached a device — which is the same
        fabrication as publishing a reading nobody took, and it shows up as a switch flipping back by itself
        a few seconds later with nothing to explain it.
    [x] Verified on the rig: switching outlet 0 of the plugin device takes it to 0 W and leaves outlet 1 at
        77 W; the PDU total follows 154 -> 77. Two tests cover it (either spelling reaches the plugin; an
        unsupported action is refused without calling it).
    [x] A plugin device published every value to a BARE topic at the broker root — `state`, `name`,
        `alarm`, `onDelay` — instead of `<parent>/<device>/outlets/<n>/…`. A plugin declares a device, not a
        topic tree, and the wiring that gives each entity its path and its Home Assistant unique_id was only
        ever applied by the Vertiv poller and by the wire form a grain shipped. `PluginDeviceReader` applies
        it now (`RawSnapshotMapper.Rewire`, which had no production caller left).
        Nothing subscribed to those leaves, so nothing looked broken: Prometheus and the flow tiers were
        right the whole time, and only MQTT/Home Assistant were wrong.
    [x] A device answers to either of its names — the entity name its readings are published under, and the
        key its topic path is built from. A command arrives carrying whichever one the sender saw, and for
        the example plugin those differ (`hello_device` vs `hw`), so the MQTT command topic resolved to
        nothing.
    [x] Verified on the rig: `rPDU2MQTT/hw/outlets/0/set` = "off" takes outlet 0 to 0 W and echoes
        `state = off`; a command for a device nobody reported is logged as not applied and echoes NOTHING.
    Lesson: 812 tests were green while the one button that writes to a plugin device did nothing, and while
    that device's whole MQTT tree was landing at the broker root. The tests all asked "does the refusal say
    the right thing", none asked "does a write that should work, work" — and none looked at the topics.

    [ ] SEPARATE, PRE-EXISTING, needs your call: `FlowGraphBuilder` drops any outlet reading `<= 0` from the
        graph (`if (value <= 0) continue;`, there since #156). So a switched-OFF outlet does not read 0 W on
        the flow tiers — its series disappears entirely, and Prometheus prunes it. The PDU object model
        reports 0 correctly; only the flow view differs. Absent and zero are different facts: a consumer
        cannot tell "switched off" from "no longer reported". Leaving it alone because changing it moves
        every Sankey ribbon and every flow series, which is a bigger decision than this branch.
    [x] A plugin device got no Home Assistant entities at all. Discovery was built from the Vertiv rPDU
        document alone (`data.PDUs`), which a plugin has none of, so the device that published a full topic
        tree and full Prometheus series was invisible to Home Assistant. It is discovered from the snapshot
        cache now, through the same entity builders and the same identifiers a PDU's outlets use, under a
        parent device keyed by the plugin's instance id.
    [x] And an unreachable PDU no longer costs everyone their discovery: the fetch was the first statement
        in the pass, so one timeout meant nothing at all was published. Its own entities are skipped; the
        rest still go out.
    [x] Verified on the rig, reading the retained documents: `homeassistant/device/rPDU2MQTT_hw_outlets_0`
        carries `state_topic rPDU2MQTT/hw/outlets/0/state`, `command_topic .../set` and `.../reboot`, the
        delay/config topics, `availability_topic rPDU2MQTT/Status`, stable unique_ids, and
        `via_device rPDU2MQTT_hw` -> `rPDU2MQTT_helloworld`. Every topic in the document is one the bridge
        actually publishes, and the command topic round-trips back to the plugin.

17. What has actually been RUN, and what has not
    A stub rig now covers the main path end to end: a Vertiv-shaped PDU (`run/pdu.mjs` — /api with four
    outlets, the login handshake, outlet control), the stub broker, a stub EmonCMS, and the example plugin
    loaded as a device.

    [x] PDU poll -> snapshot -> 150 MQTT topics, 37 Prometheus series, Home Assistant discovery (the device
        plus all four outlets), EmonCMS input posts. Switched-off outlet 3 reads 0 W in the object model.
    [x] Writes both ways, for a PDU and for a plugin device: the GUI endpoint and the MQTT command topic.
        120.5 W -> 0 on a write, the state echo published, and a write to an unknown device refused with a
        reason and NO echo.
    [x] EmonCMS feed provisioning: lists feeds/inputs, creates the missing ones (6), sets processlists.
    [x] All 31 GUI GET endpoints answer 200. The five that answer `ok:false` are correct refusals for
        features this rig has not configured (Kubernetes-only endpoints, history off, no HA token).
    [x] Status board: 15 cards, each correct for the rig's actual state.
    [x] Clean SIGTERM shutdown, no unhandled exceptions across any run.
    [x] One scare investigated and dismissed: the board reported MQTT "Disconnected" late in a long run.
        The pre-removal build reports connected on the same rig — but only because it was queried 25s in.
        Measured in the same window, this build reports connected too, with zero publish timeouts. The stub
        broker degrades under sustained QoS1 traffic and the bridge correctly noticed and said so.

    NOT run, and worth saying plainly:
    [ ] The GUI in a browser. There is none in this environment, so the pages are covered by the DOM checks
        only — the original "looks like ass in Chrome" report can only be confirmed by the maintainer.
    [ ] OneView (multi-PDU aggregation) and OneView group control. The stub is a single non-OneView PDU.
    [ ] Multiple PDU instances at once, which is what the write-ownership rule exists for. Covered by tests,
        not by a run.
    [ ] History backends answering queries (Prometheus/EmonCMS/Influx) and the Trends/Energy pages on real
        stored data.
    [ ] Kubernetes: the operator, the CRD config source, the chart applied to a live cluster. The chart is
        rendered in ten combinations; rendering is not applying.
    [ ] Redis/Valkey cache path (energy totals shared across restarts).
    [ ] Real hardware.
