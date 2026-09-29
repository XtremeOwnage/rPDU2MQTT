---
title: Floor plans
---

# Floor plans

The **Floor Plans** page (under Energy Flow) draws each floor at real size: rooms and outdoor zones, doors and
windows, the outlets, lights, appliances, panels, meters and utility poles placed on it, and the cable runs between
them. **View** shades each room by what it draws now, today, or this week. **Edit** brings up a tool palette:

| Tool | Key | What it does |
| --- | --- | --- |
| Select | V | Select and drag anything: rooms and their corners, items, doors, windows, wire bends. Drag a box across empty plot to select everything in it; Shift, Ctrl or ⌘-click adds or removes one; Ctrl+A selects all. Dragging any selected thing moves them all; arrows nudge. The plot's edges and corners drag to resize it. |
| Pan | H | Drag to move around. Two fingers or Ctrl+wheel also pan and zoom. |
| Room | R | Drag out a rectangle, or **Add a room by size** from its inside measurements. |
| Outline | P | Tap each corner of an odd-shaped room; tap the first again (or double-tap) to close it. |
| Outdoor | O | A yard, porch, patio, driveway or deck: drawn as ground, not walls. |
| Area | A | An area that may span rooms, such as upstairs or the server corner. |
| Door / Window | D / W | Tap a wall; the opening snaps into it and lies along it. Doors can be single, double, sliding or garage. |
| Item | I | Place an outlet, switch, light, fan, appliance, device, HVAC unit, junction box, EV charger, panel, utility meter, utility pole, transformer, solar array, battery, inverter or generator. |
| Wire | L | Draw a cable run from the supply side: tap the item feeding it, each bend, and the item it goes to. Bends snap to wall corners and edges. A branch circuit, a feeder, or the utility service from the pole. |
| Constrain | K | Tap corners or walls, then hold them: two corners coincident; two walls in line, parallel or square; a wall level, plumb or at a fixed length; a corner at an angle. |
| Measure | M | Tap two points to measure between them, and set the plan's scale from a distance you know. |

The wheel zooms about the pointer and Shift+wheel pans; a pinch zooms on a tablet; the middle button, or holding Space, pans while any tool is in hand. **Floor settings › Arrange** centres the drawing on its plot, or fits the plot to the drawing. Ctrl+Z undoes and Ctrl+Y (or Ctrl+Shift+Z) redoes every change on the page; Delete removes the selection; Esc stops
drawing. The page is built for a tablet carried round the house: pinch to zoom, drag to pan, and below a laptop's
width the tools run across the top and the side panel drops below the plan.

