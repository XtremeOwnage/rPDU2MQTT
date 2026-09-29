---
title: Live sources
---

# Live sources

## Live sources from MQTT

A node doesn't have to be a fixed number. Bind it to a topic that's already on your broker and it becomes a
live measurement, rolling up and exporting exactly like a PDU outlet does. This is how you pull in a
producer that rPDU2MQTT doesn't poll itself — **Solar Assistant**, a CT clamp, an inverter bridge.

```yaml
EnergyFlow:
  Nodes:
    - Id: solar
      Label: Solar Array
      Sources:
        # Solar Assistant's /state topics publish a bare number, so no JsonField is needed.
        - Type: mqtt
          Topic: solar_assistant/inverter_1/pv_power/state
          Metric: realpower           # drives the power roll-up (W)
        - Type: mqtt
          Topic: solar_assistant/total/pv_energy/state
          Metric: energy              # drives the energy roll-up (kWh) -> HA Energy Dashboard
    - Id: main_panel
      Label: Main Panel
  Links:
    - { From: solar, To: main_panel }
  MqttExport: true
```

Per-source settings:

| Setting | Purpose |
| --- | --- |
| `Topic` | The topic to subscribe to. Bound live — adding one in the GUI needs no restart. |
| `Metric` | Which roll-up this feeds (`realpower`, `energy`, …). Bind one topic per metric to drive both power and energy. |
| `JsonField` | For JSON payloads, the field to read — dotted for nesting (`battery.power`). Blank means the whole payload is the number. |
| `Scale` | Multiplier for unit conversion (`0.001` for W → kW) or to flip a sign convention (`-1`). |
| `Accumulation` | For an `energy` source: `lifetime` (default — a cumulative counter whose *rise* is measured) or `period` (the device resets it daily, so the reading already **is** today's total). |
| `StaleAfterSeconds` | Ignore the value once it's this old (default 900). Stops a dead publisher from propping up the flow with a reading that stopped being true. `0` disables the check. |

Notes:

- **Check `Accumulation` on every energy source, and check it against the topic rather than the publisher.**
  One publisher can do both, and which it does is not visible in the name: ESPHome's `energy_d` /
  `daily_energy` sensors reset at midnight while its `total_energy` does not, and Solar Assistant's
  `total/…_energy` family is cumulative on current versions. Do not take either on trust — watch the topic
  across a rollover, because a daily counter drops there and a cumulative one carries straight on.
  Both mistakes cost you data, in opposite ways:
  - A **daily counter declared `lifetime`** is the expensive one. Its rise is measured, so it loses the
    whole day every midnight (seen live: 2.76 kWh of solar against 27.4 kWh actually generated) — and worse,
    the export guard reads every subsequent reading as a meter running backwards and publishes *nothing*, so
    the cumulative sensor sits at `unknown` and Home Assistant's grid/solar/battery sources have no
    statistic to read. The bridge now says so in the log the first time it catches a `lifetime` counter
    restarting.
  - A **cumulative counter declared `period`** is caught by the daily-counter audit and withheld, because a
    lifetime total displayed as "today" is a confident wrong figure.
- A live reading **supersedes** the node's fixed `Value`, which stays as the fallback for anything you're
  modelling by hand. A live `0` is a real reading (solar at night), not a fall-back to `Value`.
- Negative readings are clamped to `0` — a directed flow graph can't carry a negative, and it would
  subtract from the roll-up. Use `Scale: -1` if your publisher's sign convention is inverted.
- Values feed the same exports as everything else, so an MQTT-sourced node reaches Prometheus, the MQTT
  tier export, and the HA Energy Dashboard without any extra wiring.

## Values worked out from a node's other readings

A meter that reports some of what it measures can have the rest. Add a binding of type `derived` and the
value is computed from the node's own readings, using the electrical relations and nothing else:

| Relation | Exact when |
| --- | --- |
| `S = V × I` | always (single phase) |
| `P = S × PF` | always |
| `P = V × I` | only at a power factor of 1 — a DC string, a resistive load |

So **voltage, current, power, apparent power and power factor** can each be worked out from a pair of the
others:

```yaml
EnergyFlow:
  Nodes:
    - Id: grid
      Label: Grid
      Sources:
        - { Type: mqtt, Metric: realpower, Topic: solar_assistant/inverter_1/grid_power/state, Direction: split }
        - { Type: mqtt, Metric: voltage,   Topic: solar_assistant/inverter_1/grid_voltage/state }
        - { Type: derived, Metric: current, Direction: split }
```

- **The exact relation wins.** With a power factor bound, current resolves as `(P ÷ PF) ÷ V` — reached in
  two steps — rather than `P ÷ V`, which would under-report it by that factor. Operands may themselves be
  derived; nothing is ever derived from itself.
- **An approximation says so.** `P ÷ V` is offered only when nothing better fits, and the node editor prints
  *assumes a power factor of 1* beside it.
- **A measured reading always wins.** Bind an ammeter and the arithmetic steps aside.
- **Both readings are required.** A node whose derived binding has no pair to work from is flagged in the
  editor, naming the pairs that would do. The value is simply absent — never a zero, never half an answer.
- A reading of `0` in a divisor, or either reading gone stale, produces nothing, and the Energy and
  Hierarchy pages say which node and why in the withheld-sources banner.
- Direction is carried through: `current#in` uses the power flowing that way, over the same bus voltage —
  voltage and power factor have no direction.
- The relations are single-phase. A three-phase meter reporting a line voltage needs its own maths, which
  this does not attempt.

> **Kubernetes:** the CRD no longer enumerates a source's `Type` — the set is open, since plugins contribute
> types at runtime. If your cluster still has an older CRD, saving a `derived` binding fails with
> `Unsupported value: "derived"`. Apply the CRD from `charts/rpdu2mqtt/files/rpduconfig-crd.yaml` once and it
> will not happen again, for this or any future type.


## Live sources from Modbus TCP

A node's value can also come from a Modbus TCP device (an inverter, a meter, a PLC). Define the connection
once under `Modbus`, then bind a node's metric to a register — same live-value seam as MQTT (polled by the
worker, rolled up and exported identically).

