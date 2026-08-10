// MQTT Import: browse what a broker publishes and turn it into energy-flow nodes.
import { api, btn, el, ensure, activate, navLink, toast } from '../helpers.js';
import { state } from '../state.js';
import { refreshDirty } from '../dirty.js';
import { migrateEnergyFlow, saveConfig } from './flow.js';
import { loadNodeTemplates, instantiateTemplate } from '../node-templates.js';

// The "Import device template" panel: pick a template, set an id prefix + Modbus host/unit, and drop the
function renderDiscoverPanel(flow: any, rerender: () => void): HTMLElement {
  const panel = el('div', { class: 'tpl-import' });
  panel.appendChild(el('div', {
    class: 'desc',
    text: 'Readings other integrations publish to this broker — power, energy, current, voltage, frequency. '
        + 'Pick the ones to add as nodes; nothing is created until you do, and nothing is saved until you '
        + 'press Save. Add topic shapes for other publishers under MQTT → ImportProfiles.',
  }));

  const bar = el('div', { class: 'ld-toolbar' });
  // Where to look. Discovery states the unit and device class, so it is the default; the topic profiles
  const srcSel = el('select', { style: { width: 'auto' } }) as HTMLSelectElement;
  srcSel.appendChild(el('option', { value: 'discovery', text: 'Home Assistant discovery' }));
  // The rest come from the server: built-in profiles plus MQTT.ImportProfiles.
  api('/api/mqtt/profiles').then((r: any) => {
    ((r.body && r.body.profiles) || []).forEach((p: any) =>
      srcSel.appendChild(el('option', { value: p.id, text: p.label + ' topics' })));
  });
  const tagIn = el('input', { type: 'text', value: 'imported', placeholder: 'tag (optional)' }) as HTMLInputElement;
  // Where the imported nodes hang, and which way round. An appliance monitor is a load: the panel supplies
  const dirSel = el('select', { style: { width: 'auto' } }) as HTMLSelectElement;
  dirSel.appendChild(el('option', { value: 'load', text: 'drawn from' }));
  dirSel.appendChild(el('option', { value: 'source', text: 'feeding' }));
  const feedSel = el('select', { style: { width: 'auto' } }) as HTMLSelectElement;
  feedSel.appendChild(el('option', { value: '', text: '— not wired —' }));
  (flow.Nodes || []).forEach((n: any) =>
    feedSel.appendChild(el('option', { value: n.Id, text: n.Label || n.Id })));
  const scan = btn('Scan broker', 'primary');
  const addBtn = btn('Add selected', 'primary');
  const copyBtn = btn('Copy this profile to config');
  copyBtn.title = 'Write the selected built-in profile into MQTT.ImportProfiles, where its pattern and '
                + 'metric map can be edited.';
  bar.append(srcSel, scan,
    el('span', { class: 'desc', style: { margin: '0' }, text: 'Wire as:' }), dirSel, feedSel,
    el('span', { class: 'desc', style: { margin: '0' }, text: 'Tag as:' }), tagIn, addBtn, copyBtn);
  const note = el('div', { class: 'desc' });
  const list = el('div');
  panel.append(bar, note, list);

  // Tagged on import so the per-destination filters can exclude them. A reading imported from Home
  tagIn.title = 'Applied to every node added here. Use it in a destination’s tag filter to avoid '
              + 'exporting these readings back to where they came from.';

  const picked = new Set<string>();
  // Topics already bound anywhere in the config: a reading is "already imported" when its topic is bound,
  const boundTopics = new Set<string>();
  (flow.Nodes || []).forEach((n: any) =>
    (n.Sources || []).forEach((src: any) => { if (src.Topic) boundTopics.add(src.Topic); }));

  /// The node a reading belongs to: its device, not its individual measure.
  const nodeIdFor = (r: any) =>
    String(r.device || r.id || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || r.id;

  // Rows and their unit selectors, so the bulk controls can drive them without a re-render.
  let boxes: { reading: any, box: HTMLInputElement }[] = [];
  let unitSels: { reading: any, sel: HTMLSelectElement }[] = [];

  const render = (readings: any[]) => {
    list.innerHTML = '';
    boxes = []; unitSels = [];
    if (!readings.length) {
      note.textContent = srcSel.value === 'discovery'
        ? 'No importable entities in the broker’s Home Assistant discovery. Publishers that announce nothing '
          + 'will not appear here — try a topic profile instead.'
        : 'No topics matched this profile’s shape. Check the pattern against what the publisher actually '
          + 'sends, or add one under MQTT → ImportProfiles.';
      return;
    }
    const tbl = el('table', { class: 'ld' });
    const head = el('tr');
    ['', 'Device', 'Reading', 'Metric', 'Unit', 'Topic'].forEach(h => head.appendChild(el('th', { text: h })));
    tbl.appendChild(el('thead', {}, head));
    const body = el('tbody');
    readings.forEach(r => {
      const tr = el('tr');
      const cb = el('input', { type: 'checkbox', class: 'switch' }) as HTMLInputElement;
      const already = boundTopics.has(r.topic);
      // Two reasons a row cannot be taken: already modelled, or not bindable from its template.
      cb.disabled = !!r.unsupported || already;
      cb.onchange = () => { cb.checked ? picked.add(r.id) : picked.delete(r.id); syncCount(); };
      if (!cb.disabled) boxes.push({ reading: r, box: cb });
      tr.appendChild(el('td', {}, cb));
      tr.appendChild(el('td', { text: r.device || '—' }));
      tr.appendChild(el('td', { text: r.label }));
      tr.appendChild(el('td', { text: r.metric }));

      // A topic-matched reading carries no unit. The choices are the units FlowUnits accepts for this
      const unitCell = el('td');
      if (r.unit) {
        unitCell.appendChild(el('span', { text: r.unit }));
      } else {
        const choices: string[] = r.units || [];
        const unitSel = el('select', { style: { width: 'auto' } }) as HTMLSelectElement;
        unitSel.appendChild(el('option', { value: '', text: '— pick —' }));
        choices.forEach(u => unitSel.appendChild(el('option', { value: u, text: u })));
        // Pre-filled with the metric's canonical unit. It is a form default the operator reviews against
        r.unit = r.unit || r.canonicalUnit || '';
        unitSel.value = r.unit || '';
        unitSel.onchange = () => { r.unit = unitSel.value || undefined; };
        unitCell.appendChild(unitSel);
        unitSels.push({ reading: r, sel: unitSel });
        if (!choices.length) unitCell.appendChild(el('div', { class: 'desc', style: { margin: '0' }, text: 'no units for this metric' }));
      }
      tr.appendChild(unitCell);

      const topic = el('td');
      topic.appendChild(el('code', { text: r.topic, style: { color: 'var(--muted)' } }));
      if (r.sample != null && r.sample !== '')
        topic.appendChild(el('div', { class: 'desc', style: { margin: '0' }, text: `last value: ${String(r.sample).slice(0, 60)}` }));
      if (r.unsupported) topic.appendChild(el('div', { class: 'nh-warn', text: `Cannot import: ${r.unsupported}.` }));
      else if (already) topic.appendChild(el('div', { class: 'desc', style: { margin: '0' }, text: 'Already bound.' }));
      tr.appendChild(topic);
      body.appendChild(tr);
    });
    tbl.appendChild(body);
    list.appendChild(bulkBar(readings));
    list.appendChild(tbl);
    // Repeated below the table. With twenty rows the toolbar scrolls off the top, leaving the page's Save
    const footer = el('div', { class: 'ld-toolbar', style: { marginTop: '6px' } });
    const addAgain = btn('Add selected', 'primary');
    addAgain.onclick = () => addBtn.onclick!({} as any);
    footer.append(addAgain, el('span', { class: 'desc', style: { margin: '0' }, text: 'Adds the ticked rows as nodes. Save writes them to the config.' }));
    list.appendChild(footer);
    syncCount();
  };

  /// Keep both Add buttons showing how many rows are ticked.
  const syncCount = () => {
    const n = picked.size;
    const label = n ? `Add ${n} selected` : 'Add selected';
    [addBtn, ...Array.from(list.querySelectorAll('button'))].forEach((b: any) => {
      if (b && /^Add \d* ?selected$/.test(b.textContent || '')) b.textContent = label;
    });
  };

  /// Select-all, and one unit setter per metric present, so twenty rows are not twenty clicks.
  const bulkBar = (readings: any[]) => {
    const row = el('div', { class: 'ld-toolbar', style: { flexWrap: 'wrap', gap: '8px', margin: '0 0 6px' } });

    const all = btn('Select all');
    all.onclick = () => {
      const turnOn = boxes.some(b => !b.box.checked);
      boxes.forEach(b => {
        b.box.checked = turnOn;
        turnOn ? picked.add(b.reading.id) : picked.delete(b.reading.id);
      });
      all.textContent = turnOn ? 'Select none' : 'Select all';
      syncCount();
    };
    row.appendChild(all);

    // One setter per metric in the results: the answer is usually the same for every row of a metric
    const metrics = [...new Set(readings.filter(r => !r.unit || r.units?.length).map(r => r.metric))].sort();
    metrics.forEach(metric => {
      const choices: string[] = (readings.find(r => r.metric === metric) || {}).units || [];
      if (choices.length < 2) return;   // nothing to choose between
      const sel = el('select', { style: { width: 'auto' } }) as HTMLSelectElement;
      choices.forEach(u => sel.appendChild(el('option', { value: u, text: u })));
      sel.value = (readings.find(r => r.metric === metric) || {}).canonicalUnit || choices[0];
      sel.onchange = () => {
        unitSels.filter(u => u.reading.metric === metric).forEach(u => {
          u.sel.value = sel.value;
          u.reading.unit = sel.value;
        });
      };
      row.append(el('span', { class: 'desc', style: { margin: '0' }, text: `all ${metric}:` }), sel);
    });

    return row;
  };

  copyBtn.onclick = async () => {
    const id = srcSel.value;
    if (!id || id === 'discovery' || id.startsWith('custom:')) {
      toast('Pick a built-in topic profile first.', false);
      return;
    }
    const r = await api('/api/mqtt/profile?id=' + encodeURIComponent(id));
    if (!r.body || !r.body.ok) { toast((r.body && r.body.message) || 'Could not read that profile.', false); return; }
    const p = r.body.profile;
    const mqtt = ensure(state.data, 'MQTT', {});
    const list = ensure(mqtt, 'ImportProfiles', []);
    if (list.some((x: any) => (x.Name || '').toLowerCase() === (p.label || '').toLowerCase())) {
      toast(`'${p.label}' is already in ImportProfiles.`, false);
      return;
    }
    list.push({ Name: p.label, Filter: p.filter, Pattern: p.pattern, JsonField: p.jsonField || undefined, Metrics: p.metrics });
    toast(`Copied '${p.label}' into MQTT → ImportProfiles. Edit it there, then Save.`, true);
    refreshDirty();
  };

  let found: any[] = [];
  scan.onclick = async () => {
    const src = srcSel.value;
    note.textContent = 'Scanning the broker…';
    const r = await api(src === 'discovery'
      ? '/api/mqtt/importable'
      : '/api/mqtt/importable/pattern?profile=' + encodeURIComponent(src));
    if (!r.body || !r.body.ok) { note.textContent = (r.body && r.body.message) || 'Could not scan.'; return; }
    found = r.body.readings || [];
    note.textContent = `${found.length} reading(s) from ${r.body.scanned} retained topic(s).`;
    render(found);
  };

  addBtn.onclick = () => {
    const take = found.filter(r => picked.has(r.id) && !r.unsupported && !boundTopics.has(r.topic));
    if (!take.length) { toast('Nothing selected.', false); return; }
    const tag = tagIn.value.trim();
    const nodes = ensure(flow, 'Nodes', []);

    // One node per device, with a source per metric. A device publishing power, energy, current and
    const byDevice = new Map<string, any[]>();
    take.forEach(r => {
      const key = nodeIdFor(r);
      if (!byDevice.has(key)) byDevice.set(key, []);
      byDevice.get(key)!.push(r);
    });

    let added = 0, extended = 0;
    byDevice.forEach((readings, deviceId) => {
      let id = deviceId;
      const sources = readings.map(r => ({
        Type: 'mqtt', Topic: r.topic, Metric: r.metric,
        // 'lifetime': the daily figure is derived from it, and a counter that resets is handled by the
        Accumulation: r.metric === 'energy' ? 'lifetime' : undefined,
        Unit: r.unit || undefined,
        JsonField: r.jsonField || undefined,
      }));
      readings.forEach(r => boundTopics.add(r.topic));

      // A second pass over the same device adds its remaining readings to the node already there. The node
      const deviceTopics = new Set(found.filter((f: any) => nodeIdFor(f) === id).map((f: any) => f.topic));
      let existing = nodes.find((n: any) => n.Id === id);
      if (existing && !(existing.Sources || []).some((src: any) => deviceTopics.has(src.Topic))) {
        // Same id, different thing. Take the next free id rather than merging or overwriting.
        let free = id, i = 2;
        while (nodes.some((n: any) => n.Id === free)) free = `${id}_${i++}`;
        toast(`A node named '${id}' already exists and is something else — imported as '${free}'.`, false);
        id = free;
        existing = undefined;
      }
      if (existing) {
        ensure(existing, 'Sources', []).push(...sources);
        extended++;
        return;
      }

      const node: any = {
        Id: id,
        Label: readings[0].device || id,
        // 'none': an imported node is valued by its own bindings. 'auto' would aggregate children it does
        Mode: 'none',
        Sources: sources,
      };
      if (tag) node.Tags = [tag];
      nodes.push(node);
      added++;
      // One link per node, in the direction chosen. 'drawn from' makes the node a child of the target,
      if (feedSel.value) {
        ensure(flow, 'Links', []).push(dirSel.value === 'source'
          ? { From: id, To: feedSel.value }
          : { From: feedSel.value, To: id });
      }
    });

    const parts = [added ? `${added} node(s)` : '', extended ? `${extended} extended` : ''].filter(Boolean);
    toast(`Added ${parts.join(', ')} from ${take.length} reading(s). Press Save to write them to the config.`, true);
    picked.clear();
    rerender();
  };

  return panel;
}

/// Its own page under Integrations -> MQTT (#342 follow-on). It reads the broker rather than the PDU and

export function addMqttImportSection(nav: any, sections: any) {
  const link = navLink(nav, 'MQTT Import', '⇤');
  // Adding nodes edits the shared EnergyFlow document, so this page carries its unsaved-edit count.
  link.dataset.section = 'EnergyFlow';
  const sec = document.createElement('div'); sec.className = 'section'; sections.appendChild(sec);
  sec.appendChild(el('h2', { text: 'MQTT Import' }));
  sec.appendChild(el('div', {
    class: 'desc',
    text: 'Add energy-flow nodes from readings other integrations already publish to this broker — by their '
        + 'Home Assistant discovery where they announce it, or by topic shape where they do not.',
  }));

  const host = el('div');
  sec.appendChild(host);

  const render = () => {
    const flow = ensure(state.data, 'EnergyFlow', {});
    migrateEnergyFlow(flow);
    const nodes = ensure(flow, 'Nodes', []);
    host.innerHTML = '';
    host.appendChild(renderDiscoverPanel(flow, render));
    const bar = el('div', { class: 'ld-toolbar' });
    const save = btn('Save', 'primary');
    save.onclick = () => saveConfig(() => render());
    bar.appendChild(save);
    host.appendChild(bar);
  };

  link.onclick = () => { render(); activate(link, sec); };
  return { link, sec };
}
