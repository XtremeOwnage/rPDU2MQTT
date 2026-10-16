---
title: EmonCMS
---

# EmonCMS

Generated from `rPDU2MQTT --emit-schema`. Keys are case-insensitive. `[]` marks a list item and `<name>` a map key of your choosing. A blank default means none is declared.

EmonCMS exporter

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `EmonCMS` | object |  | EmonCMS exporter |
| `EmonCMS.Enabled` | bool | `false` | Push measurements to an EmonCMS server. |
| `EmonCMS.Transport` | one of `Http`, `Mqtt` | `Http` | How to deliver measurements: Http (input/post API) or Mqtt (publish to EmonCMS's MQTT input on the same broker). |
| `EmonCMS.Url` | string |  | Base URL of the EmonCMS server, e.g. http://emoncms.example.com. (Http transport.) |
| `EmonCMS.ApiKey` | string (secret) |  | EmonCMS write API key (or set RPDU2MQTT_EMONCMS_APIKEY). (Http transport.) |
| `EmonCMS.Node` | string | `rpdu2mqtt` | EmonCMS input node name. |
| `EmonCMS.Path` | string | `input/post` | API path (relative to Url) that measurements are posted to. (Http transport.) |
| `EmonCMS.InputNameTemplate` | string | `{device}_{source}_{type}` | Template for EmonCMS input keys. Placeholders: {device}, {source} (object-id form), {name} (formatted display name), {number} (outlet number), {type}, {units}. e.g. '{device}_{source}_{type}' -> rack_pdu_1_dell_md1200_realpower. Leave blank to use the full raw identifier. |
| `EmonCMS.ExportFlowNodes` | bool | `true` | Also send each energy-flow node (panels, inverters, batteries, the grid) as its own input, not just the PDU measurements. This is what gives those nodes history to read back. |
| `EmonCMS.NodeTags` | object |  | Limit the exported energy-flow nodes to particular tags. Empty sends every node. Filtering changes only what is sent — never a value, and never any other destination. |
| `EmonCMS.NodeTags.Include` | list |  | Only send nodes carrying at least one of these tags. Empty sends every node. |
| `EmonCMS.NodeTags.Exclude` | list |  | Never send nodes carrying any of these tags. Takes precedence over Include. |
| `EmonCMS.FlowInputNameTemplate` | string | `{node}_{metric}` | Template for an energy-flow node's EmonCMS input key. Placeholders: {node} (its id), {label}, {kind}, {metric}, {units}. e.g. '{node}_{metric}' -> solar_realpower. The history reader looks feeds up by this name. |
| `EmonCMS.MqttBaseTopic` | string | `emon` | Base MQTT topic for EmonCMS's MQTT input (the {base} placeholder of MqttTopicTemplate). (Mqtt transport.) |
| `EmonCMS.MqttTopicTemplate` | string | `{base}/{node}` | Template for the EmonCMS MQTT topic each JSON payload is published to. Placeholders: {base} (MqttBaseTopic), {node}, {device} (the PDU's name). Including {device} splits the export so each PDU publishes to its own topic instead of one combined payload, e.g. '{base}/{node}/{device}'. (Mqtt transport.) |
| `EmonCMS.Feeds` | object |  | Automatically create and maintain EmonCMS feeds from the exported inputs. (Http transport; needs a read/write API key.) |
| `EmonCMS.Feeds.AutoConfigure` | bool | `false` | Create and maintain EmonCMS feeds from the exported inputs (takes effect without a restart). |
| `EmonCMS.Feeds.Types` | list |  | The supported measurement types. Each says whether it gets a feed, how that feed is named and stored, and whether EmonCMS derives it. |
| `EmonCMS.Feeds.Types[].Type` | one of `realpower`, `energy`, `energy_d`, `apparentpower`, `current`, `voltage`, `frequency`, `powerfactor` |  | The measurement type this applies to. |
| `EmonCMS.Feeds.Types[].Enabled` | bool | `true` | Build and maintain a feed for this type. |
| `EmonCMS.Feeds.Types[].Calculation` | one of `PreferLocal`, `ForceLocal`, `ForceEmonCms` | `PreferLocal` | Where this type's value comes from. |
| `EmonCMS.Feeds.Types[].Prefix` | string |  | Text placed before the feed name. Blank by default. Placeholders: {device}, {source}, {name}, {number}, {type}, {units}. |
| `EmonCMS.Feeds.Types[].Suffix` | string |  | Text placed after the feed name, which is where the type appears. Placeholders: {device}, {source}, {name}, {number}, {type}, {units}. |
| `EmonCMS.Feeds.Types[].Units` | string |  | The unit this feed is stored in. |
| `EmonCMS.Feeds.Types[].Engine` | one of `MySQL`, `PHPTimeSeries`, `PHPFina`, `VirtualFeed` |  | Feed storage engine for this type. Blank inherits Feeds.Engine. PHPFina = fixed-interval, PHPTimeSeries = variable, MySQL = MySQL storage. |
| `EmonCMS.Feeds.Types[].IntervalSeconds` | int | `10` | Sample interval in seconds for this type's feed. Range 1–86400. |
| `EmonCMS.Feeds.Engine` | one of `MySQL`, `PHPTimeSeries`, `PHPFina`, `VirtualFeed` | `PHPFina` | Default feed storage engine, for types that don't set their own. PHPFina = fixed-interval time series, PHPTimeSeries = variable interval, MySQL = MySQL storage (no phpfina files). |
| `EmonCMS.Feeds.IntervalSeconds` | int | `10` | Default sample interval in seconds for a fixed-interval feed, for types that don't set their own. Range 1–86400. |
| `EmonCMS.Feeds.Tag` | string |  | The EmonCMS tag (group) new feeds are filed under. Blank uses the input node name. |
| `EmonCMS.Feeds.StorageNameTemplate` | string | `{device}_{source}` | Template for the storage-feed name, without the type — each type appends its own suffix. Use only stable placeholders ({device}, {source}, {number}) so the name never changes on a rename. Placeholders: {device}, {source}, {name}, {number}, {units}. |
| `EmonCMS.Feeds.Virtual` | object |  | Optionally create friendly-named virtual feeds that source from the stable storage feeds — so dashboards get nice names while the underlying feeds stay idempotent. |
| `EmonCMS.Feeds.Virtual.Enabled` | bool | `false` | Create a friendly-named virtual feed for each storage feed, sourced from it (source_feed process). |
| `EmonCMS.Feeds.Virtual.NameTemplate` | string | `{name} {type}` | Template for the friendly virtual-feed name. {name} is the source's display name, so these can change freely without touching the stable storage feeds. Placeholders: {device}, {source}, {name}, {number}, {type}, {units}. |
| `EmonCMS.Feeds.Virtual.Tag` | string |  | The EmonCMS tag (group/node) virtual feeds are filed under — set this to keep the friendly virtual feeds separate from the storage feeds. Blank uses the main Feeds tag. |
| `EmonCMS.Source` | object |  | Read EmonCMS feeds back as live values for energy-flow nodes (bind a node's source with Type 'emoncms'). |
| `EmonCMS.Source.PollIntervalSeconds` | int | `30` | How often to read the bound feeds' current values, in seconds. One request per poll however many feeds are bound. Range 5–3600. |
