---
title: Energy Flow
---

# Energy Flow

Generated from `rPDU2MQTT --emit-schema`. Keys are case-insensitive. `[]` marks a list item and `<name>` a map key of your choosing. A blank default means none is declared.

Virtual upstream nodes (breakers, transfer switches, a “Total”) and their feeder wiring for the energy-flow hierarchy. Edited visually on the Flow tab.

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `EnergyFlow` | object |  | Virtual upstream nodes (breakers, transfer switches, a “Total”) and their feeder wiring for the energy-flow hierarchy. Edited visually on the Flow tab. |
| `EnergyFlow.Aggregation` | object |  | Accumulate energy (kWh) from the power readings, for nodes that report power but not energy. |
| `EnergyFlow.Aggregation.Enabled` | bool | `false` | Derive energy (kWh) by integrating each node's power over time. A real energy source on a node always takes precedence. |
| `EnergyFlow.Aggregation.SampleIntervalSeconds` | int | `10` | How often to sample power, in seconds. Shorter samples track a spiky load more closely. |
| `EnergyFlow.Aggregation.MaxGapSeconds` | int | `60` | Longest gap between samples that still counts, in seconds. A longer gap is recorded as unmeasured rather than guessed. |
| `EnergyFlow.Aggregation.TrackPeriods` | bool | `true` | Track a daily energy total per node and outlet, so the flow diagram compares figures that all start at the same moment. Lifetime totals are unaffected. |
| `EnergyFlow.Aggregation.PeriodTimeZone` | one of 419 values, e.g. `Africa/Abidjan`, `Africa/Accra`, `Africa/Addis_Ababa` |  | IANA time zone the daily total rolls over in, e.g. "America/Chicago". Blank uses the host's local time zone — which in a container is usually UTC. |
| `EnergyFlow.Aggregation.PeriodStartHour` | int | `0` | Hour of the day the daily total rolls over, in the period time zone. 0 = midnight. Range 0–23. |
| `EnergyFlow.Nodes` | list |  | Custom upstream flow nodes (breakers, transfer-switch outputs, Total, ...), keyed by a stable id. |
| `EnergyFlow.Nodes[].Id` | string |  | Stable unique id used to wire parents/children. |
| `EnergyFlow.Nodes[].Label` | string |  | Human-readable label shown in the flow diagram. |
| `EnergyFlow.Nodes[].Kind` | one of `node`, `panel`, `breaker`, `inverter`, `battery`, `solar`, `grid`, `load` | `node` | What this node represents: 'node' (generic), 'panel', 'breaker' (a circuit that feeds other nodes), 'inverter', 'battery', 'solar', 'grid', or 'load' (where power is used, so it feeds nothing). Drives styling and the fields the editor offers. |
| `EnergyFlow.Nodes[].Value` | double |  | Optional fixed value for a leaf node. Used only when no live source has reported for it. |
| `EnergyFlow.Nodes[].Max` | double |  | Full-scale value for this node's gauge, in the metric's canonical unit (W for power). For example a PV array's peak output. Leave blank to show the plain reading instead — no ceiling is ever guessed. |
| `EnergyFlow.Nodes[].Tags` | list |  | Free-form tags for filtering the diagram and the energy views — e.g. 'critical', 'rack-1', 'upstairs'. A tag never changes a reading, only what a view shows. |
| `EnergyFlow.Nodes[].Location` | string |  | The id of the room, area, floor or site this node is in. Its own consumption counts toward that place. |
| `EnergyFlow.Nodes[].Circuit` | string |  | The circuit this node is plugged into, as the panel id and breaker number: 'main_panel/B06'. A circuit then shows it among its metered devices and reports what is left unmetered. |
| `EnergyFlow.Nodes[].Hidden` | bool | `false` | Left off the flow diagrams. Still listed and editable. |
| `EnergyFlow.Nodes[].EmonCmsTag` | string |  | EmonCMS tag this node's feeds are filed under. Blank uses EmonCMS.Feeds.Tag. Placeholders: {node}, {label}, {kind}. |
| `EnergyFlow.Nodes[].EmonCmsVirtualTag` | string |  | EmonCMS tag this node's virtual feeds are filed under. Blank uses EmonCMS.Feeds.Virtual.Tag. Placeholders: {node}, {label}, {kind}. |
| `EnergyFlow.Nodes[].StorageKwh` | double |  | For a battery node: usable storage capacity in kWh (display metadata; optional). |
| `EnergyFlow.Nodes[].Mode` | one of `auto`, `static`, `residual`, `untracked`, `none` | `auto` | How to value this node when it has no direct measurement: 'auto' (aggregate children; carries unmet demand only when it is the single path into a node — never splits a load between several unmeasured feeders), 'static' (a fixed leaf at Value), 'residual' (the designated absorber of what its target still needs — this is how you say where unaccounted power comes from), 'untracked' (show a measured parent's unaccounted consumption), or 'none' (never inferred). A live source always wins. |
| `EnergyFlow.Nodes[].Sources` | list |  | Live value bindings for this node, one per metric. Each binds a metric to an external source (Type 'mqtt' today). Supersedes Value. |
| `EnergyFlow.Nodes[].Sources[].Type` | one of `mqtt`, `modbus`, `emoncms`, `homeassistant`, `derived` | `mqtt` | Where this value comes from: 'mqtt' (subscribe to a broker topic), 'modbus' (read a register from a Modbus TCP connection), 'emoncms' (read an EmonCMS feed's current value), 'homeassistant' (read an entity's state), or 'derived' (work it out from this node's other readings — current as power ÷ voltage, for a meter that reports watts and volts but no amps). |
| `EnergyFlow.Nodes[].Sources[].Metric` | one of `realpower`, `apparentpower`, `energy`, `current`, `voltage`, `frequency`, `powerfactor`, `soc`, `percent`, `temperature` | `realpower` | Which measurement this source supplies. The power, energy and current of a node are rolled up through the hierarchy; the rest — voltage, frequency, power factor, state of charge, any other percentage, temperature — are read at the node and shown, never summed. |
| `EnergyFlow.Nodes[].Sources[].Accumulation` | one of `lifetime`, `period` | `lifetime` | Whether this counter runs forever or restarts each day: 'lifetime' (default — a cumulative total whose rise is measured) or 'period' (the device resets it daily, so the reading already is today's total). Only meaningful for energy. Check the topic before choosing: a publisher can offer both kinds, and firmware changes which. A daily counter tagged 'lifetime' is read as a meter running backwards every midnight and stops being published; a lifetime counter tagged 'period' is republished every poll as if that whole total were today's. |
| `EnergyFlow.Nodes[].Sources[].Direction` | one of `out`, `in`, `split` | `out` | Which way energy flows for this source, relative to the node: 'out' (default — battery discharge, grid import, solar production), 'in' (battery charge, grid export), or 'split' — one signed value fanned into both directions, positive as out and the magnitude of negative as in (for a single ± power/current topic or register). Only meaningful for directional metrics (realpower, apparentpower, current, energy); ignored for voltage/frequency/powerfactor/soc. |
| `EnergyFlow.Nodes[].Sources[].Unit` | string |  | Unit the source publishes in (e.g. kW, Wh, mV). Converted to the metric's canonical unit (W, kWh, V, …) on ingest. Blank = already canonical. |
| `EnergyFlow.Nodes[].Sources[].Topic` | string |  | For Type 'mqtt': the topic carrying this value, e.g. 'solar_assistant/inverter_1/pv_power/state'. Subscribed on the configured broker. |
| `EnergyFlow.Nodes[].Sources[].JsonField` | string |  | For JSON payloads, the field to read (dotted for nesting, e.g. 'battery.power'). Blank = the whole payload is the number. |
| `EnergyFlow.Nodes[].Sources[].Scale` | double | `1` | Multiplier applied to the received value — for unit conversion, e.g. 0.001 to turn W into kW, or -1 to flip a sign convention. |
| `EnergyFlow.Nodes[].Sources[].StaleAfterSeconds` | int | `900` | Ignore the last value once it is this old, so a dead publisher stops silently propping up the flow. 0 disables the check (value never expires). Range 0–86400. |
| `EnergyFlow.Nodes[].Sources[].Connection` | string |  | For Type 'modbus': the id of the Modbus connection (from the Modbus section) to read from. |
| `EnergyFlow.Nodes[].Sources[].Register` | int |  | For Type 'modbus': the register address to read (0-based). |
| `EnergyFlow.Nodes[].Sources[].RegisterType` | one of `holding`, `input` | `holding` | For Type 'modbus': which register bank — 'holding' (function 3) or 'input' (function 4). |
| `EnergyFlow.Nodes[].Sources[].DataType` | one of `uint16`, `int16`, `uint32`, `int32`, `float32` | `uint16` | For Type 'modbus': how to decode the register(s) — uint16, int16, uint32, int32, or float32. |
| `EnergyFlow.Nodes[].Sources[].WordOrder` | one of `big`, `little` | `big` | For Type 'modbus' 32-bit values: word order — 'big' (ABCD, high word first) or 'little' (CDAB, word-swapped). |
| `EnergyFlow.Nodes[].Sources[].Feed` | string |  | For Type 'emoncms': the feed to read — its numeric id (e.g. 945), or its name (e.g. '1_power'). Qualify a name with its tag as 'tag/name' when the same name exists under several tags. |
| `EnergyFlow.Nodes[].Sources[].Settings` | map |  | Extra settings for a plugin-supplied source type. The built-in mqtt and modbus types use the fields above instead. |
| `EnergyFlow.Nodes[].Mqtt` | list |  | Deprecated: use Sources. Legacy MQTT bindings (implicitly Type 'mqtt'); still honored for back-compat. |
| `EnergyFlow.Nodes[].Mqtt[].Type` | one of `mqtt`, `modbus`, `emoncms`, `homeassistant`, `derived` | `mqtt` | Where this value comes from: 'mqtt' (subscribe to a broker topic), 'modbus' (read a register from a Modbus TCP connection), 'emoncms' (read an EmonCMS feed's current value), 'homeassistant' (read an entity's state), or 'derived' (work it out from this node's other readings — current as power ÷ voltage, for a meter that reports watts and volts but no amps). |
| `EnergyFlow.Nodes[].Mqtt[].Metric` | one of `realpower`, `apparentpower`, `energy`, `current`, `voltage`, `frequency`, `powerfactor`, `soc`, `percent`, `temperature` | `realpower` | Which measurement this source supplies. The power, energy and current of a node are rolled up through the hierarchy; the rest — voltage, frequency, power factor, state of charge, any other percentage, temperature — are read at the node and shown, never summed. |
| `EnergyFlow.Nodes[].Mqtt[].Accumulation` | one of `lifetime`, `period` | `lifetime` | Whether this counter runs forever or restarts each day: 'lifetime' (default — a cumulative total whose rise is measured) or 'period' (the device resets it daily, so the reading already is today's total). Only meaningful for energy. Check the topic before choosing: a publisher can offer both kinds, and firmware changes which. A daily counter tagged 'lifetime' is read as a meter running backwards every midnight and stops being published; a lifetime counter tagged 'period' is republished every poll as if that whole total were today's. |
| `EnergyFlow.Nodes[].Mqtt[].Direction` | one of `out`, `in`, `split` | `out` | Which way energy flows for this source, relative to the node: 'out' (default — battery discharge, grid import, solar production), 'in' (battery charge, grid export), or 'split' — one signed value fanned into both directions, positive as out and the magnitude of negative as in (for a single ± power/current topic or register). Only meaningful for directional metrics (realpower, apparentpower, current, energy); ignored for voltage/frequency/powerfactor/soc. |
| `EnergyFlow.Nodes[].Mqtt[].Unit` | string |  | Unit the source publishes in (e.g. kW, Wh, mV). Converted to the metric's canonical unit (W, kWh, V, …) on ingest. Blank = already canonical. |
| `EnergyFlow.Nodes[].Mqtt[].Topic` | string |  | For Type 'mqtt': the topic carrying this value, e.g. 'solar_assistant/inverter_1/pv_power/state'. Subscribed on the configured broker. |
| `EnergyFlow.Nodes[].Mqtt[].JsonField` | string |  | For JSON payloads, the field to read (dotted for nesting, e.g. 'battery.power'). Blank = the whole payload is the number. |
| `EnergyFlow.Nodes[].Mqtt[].Scale` | double | `1` | Multiplier applied to the received value — for unit conversion, e.g. 0.001 to turn W into kW, or -1 to flip a sign convention. |
| `EnergyFlow.Nodes[].Mqtt[].StaleAfterSeconds` | int | `900` | Ignore the last value once it is this old, so a dead publisher stops silently propping up the flow. 0 disables the check (value never expires). Range 0–86400. |
| `EnergyFlow.Nodes[].Mqtt[].Connection` | string |  | For Type 'modbus': the id of the Modbus connection (from the Modbus section) to read from. |
| `EnergyFlow.Nodes[].Mqtt[].Register` | int |  | For Type 'modbus': the register address to read (0-based). |
| `EnergyFlow.Nodes[].Mqtt[].RegisterType` | one of `holding`, `input` | `holding` | For Type 'modbus': which register bank — 'holding' (function 3) or 'input' (function 4). |
| `EnergyFlow.Nodes[].Mqtt[].DataType` | one of `uint16`, `int16`, `uint32`, `int32`, `float32` | `uint16` | For Type 'modbus': how to decode the register(s) — uint16, int16, uint32, int32, or float32. |
| `EnergyFlow.Nodes[].Mqtt[].WordOrder` | one of `big`, `little` | `big` | For Type 'modbus' 32-bit values: word order — 'big' (ABCD, high word first) or 'little' (CDAB, word-swapped). |
| `EnergyFlow.Nodes[].Mqtt[].Feed` | string |  | For Type 'emoncms': the feed to read — its numeric id (e.g. 945), or its name (e.g. '1_power'). Qualify a name with its tag as 'tag/name' when the same name exists under several tags. |
| `EnergyFlow.Nodes[].Mqtt[].Settings` | map |  | Extra settings for a plugin-supplied source type. The built-in mqtt and modbus types use the fields above instead. |
| `EnergyFlow.Links` | list |  | Directed energy-flow links (From feeds To). Allows multiple feeders per node and producer inputs. |
| `EnergyFlow.Links[].From` | string |  | Source node id — energy flows out of here. |
| `EnergyFlow.Links[].To` | string |  | Target node id — energy flows into here. |
| `EnergyFlow.AutoTags` | list |  | Tags for derived nodes (PDUs and outlets), which have no entry of their own to carry them. Matched by node id with '*' as a wildcard, e.g. 'outlet:rack_pdu_1:*'. |
| `EnergyFlow.AutoTags[].Match` | string |  | Node id to match, with '*' matching any run of characters. e.g. 'outlet:rack_pdu_1:*' for every outlet on that PDU, 'pdu:*' for every PDU, or a single outlet's full id. |
| `EnergyFlow.AutoTags[].Tags` | list |  | Tags to apply to every node the pattern matches. A tag never changes a reading — only what a view shows and what the exports may carry. |
| `EnergyFlow.Tags` | list |  | Tags declared up front, each with what it is for. Optional — a tag typed onto a node works without being declared. Declaring one lets it exist before anything carries it, and gives it a description. |
| `EnergyFlow.Tags[].Name` | string |  | The tag itself, as it is written on a node, a rule or a destination filter. |
| `EnergyFlow.Tags[].Description` | string |  | What this tag is for, in your own words. Shown wherever the tag is listed. |
| `EnergyFlow.Groups` | list |  | Named groups of nodes shown as one collapsible node on the flow graphs (e.g. three MPPTs as one 'Incoming PV'). Members keep their own links/exports; the group also exports its summed total. |
| `EnergyFlow.Groups[].Id` | string |  | Stable unique id for the group (used in the group's exported topic/metric). |
| `EnergyFlow.Groups[].Label` | string |  | Human-readable label shown on the flow diagram when the group is collapsed. |
| `EnergyFlow.Groups[].Kind` | one of `node`, `panel`, `breaker`, `inverter`, `battery`, `solar`, `grid`, `load` | `node` | What the group represents, for diagram styling: 'node', 'panel', 'breaker', 'inverter', 'battery', 'solar', 'grid', or 'load'. |
| `EnergyFlow.Groups[].Members` | list |  | The ids of the member nodes this group aggregates. |
| `EnergyFlow.Groups[].Parent` | string |  | Id of the group this group is nested in. It shows only while that group is expanded. |
| `EnergyFlow.Groups[].Expand` | one of `replace`, `parents`, `children` | `replace` | How the group draws when expanded: 'replace' shows its members in place of the group node, 'parents' draws the members feeding the group node, 'children' draws the group node feeding its members. |
| `EnergyFlow.Groups[].ExpandChildren` | bool | `false` | Expanding this group also expands every group nested in it. |
| `EnergyFlow.Balance` | object |  | Which nodes make up the site's Solar, Grid, Battery and Home totals on the energy pages, Trends and the Home Assistant Energy Dashboard. Each list is summed. Leave every list empty to total nodes by their kind instead. |
| `EnergyFlow.Balance.Solar` | list |  | Nodes whose output is solar production — a PV total, never the strings it is made of. |
| `EnergyFlow.Balance.Grid` | list |  | Nodes metering the grid connection: import out, export in. |
| `EnergyFlow.Balance.Battery` | list |  | Nodes metering battery banks: discharge out, charge in. |
| `EnergyFlow.Balance.Home` | list |  | Nodes whose reading is what the home used — an inverter's load output, a whole-house meter. Empty works it out from the other three. |
| `EnergyFlow.Panels` | list |  | Electrical panels and the breakers in their slots: breaker number, rating, wire label and what each one feeds, including the circuits nobody has identified yet. |
| `EnergyFlow.Panels[].Id` | string |  | Stable unique id for this panel, used to refer to it from elsewhere. For example 'main_panel'. |
| `EnergyFlow.Panels[].Name` | string |  | Human-readable name shown on the panel schedule. For example 'Main Panel'. |
| `EnergyFlow.Panels[].Slots` | int | `42` | How many breaker positions the panel has, counting both columns. A 42-space panel has 42. Odd numbers fill the left column; even numbers the right, as they are stamped in the panel. Range 2–200. |
| `EnergyFlow.Panels[].Node` | string |  | The energy-flow node that is this panel. Its reading is the power coming into the panel, and a circuit mapped to one of these breakers is placed beneath it. |
| `EnergyFlow.Panels[].Location` | string |  | The id of the room, area or floor the panel is mounted in. |
| `EnergyFlow.Panels[].Breakers` | list |  | The breakers in this panel's slots. |
| `EnergyFlow.Panels[].Breakers[].Slot` | int |  | Which slot the breaker is in, numbered as the panel is: odd down the left column, even down the right. Range 1–200. |
| `EnergyFlow.Panels[].Breakers[].Number` | string |  | The breaker number as written in the directory. Usually the slot number; a tandem half is written like '26.1'. |
| `EnergyFlow.Panels[].Breakers[].Poles` | int | `1` | 1 for a single-pole breaker, 2 for a double-pole. A double-pole also occupies the next slot in the same column (slot + 2). Range 1–2. |
| `EnergyFlow.Panels[].Breakers[].Half` | int |  | For a tandem breaker, which half of the slot this is: 1 for the upper, 2 for the lower. Leave blank when the breaker has the whole slot. Range 1–2. |
| `EnergyFlow.Panels[].Breakers[].Amps` | int |  | The breaker's rating in amps, as stamped on its handle. Range 1–1000. |
| `EnergyFlow.Panels[].Breakers[].Wire` | string |  | The label on the wire leaving this breaker, for example 'W11'. What the wire carries is mapped separately. |
| `EnergyFlow.Panels[].Breakers[].Description` | string |  | What this breaker feeds, in the words the directory uses. For example 'Lights, Garage, Kitchen'. |
| `EnergyFlow.Panels[].Breakers[].Gauge` | string |  | The wire's gauge, as written on the cable — for example '12 AWG THWN' or '6 AWG'. Free text: the rating that matters is the breaker's, and the gauge is what says whether the wire can carry it. |
| `EnergyFlow.Panels[].Breakers[].Conductor` | one of `copper`, `aluminium` |  | What the wire is made of. Aluminium carries less for the same gauge, so a run sized in copper is not the same run in aluminium. |
| `EnergyFlow.Panels[].Breakers[].Rooms` | list |  | The ids of the rooms and areas this breaker's circuit serves. A circuit serving several rooms lists each; its power then counts toward the smallest place holding all of them. |
| `EnergyFlow.Panels[].Breakers[].Node` | string |  | The energy-flow node that is this circuit. Blank uses the channel measuring it, when a single channel does. |
| `EnergyFlow.Panels[].Breakers[].State` | one of `identified`, `unknown`, `unused` | `unknown` | Whether this breaker is identified, not yet identified (the '????' rows of a paper directory), or an unused slot. A new breaker starts unknown, so a blank row claims nothing. |
| `EnergyFlow.Clamps` | list |  | CT clamps: which breaker's wire each one is on, the monitor channel it is plugged into, its rating, and whether it is on backwards. |
| `EnergyFlow.Clamps[].Label` | string |  | The label written on the clamp, if it has one. Used to refer to this clamp from elsewhere. |
| `EnergyFlow.Clamps[].Amps` | int |  | The clamp's rating in amps, as printed on it. For example 50 or 100. Range 1–1000. |
| `EnergyFlow.Clamps[].Panel` | string |  | The id of the panel holding the breaker this clamp measures. |
| `EnergyFlow.Clamps[].Breaker` | string |  | The breaker number this clamp measures, as written in the directory. A tandem half is written like '26.1'. |
| `EnergyFlow.Clamps[].Leg` | int | `1` | Which leg of the breaker this clamp is on: 1 for a single-pole breaker, 1 or 2 for the two poles of a double-pole. Both legs need a clamp before the breaker's power is known. Range 1–2. |
| `EnergyFlow.Clamps[].Wire` | string |  | The label on the wire this clamp sits on, for example 'W11'. Blank means the breaker's own wire. |
| `EnergyFlow.Clamps[].Channel` | string |  | The monitor channel this clamp is plugged into, given as the node id the bridge already reads — for example 'n30_1_5'. |
| `EnergyFlow.Clamps[].Whole` | bool | `false` | Tick when this single clamp measures the whole breaker rather than one leg — one CT on a 240 V circuit, where the monitor already accounts for both legs. Without it, a double-pole breaker needs a clamp on each leg before its power is known. |
| `EnergyFlow.Clamps[].Reversed` | bool | `false` | Tick when the clamp is on the wire backwards, so it reads negative. Its reading is flipped rather than taken as a negative load. |
| `EnergyFlow.Sites` | list |  | Where things are: sites, their floors, and the rooms and areas on each floor. Energy rolls up room → floor → site alongside the electrical hierarchy. |
| `EnergyFlow.Sites[].Id` | string |  | Stable unique id for this site, used to refer to it from elsewhere. For example 'home'. Ids are shared by sites, floors, rooms and areas, so each must be unique across all of them. |
| `EnergyFlow.Sites[].Name` | string |  | Human-readable name, for example 'Home'. |
| `EnergyFlow.Sites[].Floors` | list |  | The floors of this site. |
| `EnergyFlow.Sites[].Floors[].Id` | string |  | Stable unique id for this floor, for example 'ground'. |
| `EnergyFlow.Sites[].Floors[].Name` | string |  | Human-readable name, for example 'Ground floor'. |
| `EnergyFlow.Sites[].Floors[].Level` | int | `0` | Where this floor sits in the building: 0 for the ground floor, 1 for the one above, -1 for a basement. Floors are listed in this order. |
| `EnergyFlow.Sites[].Floors[].Image` | string |  | The id of the uploaded floor plan image drawn behind this floor. Images are kept in plan storage, never in the configuration. Blank shows a grid. |
| `EnergyFlow.Sites[].Floors[].Width` | double | `1000` | Width of the plan in drawing units. Room outlines are given in these units, with 0,0 at the top left. Set from the image's proportions when one is uploaded. Range 100–100000. |
| `EnergyFlow.Sites[].Floors[].Height` | double | `700` | Height of the plan in drawing units. Range 100–100000. |
| `EnergyFlow.Sites[].Floors[].Scale` | double | `100` | Drawing units per metre. 100 makes one unit a centimetre. Set it by measuring a known distance on the plan, so room sizes read in feet or metres. Range 1–100000. |
| `EnergyFlow.Sites[].Floors[].ImageOpacity` | double | `0.85` | How strongly the plan image shows behind the drawing, from 0 (hidden) to 1. |
| `EnergyFlow.Sites[].Floors[].Ground` | one of `grass`, `concrete`, `gravel`, `dirt`, `pavers`, `snow` |  | What the ground around the rooms looks like: grass, concrete, gravel, dirt, pavers or snow. Blank is plain paper. |
| `EnergyFlow.Sites[].Floors[].Rooms` | list |  | The rooms on this floor. |
| `EnergyFlow.Sites[].Floors[].Rooms[].Id` | string |  | Stable unique id for this room, for example 'kitchen'. |
| `EnergyFlow.Sites[].Floors[].Rooms[].Name` | string |  | Human-readable name, for example 'Kitchen'. Also the name of its Home Assistant area. |
| `EnergyFlow.Sites[].Floors[].Rooms[].Shape` | list |  | The room's outline on the plan, as points in drawing units. Empty until the room is drawn. |
| `EnergyFlow.Sites[].Floors[].Rooms[].Shape[].X` | double |  |  |
| `EnergyFlow.Sites[].Floors[].Rooms[].Shape[].Y` | double |  |  |
| `EnergyFlow.Sites[].Floors[].Rooms[].Outdoor` | bool | `false` | An outdoor zone rather than a room: a yard, porch, patio, driveway or deck. Drawn as ground, not walls. |
| `EnergyFlow.Sites[].Floors[].Rooms[].Surface` | one of `wood`, `tile`, `carpet`, `concrete`, `stone`, `grass`, `gravel`, `dirt`, `deck`, `pavers`, `water`, `snow`, `stairs` |  | The floor or ground inside it: wood, tile, carpet, concrete, stone, grass, gravel, dirt, deck, pavers, water, snow, or stairs for a stairwell. Blank is plain. |
| `EnergyFlow.Sites[].Floors[].Rooms[].SurfaceColor` | string |  | The surface's colour, like #7a5c3e: the carpet, the tile, the paint. Blank uses the surface's own. With a plain surface it fills the room. |
| `EnergyFlow.Sites[].Floors[].Rooms[].Locked` | bool | `false` | Lock the room: it cannot be moved, reshaped or deleted until it is unlocked. |
| `EnergyFlow.Sites[].Floors[].Rooms[].LockedWalls` | list |  | Walls that are locked in place, by number: wall n runs from corner n to the next. |
| `EnergyFlow.Sites[].Floors[].Rooms[].HaArea` | string |  | The Home Assistant area this room was linked to, by area id. Written when rooms are published to Home Assistant, so a rename updates the same area. |
| `EnergyFlow.Sites[].Floors[].Areas` | list |  | Areas on this floor. An area can span several rooms, such as 'upstairs' or 'server corner', and may overlap them. |
| `EnergyFlow.Sites[].Floors[].Areas[].Id` | string |  | Stable unique id for this area, for example 'server_corner'. |
| `EnergyFlow.Sites[].Floors[].Areas[].Name` | string |  | Human-readable name, for example 'Server corner'. |
| `EnergyFlow.Sites[].Floors[].Areas[].Rooms` | list |  | The ids of the rooms this area takes in. Everything in those rooms counts toward the area as well. |
| `EnergyFlow.Sites[].Floors[].Areas[].Shape` | list |  | The area's outline on the plan, as points in drawing units. Optional: an area made of whole rooms needs no outline of its own. |
| `EnergyFlow.Sites[].Floors[].Areas[].Shape[].X` | double |  |  |
| `EnergyFlow.Sites[].Floors[].Areas[].Shape[].Y` | double |  |  |
| `EnergyFlow.Sites[].Floors[].Areas[].Locked` | bool | `false` | Lock the area's outline: it cannot be moved, reshaped or deleted until it is unlocked. |
| `EnergyFlow.Sites[].Floors[].Openings` | list |  | Doors, windows and openings in the walls on this floor. |
| `EnergyFlow.Sites[].Floors[].Openings[].Id` | string |  | Stable unique id for this opening. |
| `EnergyFlow.Sites[].Floors[].Openings[].Kind` | one of `door`, `double-door`, `sliding-door`, `garage-door`, `window`, `opening` | `door` | A door, double door, sliding door, garage door, window, or a plain opening. |
| `EnergyFlow.Sites[].Floors[].Openings[].X` | double |  | Centre of the opening across the plan, in drawing units. |
| `EnergyFlow.Sites[].Floors[].Openings[].Y` | double |  | Centre of the opening down the plan, in drawing units. |
| `EnergyFlow.Sites[].Floors[].Openings[].Angle` | double |  | The direction of the wall it sits in, in degrees clockwise from pointing right. |
| `EnergyFlow.Sites[].Floors[].Openings[].Width` | double |  | How wide the opening is, in drawing units. |
| `EnergyFlow.Sites[].Floors[].Openings[].Swing` | one of `left`, `right` | `left` | Which end of a door the hinges are at. |
| `EnergyFlow.Sites[].Floors[].Openings[].Flip` | bool | `false` | Swing the door to the other side of the wall. |
| `EnergyFlow.Sites[].Floors[].Constraints` | list |  | Geometric constraints between the corners and walls of this floor's rooms and areas: coincident, colinear, parallel, perpendicular, horizontal, vertical, a fixed angle or a fixed length. Kept as the plan is edited. |
| `EnergyFlow.Sites[].Floors[].Constraints[].Id` | string |  | Stable unique id for this constraint. |
| `EnergyFlow.Sites[].Floors[].Constraints[].Kind` | one of `coincident`, `colinear`, `parallel`, `perpendicular`, `horizontal`, `vertical`, `angle`, `length` |  | Coincident (two corners), colinear, parallel or perpendicular (two walls), horizontal or vertical (a wall), angle (a corner) or length (a wall). |
| `EnergyFlow.Sites[].Floors[].Constraints[].Refs` | list |  | The corners or walls it holds, each a room or area id with a corner or wall number counted from 0. |
| `EnergyFlow.Sites[].Floors[].Constraints[].Refs[].Room` | string |  | The id of the room or area. |
| `EnergyFlow.Sites[].Floors[].Constraints[].Refs[].Corner` | int |  | The corner, counted from 0 in the outline. Blank when this refers to a wall. |
| `EnergyFlow.Sites[].Floors[].Constraints[].Refs[].Edge` | int |  | The wall, counted from 0: wall n runs from corner n to the next. Blank when this refers to a corner. |
| `EnergyFlow.Sites[].Floors[].Constraints[].Value` | double |  | For a length, in drawing units; for an angle, in degrees, signed the way the outline turns at that corner. |
| `EnergyFlow.Placements` | list |  | Outlets, switches, fixtures, appliances and devices placed on the floor plans, each with its room and the circuit feeding it. |
| `EnergyFlow.Placements[].Id` | string |  | Stable unique id for this item. |
| `EnergyFlow.Placements[].Kind` | one of `outlet`, `switch`, `fixture`, `appliance`, `device`, `fan`, `hvac`, `ev-charger`, `junction`, `panel`, `meter`, `pole`, `transformer`, `solar`, `battery`, `inverter`, `generator` | `outlet` | What this is: an outlet, switch, light fixture, fan, appliance, device, HVAC unit, EV charger, junction box, electrical panel, utility meter, utility pole, transformer, solar array, battery, inverter or generator. |
| `EnergyFlow.Placements[].Label` | string |  | What it is called, for example 'Fridge' or 'Desk outlet'. |
| `EnergyFlow.Placements[].Room` | string |  | The id of the room or outdoor zone it is in. Blank when it is outdoors, or anywhere not drawn as a room. |
| `EnergyFlow.Placements[].Floor` | string |  | The id of the floor it is drawn on. Needed for anything outside every room. |
| `EnergyFlow.Placements[].Width` | double |  | For an item drawn at its real size — a washer, a fridge, an AC condenser — its width, in drawing units. Blank draws it as an icon. |
| `EnergyFlow.Placements[].Depth` | double |  | Its depth, front to back, in drawing units. |
| `EnergyFlow.Placements[].Rotation` | double |  | How far it is turned, in degrees clockwise. Its front faces down the plan at 0. |
| `EnergyFlow.Placements[].Footprint` | string |  | What appliance it is drawn as, seen from above: washer, dryer, fridge, freezer, range, dishwasher, water-heater, furnace, condenser, rack or hot-tub. Blank draws a plain box. |
| `EnergyFlow.Placements[].Round` | bool | `false` | Drawn round rather than square, such as a water heater; Width is its diameter. |
| `EnergyFlow.Placements[].Gfci` | bool | `false` | A GFCI outlet: everything wired downstream of it, from its load terminals, is protected by it. |
| `EnergyFlow.Placements[].Facing` | double |  | For an item mounted on a wall, the direction it faces into its room, in degrees clockwise from pointing right. Blank when it stands free. |
| `EnergyFlow.Placements[].Panel` | string |  | For an electrical panel placed on the plan, the id of the panel in the panel schedule. |
| `EnergyFlow.Placements[].X` | double |  | Where it is on the floor plan, across, in drawing units. |
| `EnergyFlow.Placements[].Y` | double |  | Where it is on the floor plan, down, in drawing units. |
| `EnergyFlow.Placements[].Circuit` | string |  | The circuit feeding it, as the panel id and breaker number: 'main_panel/B06'. Blank when nobody knows which breaker it is on. |
| `EnergyFlow.Placements[].Node` | string |  | The energy-flow node metering it, when it is individually metered — a smart plug, an ESPHome sensor, a PDU outlet. |
| `EnergyFlow.Runs` | list |  | Cable runs drawn on the floor plans: branch circuits, feeders and the utility service, each between placed items. |
| `EnergyFlow.Runs[].Id` | string |  | Stable unique id for this run. |
| `EnergyFlow.Runs[].Kind` | one of `circuit`, `feeder`, `service` | `circuit` | A branch circuit, a feeder between panels, or the utility service. |
| `EnergyFlow.Runs[].Floor` | string |  | The id of the floor it is drawn on. |
| `EnergyFlow.Runs[].Circuit` | string |  | The circuit it carries, as the panel id and breaker number: 'main_panel/B06'. Blank when it is not known. |
| `EnergyFlow.Runs[].From` | string |  | The placed item it starts at, on the supply side: runs are drawn from the panel outward, so what is downstream of an item is what its runs lead to. Blank when it starts at a bare point. |
| `EnergyFlow.Runs[].To` | string |  | The placed item it ends at. Blank when it ends at a bare point. |
| `EnergyFlow.Runs[].Points` | list |  | The path between its ends, in drawing units: bends and, where an end is not an item, the end itself. |
| `EnergyFlow.Runs[].Points[].X` | double |  |  |
| `EnergyFlow.Runs[].Points[].Y` | double |  |  |
| `EnergyFlow.Runs[].Label` | string |  | A note on the run, for example 'through the attic'. |
| `EnergyFlow.AutoLocations` | list |  | Locations for derived nodes (PDUs and outlets), which have no entry of their own. Matched by node id with '*' as a wildcard; the first match wins, and an exact id beats a pattern. |
| `EnergyFlow.AutoLocations[].Match` | string |  | Node id to match, with '*' matching any run of characters. For example 'outlet:rack_pdu_1:*' for every outlet on that PDU. |
| `EnergyFlow.AutoLocations[].Location` | string |  | The id of the room, area, floor or site the matching nodes are in. |
| `EnergyFlow.Parents` | map |  | Legacy single-feeder map (child id -> parent id). Prefer Links; still honored for back-compat. |
| `EnergyFlow.InferFromConservation` | bool | `true` | Work out an unmeasured node's value from what it feeds, when exactly one path could have supplied it. Sound arithmetic, but it describes the hierarchy you drew rather than anything measured — so results are always labelled 'inferred'. Turn it off to show 'no data' instead. |
| `EnergyFlow.MqttExport` | bool | `false` | Publish each energy-hierarchy tier's rolled-up value to MQTT every poll. |
| `EnergyFlow.MqttExportTags` | object |  | Limit the MQTT export to nodes with particular tags. Empty exports every node. Filtering changes only what is sent — never a value, and never any other destination. |
| `EnergyFlow.MqttExportTags.Include` | list |  | Only send nodes carrying at least one of these tags. Empty sends every node. |
| `EnergyFlow.MqttExportTags.Exclude` | list |  | Never send nodes carrying any of these tags. Takes precedence over Include. |
| `EnergyFlow.MqttTopicTemplate` | string | `{parent}/energyflow/{id}` | Template for each tier's MQTT topic. Placeholders: {parent} (MQTT parent topic), {id}, {label}, {kind}, {metric}, {units}. e.g. '{parent}/energyflow/{id}'. |
