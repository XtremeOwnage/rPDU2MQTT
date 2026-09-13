// Tags (#424): define them, see what carries them, and see what they decide.
//
// A tag is the only thing in this config that means nothing on its own — it matters because a destination
// filter names it. So the page has to answer both halves at once: what wears this tag, and what does
// wearing it do. Buried at the bottom of the Nodes page it answered neither, and a tag could not exist
// until something already carried it, so a filter could never be set up ahead of the nodes it selects.
import { api, btn, el, activate, navLink, ensure } from '../helpers.js';
import { state } from '../state.js';
import { refreshDirty } from '../dirty.js';
import { knownTags, tagUsage, tagDescription, declaredTags, declareTag, renameTag, removeTag, tagInput } from '../tags.js';

export function addTagsSection(nav: any, sections: any) {
  const link = navLink(nav, 'Tags', '#');
  const sec = el('div', { class: 'section' });
  sections.appendChild(sec);
  // The live graph, for the PDUs and outlets the bridge has discovered.
  let graph: any = null;

  // A tag box for the rule whose pattern is exactly `match`; the rule exists only while it carries a tag.
  const ruleTags = (match: string) => {
    const rules = () => ensure(ensure(state.data, 'EnergyFlow', {}), 'AutoTags', []);
    const find = () => rules().find((x: any) => String(x.Match || '').trim().toLowerCase() === match.toLowerCase());
    const arr: string[] = [...(find()?.Tags || [])];
    return tagInput(arr, {
      placeholder: 'add tag',
      onChange: () => {
        const list = rules();
        const rule = find();
        if (!arr.length) { if (rule) list.splice(list.indexOf(rule), 1); }
        else if (rule) rule.Tags = [...arr];
        else list.push({ Match: match, Tags: [...arr] });
        refreshDirty();
      },
    });
  };

  const pduTags = () => {
    const box = el('div', { style: { margin: '18px 0' } });
    box.appendChild(el('h3', { text: 'PDU tags', style: { margin: '4px 0', fontSize: '15px' } }));
    box.appendChild(el('div', { class: 'desc', text:
      'Tags for what the PDUs report. Every PDU and every outlet can carry default tags, and each one its own '
      + 'on top of them. Patterns covering part of a PDU are on the Nodes page. Circuits are not nodes in the '
      + 'energy flow, so they cannot carry tags yet.' }));

    const defaults = el('table', { class: 'ld' });
    defaults.appendChild(el('thead', {}, el('tr', {}, el('th', { text: 'Applies to' }), el('th', { text: 'Default tags' }))));
    const dbody = el('tbody');
    ([['All PDUs', 'pdu:*'], ['All outlets', 'outlet:*']] as [string, string][]).forEach(([name, match]) =>
      dbody.appendChild(el('tr', { 'data-match': match }, el('td', { text: name }), el('td', {}, ruleTags(match)))));
    defaults.appendChild(dbody);
    box.appendChild(defaults);

    const derived = (graph?.nodes || [])
      .filter((n: any) => /^(pdu|outlet):/.test(String(n.id || '')))
      .sort((a: any, b: any) => String(a.id).localeCompare(String(b.id), undefined, { numeric: true }));
    if (!derived.length) {
      box.appendChild(el('div', { class: 'desc', style: { marginTop: '8px' },
        text: 'No PDU or outlet has been reported yet, so there is nothing to tag individually.' }));
      return box;
    }
    const items = el('table', { class: 'ld', style: { marginTop: '10px' } });
    items.appendChild(el('thead', {}, el('tr', {}, el('th', { text: 'PDU or outlet' }), el('th', { text: 'Id' }), el('th', { text: 'Its own tags' }))));
    const ibody = el('tbody');
    derived.forEach((n: any) => ibody.appendChild(el('tr', { 'data-match': n.id },
      el('td', { text: n.label || n.id }), el('td', { class: 'desc', text: n.id }), el('td', {}, ruleTags(n.id)))));
    items.appendChild(ibody);
    box.appendChild(items);
    return box;
  };

  const render = () => {
    sec.innerHTML = '';
    sec.appendChild(el('h2', { text: 'Tags' }));
    sec.appendChild(el('div', {
      class: 'desc',
      text: 'A tag does nothing by itself — it matters because a destination filter names it. Below: every '
          + 'tag, what carries it, and which destinations decide on it. Renaming one here rewrites it on '
          + 'every node, rule and filter at once, which is the only way a rename does not quietly turn a '
          + 'working filter into one that matches nothing.',
    }));

    // --- Define one -----------------------------------------------------------------------------------
    const addBar = el('div', { class: 'ld-toolbar' });
    const name = el('input', { type: 'text', placeholder: 'tag name' }) as HTMLInputElement;
    const desc = el('input', { type: 'text', placeholder: 'what it is for (optional)', style: { minWidth: '280px' } }) as HTMLInputElement;
    const add = btn('Define tag', 'primary');
    const say = el('span', { class: 'desc', style: { margin: '0' } });
    const commit = () => {
      const n = name.value.trim();
      if (!n) return;
      if (!declareTag(n, desc.value.trim())) { say.textContent = `“${n}” already exists.`; return; }
      name.value = ''; desc.value = ''; say.textContent = '';
      refreshDirty(); render();
    };
    add.onclick = commit;
    name.onkeydown = (ev: any) => { if (ev.key === 'Enter') { ev.preventDefault(); commit(); } };
    desc.onkeydown = (ev: any) => { if (ev.key === 'Enter') { ev.preventDefault(); commit(); } };
    addBar.append(name, desc, add, say);
    sec.appendChild(addBar);
    sec.appendChild(el('div', { class: 'desc', text:
      'A tag defined here exists before anything carries it, so a filter can be set up ahead of the nodes '
      + 'it will select. Typing one straight onto a node still works and still appears below.' }));

    sec.appendChild(pduTags());

    const tags = knownTags();
    if (!tags.length) {
      sec.appendChild(el('div', { class: 'desc', style: { marginTop: '12px' },
        text: 'No tags yet. Define one above, or add one to a node on the Nodes page.' }));
      return;
    }

    // --- What exists, what carries it, what decides on it ----------------------------------------------
    const t = el('table', { class: 'ld' });
    const head = el('tr');
    ['Tag', 'What it is for', 'Carried by', 'Destinations that decide on it', ''].forEach(h =>
      head.appendChild(el('th', { text: h })));
    t.appendChild(el('thead', {}, head));
    const tb = el('tbody');

    const declared = declaredTags().map(d => String(d.Name).trim().toLowerCase());

    tags.forEach(tag => {
      const use = tagUsage(tag);
      const tr = el('tr');

      const nm = el('input', { type: 'text', value: tag }) as HTMLInputElement;
      nm.onchange = () => {
        const next = nm.value.trim();
        if (!next || next === tag) { nm.value = tag; return; }
        renameTag(tag, next);
        refreshDirty(); render();
      };
      const nameCell = el('td', {}, nm);
      // A tag nothing declared still works; saying so is how you tell a deliberate vocabulary from a typo
      // that has quietly become part of the config.
      if (!declared.includes(tag.toLowerCase()))
        nameCell.appendChild(el('div', { class: 'desc', style: { margin: '0' }, text: 'not declared — in use only' }));
      tr.appendChild(nameCell);

      const dsc = el('input', { type: 'text', value: tagDescription(tag), placeholder: '—' }) as HTMLInputElement;
      dsc.onchange = () => {
        const flow = ensure(state.data, 'EnergyFlow', {});
        const list = ensure(flow, 'Tags', []);
        const found = list.find((x: any) => String(x.Name || '').trim().toLowerCase() === tag.toLowerCase());
        if (found) found.Description = dsc.value.trim();
        else list.push({ Name: tag, Description: dsc.value.trim() });
        refreshDirty(); render();
      };
      tr.appendChild(el('td', {}, dsc));

      // Named, not counted: "3 node(s)/rule(s)" in a tooltip is the answer you have to go looking for.
      const carried = el('td');
      if (!use.holders.length) {
        carried.appendChild(el('span', { class: 'desc', style: { margin: '0' }, text: 'nothing yet' }));
      } else {
        use.holders.slice(0, 6).forEach(h =>
          carried.appendChild(el('div', { class: 'desc', style: { margin: '0' }, text: h })));
        if (use.holders.length > 6)
          carried.appendChild(el('div', { class: 'desc', style: { margin: '0' },
            text: `…and ${use.holders.length - 6} more` }));
      }
      tr.appendChild(carried);

      const decides = el('td');
      if (!use.references.length) {
        decides.appendChild(el('span', { class: 'desc', style: { margin: '0' },
          text: 'none — this tag changes nothing' }));
      } else {
        use.references.forEach(r =>
          decides.appendChild(el('div', { class: 'desc', style: { margin: '0' }, text: r })));
      }
      tr.appendChild(decides);

      const del = btn('Remove', 'danger');
      del.title = 'Take this tag off everything that carries it, out of every filter that names it, and out '
                + 'of the declared list.';
      del.onclick = () => {
        if (use.references.length &&
            !confirm(`“${tag}” is named by ${use.references.join(', ')}.\n\nRemoving it changes what those `
                   + 'destinations send. Continue?')) return;
        removeTag(tag); refreshDirty(); render();
      };
      tr.appendChild(el('td', {}, del));
      tb.appendChild(tr);
    });

    t.appendChild(tb);
    sec.appendChild(t);
    sec.appendChild(el('div', { class: 'desc', style: { marginTop: '6px' },
      text: 'Save (main button) to apply. A tag that no destination decides on is doing nothing yet — set '
          + 'it on a destination’s Include or Exclude list to give it an effect.' }));
  };

  link.onclick = async () => {
    render(); activate(link, sec);
    try { const r: any = await api('/api/flow'); graph = r?.body?.ok ? r.body : null; } catch { graph = null; }
    render();
  };
  render();
}
