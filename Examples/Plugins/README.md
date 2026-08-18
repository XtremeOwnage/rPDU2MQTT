# Writing a plugin

A plugin is an ordinary .NET class library. Reference `rPDU2MQTT.Core`, implement `IIntegration` plus
whichever capabilities apply, and drop the DLL into the bridge's `plugins/` directory.

[HelloWorld](HelloWorld) is a complete working example in about sixty lines — a destination that writes
every reading and every energy-flow tier to a file. Copy it and change the middle.

## The project

```xml
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <Nullable>enable</Nullable>
  </PropertyGroup>
  <ItemGroup>
    <!-- Private/ExcludeAssets so you ship only your own DLL. The host already has Core loaded, and a
         plugin carrying its own copy implements an interface the runtime considers a different type. -->
    <ProjectReference Include="path/to/rPDU2MQTT.Core.csproj" Private="false" ExcludeAssets="runtime" />
  </ItemGroup>
</Project>
```

`rPDU2MQTT.Core` is the whole SDK: the contracts, the config model, the flow engine and the helpers. It
references no ASP.NET and no MQTT client, so you inherit none of them.

## The identity

```csharp
public sealed class MyPlugin : IIntegration
{
    public string Id => "influx";                            // lowercase, stable — this is your address
    public string DisplayName => "InfluxDB";                 // nav label, banner, status card
    public IntegrationGroup Group => IntegrationGroup.Destinations;
    public bool Enabled(Config cfg) => settings.Enabled;     // read live, so a GUI toggle needs no restart

    // Optional: why you cannot run as configured. A fault disables you and is reported; it never stops
    // the bridge, because nothing a toggle can do should be able to.
    public string? Misconfigured(Config cfg) => ...;
}
```

## The capabilities

Implement the ones that apply. A plugin is a vendor, not a single interface — EmonCMS is a destination
*and* a history provider *and* a configuration publisher, all on one config section.

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
    foreach (var r in pass.Readings)          // every PDU measurement, each knowing its node and instance
        Send(r.NodeId, r.Type, r.Value, r.Units);

    foreach (var t in pass.TiersFor(Tags(cfg)))   // the hierarchy, filtered by your own tag filter
        Send(t.Node.Id, t.Metric, t.Value, t.Units);

    return Task.CompletedTask;
}
```

`ExportPass` is built once per poll and handed to every destination, so you cannot be given a different
view of the world than anyone else. Throwing is how you report a bad pass: it is recorded against your id
and the other destinations still run.

Two things worth knowing:

- **Unknown is not zero.** A tier with no determined value is absent from `Tiers`, not present as `0`.
  Never fill that gap with a number.
- **`LeaderGated` defaults to true**, so exactly one process in a cluster calls you. Set it false only if
  your output is per-process — Prometheus does, because every replica serves its own `/metrics`.

## Your settings

```csharp
public sealed class MySettings
{
    [DefaultValue(false)]
    [Description("Send readings to InfluxDB.")]     // this text appears under the field in the GUI
    public bool Enabled { get; set; }

    [Description("Base URL, e.g. http://influx:8086.")]
    public string? Url { get; set; }
}

// on the plugin:
public Type ConfigType => typeof(MySettings);
public void ApplyConfig(object s) => settings = (MySettings)s;
```

That is all the UI you write. The GUI's form is generated from a schema built by reflection at startup —
not compiled into its bundle — so your settings class becomes a page with typed inputs, defaults and
descriptions.

Your settings are stored under `Plugins:` in the config file, keyed by your id:

```yaml
Plugins:
  influx:
    Enabled: true
    Url: http://influx:8086
```

## Your actions

The standard ones are derived from what you implement, so you declare nothing to get them:

| Action | Comes from |
| --- | --- |
| `probe` | `IIntegration` — always present |
| `publish`, `sweep` | `IConfigurationPublisher` |

Anything else is yours:

```csharp
public IReadOnlyList<IntegrationAction> Actions =>
[
    new("backfill", "Backfill", "Re-send the last hour.", ActionEffect.Write,
        async (ctx, ct) => new { ok = true, sent = await Backfill(ctx.Int("hours", 1), ct) }),
];
```

Every action is reachable at `POST /api/integrations/{yourId}/{action}` and gets a button on your settings
page. `ActionEffect.Destructive` makes the GUI confirm, and say what will be removed, before calling you.

You never see an `HttpContext`: query and form values arrive flattened on the context you are given.

## Supplying values, or being a device

A plugin does not have to be a destination. Two capabilities read *into* the bridge:

```csharp
// A node binds { Type: "mything", Metric: "realpower", Settings: { … } } and you supply the value.
public string SourceType => "mything";
public string SourceTypeLabel => "My Thing";

public Task ReconcileAsync(Config cfg, IReadOnlyList<SourceBinding> bindings, CancellationToken ct)
{
    // You are handed exactly your own bindings — never another type's — and called again whenever the
    // configuration changes, so a binding added in the GUI takes effect without a restart.
    foreach (var b in bindings) values[b.NodeId + "|" + b.Key()] = Read(b.Setting("Address"));
    return Task.CompletedTask;
}

public bool TryGetValue(string nodeId, string metric, out double value) => values.TryGetValue(…);
```

```csharp
// Or poll hardware. The snapshot goes where the built-in poller's does, so MQTT publishing, HA discovery,
// the flow graph and every destination work on it unchanged — none of them asks what kind of device it is.
public string InstanceId => "mydevice";
public Task<PduData?> PollAsync(Config cfg, CancellationToken ct) => …;

// Optional: switching its outlets.
public bool Supports(string action) => action is "on" or "off";
public Task<string> ControlOutletAsync(Config cfg, string deviceId, int outlet, string action, CancellationToken ct) => …;
```

Two rules that are not negotiable, because the whole hierarchy depends on them:

- **Return null, never an empty snapshot.** Null means "nothing to report" and the previous reading is left
  to go stale. An empty one reads downstream as every outlet having gone to zero — a reading nobody took.
- **Report what happened, not what was asked.** A control that echoes "on" for a command the hardware
  rejected produces an echo that contradicts the next poll, and the operator watches the outlet flip back
  with no explanation.

You never write a poll timer, a leader gate, or a lock around a shared device. The host owns all three —
including the single-owner lease that stops two replicas hammering one serial gateway.

## Installing it

```
dotnet build
cp bin/Debug/net10.0/MyPlugin.dll  <bridge>/plugins/
```

Restart the bridge. It logs `Plugin loaded: MyPlugin.dll — influx.` Set `RPDU2MQTT_PLUGINS` to load from
somewhere else.

Each plugin gets its own load context, so two plugins can depend on different versions of the same library.
A plugin that fails to load is reported and skipped — it cannot stop the bridge starting.

## What a plugin does not get

**A place in the Kubernetes CRD.** The CRD is a compile-time contract published to the API server and
cannot describe a type that exists only on your machine. Under Kubernetes your settings still work — they
live in the `Plugins` map, which the CRD leaves open — but they are not validated by it.

**Bespoke UI.** You get a generated settings page and buttons for your actions. A custom editor (the MQTT
topic picker, the Modbus register browser) is built into the GUI bundle and needs a change there.