**Sizes.** Distances read in feet and inches or metres and centimetres, as **GUI › Distance units** says (`auto`
follows the browser's language). Anywhere a length is typed, `12' 6"`, `12ft 6in`, `12 6`, `150"`, `3.75 m`,
`3m 75cm` and `375 cm` all work; a bare number is feet or metres. A rectangular room is sized by width and depth; any
other outline wall by wall. Tick **Sizes** to show every wall's length and each room's floor area.

**Scale.** Each floor keeps its drawing units per metre (`Scale`, default 100, so one unit is a centimetre). After
uploading a plan image, use **Measure** on a wall or doorway you know and type its real length; every size on the
floor then reads true.

**Outdoors.** An item placed outside every room is outdoors on its floor — an exterior light, a yard outlet, the
meter, the pole — and counts toward the floor's total. Outdoor zones are rooms marked `Outdoor`, and count like one.

**Circuits at a glance.** Tapping an item or a wire, in View or Edit, brings its whole circuit forward — every item and wire on it, and the rooms it serves — and fades the rest.

**GFCI outlets.** Tick *GFCI outlet* on an outlet (or keep *GFCI* on while placing them). Wires run from the supply side to the load side, shown by an arrow and reversible from the wire's panel, so what is downstream of a GFCI is everything its wires lead to. Selecting the GFCI lists and lights up everything it protects; a protected outlet says which GFCI protects it, and carries a green dot when the wiring is shown.

**Shared walls.** Corners that sit on top of one another belong to every room that meets there: dragging one moves it in all of them, and dragging a wall's middle dot slides the whole wall, with its neighbour following. Hold Alt to pull a shared corner apart. Double-click a wall's middle dot to add a corner.

**Locks.** A room or area can be locked from its panel: it cannot then be moved, reshaped or deleted until it is unlocked. Single walls can be locked too — neither end moves.

**Constraints.** Kept on each floor (`Constraints`), and held as the plan is edited: whatever is dragged or typed stays where it was put and the rest gives way. Locked rooms and walls never give way. A constraint that cannot hold with the others is marked in red, and the floor says which. Each room lists its constraints, each removable; a wall's *Fix* button holds it at its length.

**Surface colours.** A room's surface can be recoloured (`SurfaceColor`) — the carpet, the tile, the paint — keeping its pattern; with a plain surface the colour fills the room.

**Export.** *Export…* downloads the floor as SVG or PNG, or every floor plan as one JSON file with its images inside, which *Import floor plans…* reads back here or on another bridge.

**Storage warnings.** When no persistent plan storage is configured, or the configuration cannot be saved, the page says so in a banner above the plan.

**Appliances at their real size.** The Item tool's *At real size* group places a washer, dryer, fridge, chest freezer, range, dishwasher, water heater, furnace, AC condenser, server rack or hot tub at its usual size (`Width`, `Depth`, `Rotation`, `Round`), drawn as seen from above — a washer's round lid, a range's burners, a condenser's fan (`Footprint`). Dropped near a wall it stands with its back to the wall, facing the room. Selected, its corner handle sizes it and the knob above it turns it (in 15° steps; Shift for any angle), or its panel takes exact measurements. Any item can be given a real size, or drawn as an icon again.

**Right-click** anything on the plan for a menu about it: an item's circuit, trace, wiring, size, GFCI, duplicate or delete; a room's lock, redraw, duplicate or delete; a wall's corner, lock or held length; a corner or wire bend's removal; a wire's direction; and, on bare plot, adding a room or item there, the background image, or fitting the floor in view. While viewing, a choice that edits turns Edit on and does it, so nothing in the menu is dead.

**Showing constraints.** The *Constraints* checkbox shows or hides the constraint markers.

**Wall-mounted items.** Outlets and switches placed near a wall sit on it, on the side of the room they were placed in, and keep facing that room (`Facing`, in degrees).

**Wiring.** A run between two items shows the path the cable takes, in its circuit's colour; selecting an item or a
run brings its circuit forward and fades the rest. Wiring an item on no circuit to one on a known circuit puts it on
that circuit (said on screen, and undoable). A run's length on the plan is shown with it.

**Textures.** Rooms and outdoor zones can have a surface — wood, tile, carpet, concrete, stone, grass, gravel, dirt,
deck, pavers, water, snow, or stairs for a stairwell — drawn at its real size, and each floor a ground around the rooms.

```yaml
Gui:
  DistanceUnits: imperial            # auto, imperial or metric
EnergyFlow:
  Sites:
    - Id: home
      Name: Home
      Floors:
        - Id: ground
          Name: Ground floor
          Level: 0                   # -1 basement, 1 upstairs; floors are listed in this order
          Width: 1829                # the plot, in drawing units (60 ft at 100 units a metre)
          Height: 1219
          Scale: 100                 # drawing units per metre
          Image: 3f9c0e1a2b4d5e6f7a8b9c0d.png   # an uploaded plan, by id (see Plan storage below)
          ImageOpacity: 0.85
          Ground: grass
          Rooms:
            - Id: kitchen
              Name: Kitchen
              Surface: tile
              Shape: [{X: 0, Y: 0}, {X: 400, Y: 0}, {X: 400, Y: 300}, {X: 0, Y: 300}]
            - Id: back_yard
              Name: Back yard
              Outdoor: true
              Surface: grass
              Shape: [{X: 0, Y: 300}, {X: 1829, Y: 300}, {X: 1829, Y: 1219}, {X: 0, Y: 1219}]
          Areas:
            - Id: front
              Name: Front of house
              Rooms: [kitchen, office]   # an area takes in whole rooms, and may have an outline of its own
          Openings:
            - Id: door_1
              Kind: door                 # door, double-door, sliding-door, garage-door, window, opening
              X: 400
              Y: 150
              Angle: 90                  # the wall's direction
              Width: 91.4
              Swing: left
  Placements:
    - Id: fridge
      Kind: appliance
      Label: Fridge
      Room: kitchen                  # blank when it is outdoors
      Floor: ground
      X: 120
      Y: 80
      Circuit: main_panel/B06        # panel id / breaker number; blank when nobody knows yet
      Node: fridge_plug              # the node metering it, if one does
    - Id: pole_1
      Kind: pole
      Floor: ground
      X: 1800
      Y: 1200
  Runs:
    - Id: run_1
      Kind: circuit                  # circuit, feeder or service
      Floor: ground
      Circuit: main_panel/B06
      From: fridge
      To: outlet_2
      Points: [{X: 300, Y: 100}]     # the bends between its ends
  AutoLocations:                     # for derived nodes, which have no entry of their own
    - Match: "outlet:rack_pdu_1:*"
      Location: office
  Nodes:
    - Id: fridge_plug
      Location: kitchen              # where a node is
      Circuit: main_panel/B06        # the circuit it is plugged into
  Panels:
    - Id: main_panel
      Location: garage               # where the panel is mounted
      Breakers:
        - Number: B06
          Rooms: [kitchen, garage]   # the rooms and areas this circuit serves
          Node: ""                   # the node that is this circuit; blank uses the one channel measuring it
```

Ids are shared by sites, floors, rooms and areas, so each must be unique across all of them.

**Where a node is.** Its own `Location`; else an `AutoLocations` rule naming its exact id; else a placement metering
it (its room, or its floor when it is outdoors); else a wildcard rule; else the rooms its circuit serves (a circuit
serving two rooms counts toward the smallest place holding both — their area, or their floor). A node with none of
these is where its feeder is.

**How a room is totalled.** What flows into the room from outside is counted and what flows back out is taken
off, so a node between two others in the same room does not need a meter of its own. A total that needs a
reading nobody has is **unknown** and shown as *no data* — never a partial sum, and never 0. A room with nothing
metered in it is **unmetered**, which is drawn hatched and is not the same as drawing nothing. A room counts
toward its areas, its floor and its site.

**Circuits.** A circuit lists the metered devices on it and its **unmetered remainder**: the circuit's reading
less what is metered on it. The remainder is only reported when every part of it is known. When what is
metered reads more than the circuit itself, it is flagged — a device is recorded against the wrong circuit or a
CT is on the wrong wire — and the remainder is left negative rather than clamped. Linking a metered device to a
circuit offers to place it beneath the circuit in the energy flow; nothing is moved without saying so.

**Tracing an outlet's circuit.** Select an item on an unknown circuit and choose *Trace its circuit*. Plug a
load into it (or switch the fixture), then switch it on and off, tapping between: the channel that follows every
switch is the circuit, and the page offers to link the item to that channel's breaker.

**Rooms from tags.** *Tools › Rooms from tags* lists every tag in use, suggests which read like rooms or areas,
and shows exactly what each would become — places created, nodes placed, rules added, tags removed, and what is
left alone — before anything is written.

### Plan storage

Upload an image from **Background**, or drop one anywhere on the plan. Plan images are never written into the configuration: a Kubernetes custom resource is stored in etcd with a
limit of about 1.5 MB and is rewritten on every save. They go to plan storage instead, and the floor refers to
them by id. Uploads are PNG, JPEG, WebP or SVG up to `PlanStorage.MaxMegabytes` (10 by default); a phone photo is
decoded upright and shrunk in the browser before it is sent. A HEIC photo needs converting to JPEG first. A floor
whose image is missing or unreadable is drawn on a grid and stays usable.

```yaml
PlanStorage:
  Directory: /data/plans        # a persistent volume. Blank uses $RPDU2MQTT_PLANS_DIRECTORY, else the shared cache, else 'plans' beside the program
  MaxMegabytes: 10
  ObjectStore:                  # an S3-compatible bucket instead of a directory; setting Bucket switches to it
    Endpoint: http://minio:9000
    Bucket: house
    Region: us-east-1
    AccessKeyId: rpdu2mqtt
    # SecretAccessKey: from RPDU2MQTT_PLANS_SECRET_KEY
    Prefix: floorplans/
    PathStyle: true
```

- **Kubernetes:** set `floorPlans.persistence.enabled: true` in the chart. It creates a PVC (kept on uninstall),
  mounts it at `floorPlans.mountPath` on the pod serving the GUI, and points the bridge at it. Use
  `floorPlans.persistence.existingClaim` for a claim you manage. For a bucket instead, put the secret key in
  `credentials.plansSecretKey`.
- **Docker Compose:** mount a volume and point `PlanStorage.Directory` (or `RPDU2MQTT_PLANS_DIRECTORY`) at it.
- **Plain binary:** any directory the process can write.
- **With the shared cache on** (`Cache.Enabled`, the chart's Valkey) and no directory or bucket named, images are kept
  in the cache, so they survive a restart and are shared by replicas without a volume.

### Rooms in Home Assistant

- Every device this bridge publishes carries its room as `suggested_area` in MQTT discovery, so a new device
  lands in the right area on its own. (Home Assistant only applies it when it first sees the device.)
- With the MQTT export on, every room, area, floor and site is published as a tier of its own — power, lifetime
  energy and energy today — with a device filed in the room's area, ready for the Energy dashboard. A place whose
  total is unknown is not published.
- *Tools › Publish rooms to Home Assistant* creates an area for each room, matches existing ones by name, and
  renames an area it linked before when the room is renamed. It files this bridge's devices that have no area in
  their room's area and leaves any device someone already put somewhere alone. Everything is previewed first.
  Removing a room leaves its Home Assistant area in place, and the preview says so. It uses the URL and token
  under **Home Assistant › Energy Dashboard**. Save afterwards so each room remembers its area.
