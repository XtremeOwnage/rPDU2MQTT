---
title: Writing a plugin
---

# Writing a plugin

A .NET class library that references `rPDU2MQTT.Core` and implements `IIntegration` plus any capabilities. Copy the DLL into `plugins/`.

Example: [HelloWorld](https://github.com/XtremeOwnage/rPDU2MQTT/tree/main/Examples/Plugins/HelloWorld), a destination that writes every reading and tier to a file.

## The project

```xml
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <Nullable>enable</Nullable>
  </PropertyGroup>
  <ItemGroup>
    <!-- Ship only your own DLL; the host provides Core. -->
    <ProjectReference Include="path/to/rPDU2MQTT.Core.csproj" Private="false" ExcludeAssets="runtime" />
  </ItemGroup>
</Project>
```

`rPDU2MQTT.Core` contains the contracts, config model, flow engine and helpers. No ASP.NET or MQTT client dependency.

A plugin loads only on a bridge with the same major `rPDU2MQTT.Core` version and an equal or newer minor. Otherwise it is skipped and the Plugins page says why.

## The identity

```csharp
public sealed class MyPlugin : IIntegration
{
    public string Id => "influx";                            // lowercase, stable
    public string DisplayName => "InfluxDB";                 // nav label, status card
    public IntegrationGroup Group => IntegrationGroup.Destinations;
    public bool Enabled(Config cfg) => settings.Enabled;     // read live

    // Optional: a non-null reason disables the plugin and is reported.
    public string? Misconfigured(Config cfg) => ...;
}
```

## The capabilities

Implement any combination.

| Interface | For |
| --- | --- |
| `IMeasurementDestination` | Receive readings and the flow hierarchy on each poll. |
| `IMeasurementHistory` | Answer what a node read at a past instant. |
| `IConfigurationPublisher` | Push *structure* to the far end — entities, feeds, dashboards — and sweep what you no longer own. |
| `INodeProvider` | Offer nodes the operator could adopt (discovery only; never write config). |
| `IValueSourcePlugin` | Supply live values for nodes bound to your source type. |
| `IDeviceSourcePlugin` | Poll hardware into a snapshot. |
| `IDeviceControlPlugin` | Switch its outlets, when the hardware can. |
| `IIntegrationApi` | Actions beyond the standard ones. |
| `IStatusProvider` | Decide what your own health means. |
| `IConfigurablePlugin` | Carry your own settings section. |
| `IGuiPageProvider` | Ship your own GUI pages. |
| `IEntityExtensionProvider` | Keep your own settings on nodes, panels and breakers. |
| `IExportContributor` | Publish tiers of your own beside the flow's nodes, each with its own topic and Home Assistant device. |
| `IAreaProvider` | Say which Home Assistant area each node's device belongs in. |
| `IPluginStoreUser` | Keep named hashes across restarts (Valkey/Redis when the cache is on). |

### Receiving data

```csharp
public Task SendAsync(ExportPass pass, CancellationToken ct)
{
    foreach (var r in pass.Readings)              // every PDU measurement
        Send(r.NodeId, r.Type, r.Value, r.Units);

    foreach (var t in pass.TiersFor(Tags(cfg)))   // flow tiers, filtered by tag
        Send(t.Node.Id, t.Metric, t.Value, t.Units);

    return Task.CompletedTask;
}
```

- `ExportPass` is built once per poll and shared by every destination.
- An exception is recorded against the plugin id; other destinations still run.
- A tier with no value is absent from `Tiers`.
- `LeaderGated` defaults to `true`: one process in a cluster calls you. Set `false` for per-process output (Prometheus does).

## Your settings

```csharp
public sealed class MySettings
{
    [DefaultValue(false)]
    [Description("Send readings to InfluxDB.")]     // shown under the field in the GUI
    public bool Enabled { get; set; }

    [Description("Base URL, e.g. http://influx:8086.")]
    public string? Url { get; set; }
}

// on the plugin:
public Type ConfigType => typeof(MySettings);
public void ApplyConfig(object s) => settings = (MySettings)s;
```

The GUI generates a settings page from the class: typed inputs, defaults, descriptions.

Stored under `Plugins:`, keyed by id:

```yaml
Plugins:
  influx:
    Enabled: true
    Url: http://influx:8086
```

## Settings on nodes, panels and breakers

A plugin can keep settings of its own on core entities it does not define. Declare a settings class per entity kind:

```csharp
public IReadOnlyDictionary<string, Type> EntityExtensions { get; } = new Dictionary<string, Type>
{
    [EntityKind.Node] = typeof(MyNodeSettings),
};
```

The node editor (and the panel schedule, for panels and breakers) renders them from the class, as it renders your settings page. They are stored on the entity under `Ext:`, keyed by your plugin id, and kept as they are while your plugin is not loaded:

```yaml
EnergyFlow:
  Nodes:
    - Id: fridge
      Ext:
        influx:
          Measurement: kitchen
```

Read and write them with `EntityExtensions.Read<MyNodeSettings>(node, Id)` and `EntityExtensions.Write(node, Id, settings)`.

A field whose choices only the running bridge knows takes `[ChoicesFrom("/api/...")]`: the GUI asks that path for `[value, label]` pairs and draws a dropdown, or a box to tick per choice on a list.

## Your actions

Standard actions come from the implemented interfaces:

| Action | Comes from |
| --- | --- |
| `probe` | `IIntegration` — always present |
| `publish`, `sweep` | `IConfigurationPublisher` |

Custom actions:

```csharp
public IReadOnlyList<IntegrationAction> Actions =>
[
    new("backfill", "Backfill", "Re-send the last hour.", ActionEffect.Write,
        async (ctx, ct) => new { ok = true, sent = await Backfill(ctx.Int("hours", 1), ct) }),
];
```

- Each action is at `POST /api/integrations/{id}/{action}` and gets a button on the settings page.
- `ActionEffect.Destructive` makes the GUI confirm first.
- Query and form values arrive on the action context.

## Your pages

```csharp
public IReadOnlyList<GuiPage> Pages => [new("my-page", "My Page", "Energy Flow", "☀", "EnergyFlow")];
public string? PageAsset(string file) => GuiPageAssets.Read(typeof(MyPlugin).Assembly, file);
```

`GuiPage(Id, Title, Group, Icon, ConfigSection)`:

| Field | Value |
|-------|-------|
| `Id` | File name without extension. The host serves `{Id}.js` and `{Id}.css`. |
| `Title` | Nav entry text. |
| `Group` | `Sources`, `Energy Flow`, `Integrations`, `Destinations` or `System`. |
| `Icon` | Nav glyph. Optional. |
| `ConfigSection` | Comma-separated config paths the page edits (e.g. `Plugins.tigo.Strings`). Their unsaved edits count on the nav entry. Optional. |

- Embed `{Id}.js` and, optionally, `{Id}.css` in the plugin assembly.
- Served from `GET /api/integrations/{id}/pages/{file}`. File names match `^[a-z0-9][a-z0-9-]*\.(js|css)$`.
- The script is a function body that returns `mount(section, host)`. It runs on the page's first open.
- `mount` may return `{ show }`. `show` runs each time the page opens.
- `PageSettings`: keys under `Plugins.{id}` that only the pages read. Saving them needs no restart.
- `host`: `api`, `btn`, `el`, `ensure`, `toast`, `state`, `refreshDirty`, `saveConfig`, `openHistorySheet`, `busyInSection`, `timelineStrip`, `stepToFit`, `temp` (`unit`, `to`, `from`, `fmt`: °C to the chosen unit and back).
- Example: the Tigo plugin's Solar Array page, `plugins/rPDU2MQTT.Plugin.Tigo/web/`.
- `INodeManager.ManagedNodes`: rules (`SourceType` or `Tag`) for the nodes the plugin maintains. **Hide managed** on the Nodes page hides them.

## Supplying values, or being a device

```csharp
// A node binds { Type: "mything", Metric: "realpower", Settings: { … } } and you supply the value.
public string SourceType => "mything";
public string SourceTypeLabel => "My Thing";

public Task ReconcileAsync(Config cfg, IReadOnlyList<SourceBinding> bindings, CancellationToken ct)
{
    // Called with this source type's bindings, and again whenever the configuration changes.
    foreach (var b in bindings) values[b.NodeId + "|" + b.Key()] = Read(b.Setting("Address"));
    return Task.CompletedTask;
}

public bool TryGetValue(string nodeId, string metric, out double value) => values.TryGetValue(…);
```

```csharp
// Or poll hardware. The snapshot goes through the same pipeline as a Vertiv PDU's.
public string InstanceId => "mydevice";
public Task<PduData?> PollAsync(Config cfg, CancellationToken ct) => …;

// Optional: switching its outlets.
public bool Supports(string action) => action is "on" or "off";
public Task<string> ControlOutletAsync(Config cfg, string deviceId, int outlet, string action, CancellationToken ct) => …;
```

- Return `null` when there is nothing to report. An empty snapshot reads as every outlet at zero.
- Return the result the hardware reports, not the requested state.
- The host provides the poll timer, leader gate and device lock.

## Installing it

```
dotnet build
cp bin/Debug/net10.0/MyPlugin.dll  <bridge>/plugins/
```

Restart. The log shows `Plugin loaded: MyPlugin.dll — influx.` `RPDU2MQTT_PLUGINS` sets another directory.

- Each plugin has its own load context.
- A plugin that fails to load is reported and skipped.

## Limits

- The Kubernetes CRD does not validate plugin settings. They are stored in the open `Plugins` map.
