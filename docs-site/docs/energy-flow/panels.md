---
title: Panels and breakers
---

# Panels and breakers

The **Panel Schedule** page holds the panel directory: each breaker's number, rating, wire, what it feeds, and
the CT clamp and monitor channel measuring it. Two things follow from that mapping on their own.

**Every mapped breaker is a tier of the energy flow**, and never two nodes for one circuit:

- A breaker measured by **one** channel **is** that channel. A tier above a single channel would carry the same
  reading twice under two names, so the channel stays as the circuit and the panel feeds it directly. If the
  channel is named after itself (`n30_1_5`), it takes the name of the breaker measuring it — an input number is
  not a circuit — while a name someone has given it is left alone.
- A breaker on **two** channels (a double-pole with a clamp per leg) is a node of its own,
  `breaker:<panel>:<number>`, above both legs and worth their sum. With a leg not reading it is **unknown**,
  never half of itself.
- A breaker that **names a node** (`Node`) is that node, whatever measures it.
- An identified breaker **nobody measures** is a tier of its own with no value, rather than a zero. An unused
  slot is not a tier at all.

Its label is what the directory says it feeds, so renaming the breaker renames the tier. Because these are
ordinary nodes, per-breaker power and energy reach the diagram, Home Assistant, EmonCMS and Prometheus without
being wired by hand. Where the schedule used to wire the panel straight to a channel, that link is dropped when
a breaker sits in between, so nothing is counted twice.

**Which node a panel is.** The *This panel is* picker offers nodes of kind **panel** only — a channel or a
breaker is not a panel — and not one another panel in the directory already is. A node already recorded stays
in the list, marked, so opening the page never re-points a panel on its own.

**What can measure a breaker.** The channel picker offers every node the bridge reads, including a subpanel —
a breaker feeding one is measured by the CT on its feed. It does not offer the panels of the directory, the
nodes feeding them, or a breaker's own tier, none of which read anything for the breaker. A channel already
recorded that the bridge has stopped reading is kept in the list rather than dropped, so applying an edit never
silently clears a mapping.

**The mapping is checked against itself and against the readings**, on the page and in Diagnostics
(`panelFindings`). Each finding names the breakers and channels involved and leads to them; nothing is changed
for you:

- a channel mapped to more than one breaker,
- a channel drawing power that no breaker is mapped to,
- a breaker marked unused whose channel is drawing power,
- a double-pole breaker with a clamp on one leg only,
- a breaker reading more current than its rating,
- a clamp pointed at a breaker's own tier rather than at something that reads,
- a panel fed from more than one place,
- a circuit fed from somewhere besides its panel, so it hangs off the graph twice.

**A panel is fed from one place.** Two feeders split its power across both on the diagram and count a supply
that is not there. The wiring editor refuses a second feeder into a panel — drop the one that is there first —
and the panel's own **Fed by** on the Panel Schedule page takes one. Any that are already in a config are
reported rather than silently dropped, since nothing here rewrites your wiring for you.

**A directory you already keep can be pasted in.** **Import…** takes the panel directory as it is written —
breaker number, wire label, monitor channel and what the breaker feeds, in whatever order the line carries
them, with `????` for a circuit nobody has identified and `Unused` for an empty slot — and shows what every
line was read as before anything is written: new, an update to the breaker already there, or a clash with a
slot already held, which is left alone. A line that could not be read is shown and can be corrected in place,
and a channel no node answers to is flagged rather than mapped. Applying writes into the directory the page is
holding; nothing is kept until **Save**.

**An unknown breaker can be traced.** **Trace…** records what every channel is drawing, waits while you switch
the breaker off, and names the channel that went dark, with what it fell from and to. Taking the answer maps
the breaker to it and marks it identified; a channel already recorded against another breaker is flagged
rather than quietly taken, and a 240 V circuit drops both legs at once, so both can be taken together. A
circuit drawing nothing when the baseline was taken cannot be told apart from one that is off, and the page
says so instead of guessing — switch its load on and trace again. A channel that stopped reporting altogether
is not a channel that went dark, so it is never offered as the answer.

**It prints for the inside of the panel door.** **Print…** lays the directory out as the panel is — odd slots
down the left, even down the right, numbers up the middle — with each breaker's wire, rating and what it
feeds. A slot nobody has identified prints as unknown rather than blank, and the second slot of a double-pole
says which breaker holds it. A 42-slot panel fits one letter or A4 page.
