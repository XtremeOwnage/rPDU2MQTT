// Home Assistant Energy Mapping (#128): the EnergyDashboard settings + manual sync/clear actions.
import { api, btn, el, ensure, activate, toast, navLink } from '../helpers.js';
import { state } from '../state.js';

export function addHaEnergySection(nav: any, sections: any) {
  const link = navLink(nav, "HA Energy Mapping", "▮");
  const sec = document.createElement('div'); sec.className = 'section'; sections.appendChild(sec);
  const h = document.createElement('h2'); h.textContent = 'Home Assistant Energy Mapping'; sec.appendChild(h);
  const d = document.createElement('div'); d.className = 'desc';
  d.textContent = 'Map the energy-flow hierarchy into Home Assistant’s Energy Dashboard (individual devices + their upstream device). Each tier is published to HA as an Energy sensor by the flow export, so enable “Export tiers to MQTT” (Energy Flow → Settings) and HA discovery for the full Grid → Panel → Circuit → PDU → outlet chain to appear. Settings persist with the main Save button; the buttons act immediately using the values below.';
  sec.appendChild(d);

  const ha = ensure(ensure(state.data, 'HomeAssistant', {}), 'EnergyDashboard', {});

  const field = (label: string, key: string, type = 'text', placeholder = '') => {
    const f = el('div', { class: 'field' });
    f.appendChild(el('label', { text: label }));
    const inp: any = el('input', { type, placeholder });
    if (ha[key] != null) inp.value = ha[key];
    inp.onchange = () => { ha[key] = inp.value === '' ? null : inp.value; };
    f.appendChild(inp);
    return { f, inp };
  };
  const url = field('Home Assistant URL', 'Url', 'text', 'http://homeassistant.local:8123');
  const token = field('Long-lived access token', 'Token', 'password', '');
  const etype = field('Energy measurement type', 'EnergyMeasurementType', 'text', 'energy');

  const chkF = el('div', { class: 'field' });
  const chk: any = el('input', { type: 'checkbox' }); chk.checked = !!ha.Enabled;
  chk.onchange = () => { ha.Enabled = chk.checked; };
  chkF.appendChild(el('label', { style: { fontWeight: '600' } }, chk, ' Enable periodic sync'));
  chkF.appendChild(el('div', { class: 'desc', text: 'Re-push the hierarchy automatically every few polls while enabled.' }));

  const grid = el('div', { class: 'grid' });
  grid.append(url.f, token.f, etype.f, chkF);
  sec.appendChild(grid);

  // What the export filter leaves out. Sync pushes what the MQTT export publishes, so a node the filter
  // drops never becomes an HA sensor and cannot be mapped — which on this page looked like the sync
  // quietly missing things, with nothing here even naming the filter.
  const filterBox = el('div', { style: { margin: '14px 0' } });
  const drawFilter = () => {
    filterBox.innerHTML = '';
    const flow = (state.data && state.data.EnergyFlow) || {};
    const f = flow.MqttExportTags || {};
    const inc: string[] = f.Include || [];
    const exc: string[] = f.Exclude || [];
    const nodes: any[] = flow.Nodes || [];

    const goSettings = () => (document.querySelector('nav a[data-label="Settings"]') as any)?.click();

    if (!inc.length && !exc.length) {
      filterBox.appendChild(el('div', { class: 'desc' },
        el('span', { text: 'Every node is exported — no tag filter is set. ' }),
        el('a', { text: 'Energy Flow → Settings', onclick: goSettings }),
        el('span', { text: ' can narrow it.' })));
      return;
    }

    // An untagged node fails a populated include list; a node carrying an excluded tag is always out.
    const tagsOf = (n: any): string[] => n.Tags || [];
    const dropped = nodes.filter(n => {
      const t = tagsOf(n).map((x: string) => String(x).trim().toLowerCase());
      if (exc.some(e => t.includes(String(e).trim().toLowerCase()))) return true;
      return inc.length > 0 && !inc.some(i => t.includes(String(i).trim().toLowerCase()));
    });

    filterBox.appendChild(el('h3', { text: 'What the export filter leaves out', style: { margin: '4px 0', fontSize: '15px' } }));
    const line = el('div', { class: 'desc' });
    if (inc.length) line.appendChild(el('span', { text: `Only nodes tagged ${inc.join(', ')} are exported. ` }));
    if (exc.length) line.appendChild(el('span', { text: `Nodes tagged ${exc.join(', ')} are never exported. ` }));
    line.appendChild(el('a', { text: 'Change it', onclick: goSettings }));
    filterBox.appendChild(line);

    if (!dropped.length) {
      filterBox.appendChild(el('div', { class: 'desc', text: 'No configured node is currently excluded.' }));
    } else {
      filterBox.appendChild(el('div', { class: 'ov-note warn', style: { marginTop: '8px' } },
        el('span', { class: 'ov-alert-icon', text: '⚠' }),
        el('div', {},
          el('div', { class: 'ov-alert-title', text: `${dropped.length} node${dropped.length === 1 ? '' : 's'} will not reach Home Assistant` }),
          el('div', { class: 'desc', text: 'They publish no MQTT sensor, so Sync cannot map them and any entity they '
                                         + 'already created in Home Assistant is retired.' }),
          el('div', { style: { marginTop: '6px' } },
            ...dropped.map((n: any) => el('div', { class: 'desc', style: { margin: '1px 0' },
              text: `${n.Label || n.Id}  (${n.Id})${(n.Tags || []).length ? '  · ' + (n.Tags || []).join(', ') : '  · untagged'}` }))))));
    }

    // Derived PDU/outlet nodes carry no Tags of their own; their tags come from rules.
    const rules: any[] = flow.AutoTags || [];
    if (rules.length)
      filterBox.appendChild(el('div', { class: 'desc', style: { marginTop: '6px' },
        text: `${rules.length} auto-tag rule${rules.length === 1 ? '' : 's'} also tag PDUs and outlets, so the filter `
            + 'applies to them too — they are not listed here because they come from what the bridge polls.' }));
  };
  drawFilter();
  sec.appendChild(filterBox);

  const bar = el('div', { class: 'sec-actions' });
  const syncBtn = btn('Sync now', 'primary');
  const clearBtn = btn('Clear energy dashboard', 'danger');
  bar.append(syncBtn, clearBtn); sec.appendChild(bar);
  sec.appendChild(el('div', { class: 'desc', text: 'Also Save (main button) so the periodic sync uses these settings.' }));

  syncBtn.onclick = async () => {
    toast('Syncing to Home Assistant…', true);
    const r = await api('/api/ha-energy/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: url.inp.value.trim(), token: token.inp.value, energyMeasurementType: etype.inp.value.trim() }) });
    toast(r.body.message || (r.ok ? 'Done.' : 'Failed.'), r.ok && r.body.ok);
  };
  clearBtn.onclick = async () => {
    if (!confirm('Clear ALL devices from Home Assistant’s Energy Dashboard?\n\nThis removes every entry in the dashboard’s device list — including any you added manually. You can re-add the hierarchy with “Sync now”.')) return;
    toast('Clearing the Energy Dashboard…', true);
    const r = await api('/api/ha-energy/clear', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: url.inp.value.trim(), token: token.inp.value }) });
    toast(r.body.message || (r.ok ? 'Done.' : 'Failed.'), r.ok && r.body.ok);
  };
  link.onclick = () => activate(link, sec);
}
