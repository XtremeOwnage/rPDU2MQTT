// Ready-made device templates: an EG4 inverter, a meter, and whatever else the server ships.
//
// Two callers — the MQTT Import page and the Nodes page's "Import device" panel — which is why this is a
// module and not a private helper of either. Instantiating a template writes real config (a Modbus
// connection, pre-wired nodes and links), so doing it two slightly different ways would produce two
// slightly different devices.
import { api, btn, el, ensure, toast } from './helpers.js';
import { state } from './state.js';

// Ready-made device templates (EG4 inverters, meters, …), fetched once and cached.
let nodeTemplatesCache: any[] | null = null;
async function loadNodeTemplates(): Promise<any[]> {
  if (nodeTemplatesCache) return nodeTemplatesCache;
  const r = await api('/api/node-templates');
  nodeTemplatesCache = (r.body?.ok && r.body.templates) ? r.body.templates : [];
  return nodeTemplatesCache;
}

// Instantiate a template into the live config: create its Modbus connection (if any) and its pre-wired
// nodes/links, all under an id prefix so the same device can be imported more than once without clashes.
function instantiateTemplate(tpl: any, prefix: string, host: string, unitId: number, flow: any): string[] {
  const nodes = ensure(flow, 'Nodes', []);
  const links = ensure(flow, 'Links', []);
  let connId: string | undefined;
  if (tpl.transport === 'modbus' && tpl.modbus) {
    const conns = ensure(ensure(state.data, 'Modbus', {}), 'Connections', []);
    connId = prefix;
    conns.push({ Id: connId, Name: tpl.name, Host: host || '', Port: tpl.modbus.port, UnitId: unitId,
      PollIntervalSeconds: tpl.modbus.pollIntervalSeconds, Framing: tpl.modbus.framing || 'tcp', Enabled: true });
  }
  const idOf = (key: string) => prefix + '-' + key;
  const added: string[] = [];
  (tpl.nodes || []).forEach((tn: any) => {
    const node: any = { Id: idOf(tn.key), Label: tn.label, Kind: tn.kind, Sources: (tn.sources || []).map((s: any) => {
      const src: any = { Type: tpl.transport, Metric: s.metric };
      if (s.unit) src.Unit = s.unit;
      if (s.scale != null && s.scale !== 1) src.Scale = s.scale;
      if (tpl.transport === 'modbus') {
        src.Connection = connId; src.Register = s.register; src.RegisterType = s.registerType;
        src.DataType = s.dataType; src.WordOrder = s.wordOrder;
      } else { if (s.topic) src.Topic = s.topic; if (s.jsonField) src.JsonField = s.jsonField; }
      return src;
    }) };
    nodes.push(node); added.push(node.Id);
    if (tn.feedsKey) links.push({ From: idOf(tn.key), To: idOf(tn.feedsKey) });
  });
  return added;
}

function renderImportPanel(flow: any, existingIds: Set<string>, rerender: () => void): HTMLElement {
  const panel = el('div', { class: 'tpl-import' });
  panel.appendChild(el('div', { class: 'desc', text: 'Import a known device to pre-fill its nodes and register bindings. Review and Save afterwards; addresses are community starting points — verify against your firmware.' }));
  const row = el('div', { class: 'ld-toolbar' });
  const sel = el('select', { style: { width: 'auto' } }) as HTMLSelectElement;
  const prefixIn = el('input', { type: 'text', placeholder: 'id prefix (e.g. eg4)' }) as HTMLInputElement;
  const hostIn = el('input', { type: 'text', placeholder: 'Modbus host / IP' }) as HTMLInputElement;
  const unitIn = el('input', { type: 'number', placeholder: 'unit', style: { width: '70px' } }) as HTMLInputElement;
  const importBtn = btn('Import', 'primary');
  const note = el('div', { class: 'desc' });
  row.append(sel, prefixIn, hostIn, unitIn, importBtn);
  panel.append(row, note);

  loadNodeTemplates().then(tpls => {
    if (!tpls.length) { note.textContent = 'No device templates available.'; return; }
    tpls.forEach((t: any) => sel.appendChild(el('option', { value: t.id, text: t.vendor + ' · ' + t.name })));
    const showMeta = () => {
      const t = tpls.find((x: any) => x.id === sel.value);
      if (!t) return;
      prefixIn.value = t.id; hostIn.style.display = t.transport === 'modbus' ? '' : 'none';
      unitIn.style.display = t.transport === 'modbus' ? '' : 'none';
      unitIn.value = t.modbus ? String(t.modbus.unitId) : '';
      note.innerHTML = '';
      note.append(el('span', { text: (t.description || '') + ' ' }));
      if (t.sourceUrl) { const a = document.createElement('a'); a.href = t.sourceUrl; a.target = '_blank'; a.textContent = 'Register source ↗'; a.style.color = 'var(--accent)'; note.appendChild(a); }
    };
    sel.onchange = showMeta; showMeta();
    importBtn.onclick = () => {
      const t = tpls.find((x: any) => x.id === sel.value); if (!t) return;
      const prefix = (prefixIn.value || '').trim(); if (!prefix) { toast('An id prefix is required.', false); return; }
      const clash = (t.nodes || []).map((n: any) => prefix + '-' + n.key).find((id: string) => existingIds.has(id));
      if (clash) { toast(`Node id '${clash}' already exists — pick a different prefix.`, false); return; }
      const added = instantiateTemplate(t, prefix, hostIn.value.trim(), parseInt(unitIn.value) || 1, flow);
      toast(`Imported ${t.name}: ${added.length} node(s). Set the Modbus host if needed, then Save.`, true);
      rerender();
    };
  });
  return panel;
}