Each connection has a **`Framing`**:

- **`auto`** (default) — try native Modbus TCP, then Modbus RTU over TCP, and use whichever the device
  actually answers. You normally don't have to think about it. (The resolved framing is remembered per
  connection so it isn't re-probed every poll.)
- **`tcp`** — pin native Modbus TCP (a device/gateway that speaks Modbus/TCP directly, usually port 502).
- **`rtu-over-tcp`** — pin Modbus RTU frames over a raw TCP socket. This is what most **RS485-to-Ethernet
  gateways / serial dongles** speak (e.g. an **EG4** inverter reached on port 4196/8899).

If a connection *connects* but every register reads as an error, it's the framing — `auto` handles that for
you; pin one only if you want to skip the detection.

**One poller per device.** Many RS485-to-Ethernet gateways accept only **one TCP client at a time**, so the
Modbus poller runs **only in the Worker role** — in a split deployment the API/UI don't poll the device
themselves (they'd contend with the worker and each other, and reads would time out). The Nodes editor shows
each binding's value from the shared live cache the worker fills; the **"Test device read"** button opens a
one-off connection to check a binding before it's saved — use it sparingly if your gateway is single-client,
since it briefly competes with the worker's poll.

## Live sources from EmonCMS feeds

If a circuit is already metered by something that posts to EmonCMS — an IotaWatt, an emonTx, an emonPi — the
number is already sitting in a feed, and it can value a flow node directly. Set `Type: emoncms` on the
binding and name the feed:

```yaml
EnergyFlow:
  Nodes:
    - Id: server_rack
      Label: Server rack
      Sources:
        - Type: emoncms
          Metric: realpower
          Feed: 2_power           # a feed name, 'tag/name', or its numeric id
        - Type: emoncms
          Metric: energy
          Feed: 2_energy
EmonCMS:
  Url: http://emoncms.example.com
  ApiKey: <a key that can read feeds>
  Source:
    PollIntervalSeconds: 30
```

**Naming the feed.** A bare name is resolved against the server's feed list, so the binding survives a
re-provision that renumbers the feed. EmonCMS names are only unique *within a tag*, though — `energy` may
well exist under both `solar` and `grid`. An ambiguous name is reported as ambiguous and reads as nothing
rather than silently binding to whichever came back first; qualify it as `tag/name`, or use the numeric id.
The Nodes editor's **Browse…** button lists the server's feeds with their current values and picks the right
form for you.

**What it needs.** Only `EmonCMS.Url` and an API key that can read feeds. `EmonCMS.Enabled` switches the
*export* on and is not required here — reading a neighbouring EmonCMS you push nothing to is an ordinary
setup. The poll itself only runs when something is actually bound to a feed.

**One request per poll.** The whole poll is a single `/feed/list.json`, however many feeds are bound. That
call also carries each feed's own timestamp, and **that** is what freshness is judged against — not the
moment the poll ran. A dead IotaWatt leaves its last reading in the feed forever, and a node whose feed
stopped updating goes to "no data" on its `StaleAfterSeconds` rather than propping the hierarchy up on a
number that stopped being true overnight.

Units, `Scale`, `Direction` (including `split`), `Accumulation` and the daily-counter audit all behave
exactly as they do for an MQTT or Modbus binding — a feed's value is indistinguishable downstream from any
other source. If EmonCMS records a unit for the feed it is converted to the metric's canonical unit on the
way in; set the binding's own `Unit` to override a mislabelled feed.

## Live sources from Home Assistant entities

The same seam, pointed at an HA entity: `Type: homeassistant` with the entity id in the binding's
`Settings.Entity`, read over the REST API using `HomeAssistant.EnergyDashboard.Url` and a long-lived access
token. Useful when the thing measuring a circuit is already in Home Assistant through some other
integration. An entity that is `unavailable` or non-numeric supplies nothing — never zero.

## Device templates (Nodes tab → "Import device template")

Rather than wire a known device register-by-register, the **Nodes** tab can import a ready-made template:
pick the device, give it an id prefix and (for Modbus) its host/IP, and it drops in the Modbus connection
plus pre-wired nodes (solar / battery / grid / inverter) with the register bindings filled in. Review and
**Save** afterwards.

> Register maps are **community starting points** and vary by model and firmware — verify the addresses and
> scales against your own device. Each imported binding notes the register it maps, and the template links
> its source. Included today: **EG4 FlexBoss 21**. More can be added — paste a device's register table and
> it can be turned into a template.
