---
title: Energy flow
---

# Energy flow

The **Flow** tab models where your energy actually goes: PDU → outlet links are derived automatically, and
you add the upstream nodes yourself (panels, breakers, a transfer switch, a "Total"). Every tier's value
rolls up from its children, and with `MqttExport` on, each tier is published to MQTT and — when HA
discovery is enabled — appears in Home Assistant as its own device.

## The energy balance: what counts as Solar, Grid, Battery and Home

`EnergyFlow.Balance` names the nodes each headline total is made of. The Energy and Overview pages, Trends,
self-sufficiency and the Home Assistant Energy Dashboard sync all read it, so they cannot disagree about what
"solar" is. Each list is summed, and nothing outside the lists counts:

```yaml
EnergyFlow:
  Balance:
    Solar:   [pv_total]          # the PV total — not the MPPT strings it is made of as well
    Grid:    [utility_meter]     # one reading of the grid, not the inverter's as well
    Battery: [battery]           # discharge out, charge in
    Home:    [inverter]          # the inverter's load output; empty works it out from the other three
```

What a node *is* (its `Kind`) and what it *counts toward* are separate on purpose. A hybrid inverter reports
solar, battery, grid and load, each on a node of its own, and the node carrying its load output is the home
total even though it is an inverter. MPPT strings stay `solar` so they are drawn as solar, and are simply
not listed. Two inverters, two arrays or two battery banks are several entries in one list.

Set it on the **Balance** page (under Energy Flow), or with **Counts toward** on a node — both edit the same
list, and a node counts toward one total at most. A listed id that matches no node is marked on the Balance
page, since that total is then short. Renaming a node in the editor keeps its place; deleting it removes it.

**With every list empty, totals follow each node's kind, counting each node once** — the rule before the
Balance existed, so an existing setup looks the same until you set one. A `load` node counts as Home. Where
one node already holds another — the MPPT strings a PV total is grouped from, a sub-panel beneath its panel —
adding both would be the same energy twice, so a node another one holds (`within`) is left out. The Balance
page shows what that rule comes to and can start the lists from it.

**A counter that was re-based is counted from zero.** Some counters re-base — weekly, on a device restart, or
when a feed is recreated — and a reading lower than the one before it means the count started again. That
reading is what has run since, so it is counted as the period's figure rather than dropped, and marked: the
page says how many readings came from a reset, and the table underlines those cells, because whatever ran
before the reset is gone and the real figure may be higher.

**The Trends page also gives the figures as a table** under the charts — a row per day, newest first, with the
home, solar, battery charged and discharged, grid used and exported, and the net of the meter (used less
exported). A day nothing reported is empty rather than zero — and a day whose export was not read has no net,
since the import alone is not one. A column's total says when it is the sum of the days that are known.

**The view is the reader's.** A live reading redraws the diagram without touching the zoom or where the pane
is scrolled to — only **Fit** puts it back to the whole diagram. **Showing** draws one node and everything
beneath it and nothing else, which is how a phone reads a panel's circuits: what carries something is offered
(panels, breakers, inverters, PDUs), an end load is not, and the choice holds across a redraw. **Double-click**
a node to drill into it, the node at the top again to come back out one level, and bare canvas for the whole
diagram.

**A live reading waits while a control is in use.** Redrawing a page rebuilds its controls, which closes a
dropdown someone has just opened and loses what they were typing. An update that arrives while a select, an
input or a text box on that page has focus is held and drawn as soon as it is let go — the newest of them,
not every one that queued. A control left focused does not freeze the page: after a minute the update goes
through.

**Right-click a node on the diagram** for a menu about it: **History…** charts what it has been drawing;
**Drill into this** draws it and what is beneath it alone, with **Out one level** and **Show the whole
diagram** to come back; **Trace its supply** lights everything upstream of it and dims the rest; and **Edit this node** opens it on
the Nodes page — disabled for a node the bridge derives from what it polls, which has no entry to edit.
Escape, or a click anywhere else, closes the menu, and a live reading arriving while it is open is held until
it closes, so the diagram does not redraw out from under it. A right-click on bare canvas is about the diagram
instead: clear the trace, fit it to the page, or refresh.

The history sheet covers the last hour, 6 hours, 24 hours, 7 days or 30 days, in whichever measurement is
picked there — watts, amps, VA or today's energy — and says how much of the window is known, the peak and
when it happened, the average and the latest reading. A moment with no reading is a gap in the line, never a
zero or a partial sum. Beneath it, **what the tier feeds** is broken out, busiest first, each on a strip of
its own from the same reading, so where a total went can be read off without asking again — and on the Panel
Schedule, a double-pole breaker's chart breaks out its two legs the same way. The window you pick is kept for
the next sheet you open.

## Accuracy: what the flow will and won't infer

The diagram never states a number nobody supplied. A node's value comes from one of:

1. **A measurement** — a live source bound to it, or a static `Value`.
2. **Its children**, summed.
3. **Conservation**, when it is the *single* unmeasured path into a node whose demand is measured. The load
   is really being drawn and there is exactly one way for it to arrive, so the figure is derived, not guessed.

If none of those apply the node reads **"no data"** on the diagram, publishes nothing to MQTT / Home
Assistant / EmonCMS, and is reported as `null` by the API — deliberately *not* `0`, because 0 is a claim
(solar at night really is 0 W) and a fabricated zero recorded into history is worse than a gap.

In particular, **several unmeasured feeders into one node all read "no data"**. If solar, battery and grid
all feed an inverter and none of them is metered, nothing indicates which supplied the load, so none of them
is given a share of it. To say where unaccounted power comes from, mark that feeder's `Mode: residual` — the
designated absorber carries the remainder after every measured feeder has supplied its part.

> Before this rule existed, that case split the load equally between them: three unmeasured sources under a
> 553 W load each showed 184.3 W, which is indistinguishable on the diagram from a real measurement.

A configured node always appears on the diagram even when it has no value, so a gap in your metering is
visible as a gap rather than as a missing node.

**Grouping nodes.** Several nodes can be shown as one collapsible node on both flow graphs — e.g. three MPPTs
as one "Incoming PV". Add a group on the **Nodes** tab (give it an id, label and members); the flow diagram
and the node roll-up then show the group as a single node whose value is the **sum of its members**, with a
toggle above each graph to expand it back to the members. The members are unchanged — they keep their own
wiring and still export individually — and the group itself also publishes its summed total (`{id}` on the
MQTT tier topic, its own Home Assistant sensor) when `EnergyFlow.MqttExport` is on. A group is the sum of the
members that have data, and is itself "no data" when none of them do — never a fabricated zero.
