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

Implement any combination. EmonCMS, for example, is a destination, a history provider and a configuration publisher.

| Interface | For |
| --- | --- |
| `IMeasurementDestination` | Receive readings and the flow hierarchy on each poll. |
| `IMeasurementHistory` | Answer what a node read at a past instant. |
| `IConfigurationPublisher` | Push *structure* to the far end — entities, feeds, dashboards — and sweep what you no longer own. |
| `INodeProvider` | Offer nodes the operator could adopt (discovery only; never write config). |
| `IValueSourcePlugin` | Supply live values for nodes bound to your source type. |
| `IDeviceSourcePlugin` | Poll hardware into a snapshot — this is how a second PDU vendor is supported. |
| `IDeviceControlPlugin` | Switch its outlets, when the hardware can. |
| `IIntegrationApi` | Actions beyond the standard ones. |
| `IStatusProvider` | Decide what your own health means, when the default is not specific enough. |
| `IConfigurablePlugin` | Carry your own settings section. |

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

## Supplying values, or being a device

Two capabilities read into the bridge:

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
- No custom editors. Plugins get the generated settings page and action buttons.
