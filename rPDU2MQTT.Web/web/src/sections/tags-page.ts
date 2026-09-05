// Tags (#424): define them, see what carries them, and see what they decide.
//
// A tag is the only thing in this config that means nothing on its own — it matters because a destination
// filter names it. So the page has to answer both halves at once: what wears this tag, and what does
// wearing it do. Buried at the bottom of the Nodes page it answered neither, and a tag could not exist
// until something already carried it, so a filter could never be set up ahead of the nodes it selects.
import { btn, el, activate, navLink, ensure } from '../helpers.js';
import { state } from '../state.js';
import { refreshDirty } from '../dirty.js';
import { knownTags, tagUsage, tagDescription, declaredTags, declareTag, renameTag, removeTag } from '../tags.js';

export function addTagsSection(nav: any, sections: any) {
  const link = navLink(nav, 'Tags', '#');
  const sec = el('div', { class: 'section' });
  sections.appendChild(sec);

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

  link.onclick = () => { render(); activate(link, sec); };
  render();
}
