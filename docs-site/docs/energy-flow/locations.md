---
title: Locations
---

# Locations

**Energy Flow › Locations**. Sites, floors, rooms and areas, with each place's total and members. Bundled plugin: `plugins/rPDU2MQTT.Plugin.Locations`.

| Part | |
| --- | --- |
| Tree | Places with live power. Add, rename, reorder, delete. |
| Now / Today | The place's total. Blank when nothing metered is in it or a reading is missing. |
| Members | Nodes in the place, and why: set, rule, floor plan or circuit. Inherited members are greyed. |
| Rules | `AutoLocations` pointing here. `*` matches anything. |
| Assign | Tick nodes, pick a place. Configured nodes get `Ext.locations.Location`; others get an exact rule. |

A new place's id follows its first name. Deleting a place clears every reference to it.
