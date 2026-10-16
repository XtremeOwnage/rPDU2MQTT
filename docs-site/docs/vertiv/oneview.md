---
title: OneView
---

# OneView (device aggregation)

OneView clusters several Geist / Vertiv PDUs behind one master. Point rPDU2MQTT at the master.

## Setup

1. On the master PDU's web UI, enable OneView and add the member PDUs.
2. In **Sources › Vertiv rPDU**, set **Host** to the master.
3. For outlet control, create the action user with **Control** permission on every PDU in the cluster.

Detection is automatic. The bridge reads `/api/conf/oneview/enabled`, then polls `/oneview` when it is on and `/api` when it is off. The log shows `Detected OneView. Will use /oneview for collecting data.`

## What is published

| Item | Home Assistant device | Sensors |
| --- | --- | --- |
| Each member PDU | Yes, linked to the master (`via_device`) | PDU measurements |
| Each outlet | Yes | Outlet measurements, switch, reboot |
| Each OneView group | Yes | Sum / Avg / Min / Max roll-ups, member switches, **All On**, **All Off**, **Reboot All** |
| `total` group | Yes | Whole-cluster roll-ups |

- Group actions need **Enable Write Actions**. They run the per-outlet command on each member. If members cannot be resolved, nothing is sent.
- Group actions are on [PDU Control](control.md) and in Home Assistant.
- Outlet control to a member is routed through the master.

## Overrides

In the GUI: **Sources › Overrides** lists each OneView group with Name, ID and Enabled.

```yaml
Overrides:
  OneviewGroups:
    Measurements:
      realPower: { ID: power_sum, Name: Power (Sum) }
      energy: { ID: energy_sum, Name: Energy (Sum) }
    Overrides:
      r730xd: { ID: dell_r730xd, Name: "Group: Dell R730XD" }
      unassigned: { Enabled: false }
      total: { Enabled: false }
```

Groups are keyed by numeric id or name. The `(Sum)` / `(Avg)` / `(Min)` / `(Max)` suffix is added to group sensor names.
