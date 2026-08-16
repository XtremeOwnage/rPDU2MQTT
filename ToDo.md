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
    [x] `GrainSingleOwnerLease` — ownership of one key held cluster-wide on a short lease, keyed by the
        resource so one device is decided in one place. A cluster that cannot be asked returns "not owner"
        rather than assuming: two processes on one serial gateway is the failure this exists to prevent.
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
    [—] `/api/test/history` stays. It asks "is the selected backend answering", which is a question about
        the History setting rather than about any one integration — the answer changes when that setting
        changes, not when an integration does.

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
    [x] The dependency is inverted. `PduGrain` polls through `IDeviceReader` — `VertivDeviceReader` for a
        configured PDU, `PluginDeviceReader` for a plugin device — so a plugin device inherits the single
        cluster-wide activation AND the device/outlet/group child supervision that outlet writes route
        through, instead of reimplementing them. `DeviceSourcePluginHost` (the parallel poller) is deleted.
    [x] `PduGrainActivator` and `PduSyncService` drive and collect plugin device instances too. Caught on
        the rig: the grain polled the plugin device correctly and nothing downstream saw it, because the
        sync service still iterated only the configured PDUs.
    [x] Verified end to end: the plugin device reports 77 W per outlet through the grain path, and
        switching outlet 0 took it to 0 while outlet 1 stayed at 77.
    [x] `IDeviceControlPlugin` — a plugin device's outlets can be switched. `OutletGrainControl` routes to
        the plugin that owns the device id, holding the single-owner lease; a device with no reboot says so
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

Notes
    - Branched off `fix/export-flow-nodes-and-tag-picker` (#386), which carries `FlowTiers`. Rebase
      `--onto origin/main` once that squash-merges.
    - Docs to update before this branch opens a PR: `docs/v2-architecture.md` pointer, `README.md`
      integration list, and a `docs/v4-plugins.md` written from `PLUGINS.md` if it outgrows the root file.
