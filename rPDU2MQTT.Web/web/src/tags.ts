// The one place tags are spelled. Every tag in the document, a chip editor that completes from that list,
// and the rename/remove that keeps every reference in step.
//
// Tags are free-form on purpose (#342), but a filter that names a tag nothing carries silently sends
// nothing — and a typo in an exclude list is indistinguishable from a working one. So a tag is typed once,
// where it is defined, and chosen from a list everywhere it is referenced.
import { el, btn } from './helpers.js';
import { state } from './state.js';
import { refreshDirty } from './dirty.js';

/// Where a tag can be defined: on a node, or on a rule that tags derived PDUs/outlets.
function tagHolders(): { list: () => string[] | undefined, set: (v: string[]) => void, what: string, name: string }[] {
  const flow = (state.data || {}).EnergyFlow || {};
  const out: any[] = [];
  (flow.Nodes || []).forEach((n: any) => out.push({
    list: () => n.Tags, set: (v: string[]) => { n.Tags = v.length ? v : undefined; },
    what: 'node', name: n.Label || n.Id || '(unnamed)',
  }));
  (flow.AutoTags || []).forEach((r: any) => out.push({
    list: () => r.Tags, set: (v: string[]) => { r.Tags = v; },
    what: 'rule', name: r.Match || '(empty match)',
  }));
  return out;
}

/// Where a tag is only referred to — the per-destination filters. Renaming has to reach these too, or a
/// rename quietly turns a working filter into one that matches nothing.
function tagReferences(): { list: () => string[] | undefined, set: (v: string[]) => void, where: string }[] {
  const d = state.data || {};
  const filters: [any, string][] = [
    [(d.Prometheus || {}).NodeTags, 'Prometheus'],
    [(d.EmonCMS || {}).NodeTags, 'EmonCMS'],
    [(d.EnergyFlow || {}).MqttExportTags, 'MQTT export'],
    [((d.HomeAssistant || {}).EnergyDashboard || {}).NodeTags, 'HA Energy Dashboard'],
  ];
  const out: any[] = [];
  filters.forEach(([f, where]) => {
    if (!f) return;
    out.push({ list: () => f.Include, set: (v: string[]) => { f.Include = v; }, where: where + ' include' });
    out.push({ list: () => f.Exclude, set: (v: string[]) => { f.Exclude = v; }, where: where + ' exclude' });
  });
  return out;
}

/// Every tag the document defines, in a stable order.
export function knownTags(): string[] {
  const seen = new Map<string, string>();
  tagHolders().forEach(h => (h.list() || []).forEach(t => {
    const k = String(t || '').trim();
    if (k && !seen.has(k.toLowerCase())) seen.set(k.toLowerCase(), k);
  }));
  return [...seen.values()].sort((a, b) => a.localeCompare(b));
}

/// How many things carry a tag, and what they are.
export function tagUsage(tag: string): { holders: string[], references: string[] } {
  const same = (t: string) => t.trim().toLowerCase() === tag.trim().toLowerCase();
  return {
    holders: tagHolders().filter(h => (h.list() || []).some(same)).map(h => `${h.what}: ${h.name}`),
    references: tagReferences().filter(r => (r.list() || []).some(same)).map(r => r.where),
  };
}

/// Rename a tag everywhere it appears — definitions and filters alike.
export function renameTag(from: string, to: string) {
  const same = (t: string) => t.trim().toLowerCase() === from.trim().toLowerCase();
  const swap = (v: string[] | undefined) => {
    if (!v) return undefined;
    const out: string[] = [];
    v.forEach(t => { const next = same(t) ? to.trim() : t; if (next && !out.some(x => x.toLowerCase() === next.toLowerCase())) out.push(next); });
    return out;
  };
  [...tagHolders(), ...tagReferences()].forEach((h: any) => {
    const current = h.list();
    if (!current || !current.some(same)) return;
    h.set(swap(current) || []);
  });
}

/// Remove a tag from everything that carries or names it.
export function removeTag(tag: string) {
  const same = (t: string) => t.trim().toLowerCase() === tag.trim().toLowerCase();
  [...tagHolders(), ...tagReferences()].forEach((h: any) => {
    const current = h.list();
    if (!current || !current.some(same)) return;
    h.set(current.filter((t: string) => !same(t)));
  });
}

// The shared <datalist> every free-entry tag box completes from. One element, rebuilt whenever the set of
// tags changes, so a tag defined on the Nodes page is offered on every other page without a reload.
const DATALIST_ID = 'rpdu-known-tags';
export function syncTagDatalist() {
  let dl: any = document.getElementById(DATALIST_ID);
  if (!dl) {
    dl = el('datalist', { id: DATALIST_ID });
    document.body.appendChild(dl);
  }
  dl.innerHTML = '';
  knownTags().forEach(t => dl.appendChild(el('option', { value: t })));
  return dl;
}

export interface TagInputOptions {
  /// Only offer tags that already exist — for the filter fields, where a typo means "matches nothing".
  strict?: boolean;
  /// Called after every edit, so a caller can redraw whatever the tags feed.
  onChange?: () => void;
  placeholder?: string;
}

/// A chip editor for a list of tags: the tags themselves, each removable, and one control to add another.
/// `arr` is edited in place, so the caller's config object is always current.
export function tagInput(arr: string[], opts: TagInputOptions = {}): HTMLElement {
  const wrap = el('div', { class: 'tag-input' });
  const changed = () => { syncTagDatalist(); refreshDirty(); opts.onChange?.(); draw(); };

  const add = (raw: string) => {
    const t = (raw || '').trim();
    if (!t) return false;
    if (arr.some(x => String(x).trim().toLowerCase() === t.toLowerCase())) return true;   // already there
    arr.push(t);
    changed();
    return true;
  };

  const draw = () => {
    wrap.innerHTML = '';
    arr.forEach((t, i) => {
      const chip = el('span', { class: 'tag-chip' }, el('span', { text: String(t) }));
      const x = el('button', { class: 'tag-x', title: `Remove “${t}”`, text: '✕' });
      x.onclick = () => { arr.splice(i, 1); changed(); };
      chip.appendChild(x);
      // A filter naming a tag nothing defines matches nothing — worth seeing at a glance, not at 2am.
      if (opts.strict && !knownTags().some(k => k.toLowerCase() === String(t).trim().toLowerCase())) {
        chip.classList.add('tag-unknown');
        chip.title = `No node or rule carries “${t}”, so this line does nothing.`;
      }
      wrap.appendChild(chip);
    });

    const known = knownTags().filter(k => !arr.some(x => String(x).trim().toLowerCase() === k.toLowerCase()));

    if (opts.strict) {
      // Chosen, never typed: the whole point of the strict form.
      if (!known.length) {
        wrap.appendChild(el('span', {
          class: 'desc', style: { margin: '0' },
          text: arr.length ? 'every tag is already listed' : 'no tags defined yet — tag a node or add a rule on the Nodes page',
        }));
        return;
      }
      const sel = el('select', { class: 'tag-pick' }) as HTMLSelectElement;
      sel.appendChild(el('option', { value: '', text: '+ add tag…' }));
      known.forEach(k => sel.appendChild(el('option', { value: k, text: k })));
      sel.onchange = () => { if (sel.value) add(sel.value); };
      wrap.appendChild(sel);
      return;
    }

    // Free entry, completing from the tags that already exist — this is where a tag is born.
    syncTagDatalist();
    // A datalist completes what you type and shows nothing until you do, so a tag already in use looks
    // like it has to be retyped from memory — and a second spelling of an existing tag is a filter that
    // silently matches nothing. The existing ones are offered outright, beside the box that invents new.
    if (known.length) {
      const pick = el('select', { class: 'tag-pick' }) as HTMLSelectElement;
      pick.appendChild(el('option', { value: '', text: `existing (${known.length})…` }));
      known.forEach(k => pick.appendChild(el('option', { value: k, text: k })));
      pick.onchange = () => { if (pick.value) add(pick.value); };
      wrap.appendChild(pick);
    }
    const input = el('input', {
      type: 'text', class: 'tag-new', placeholder: opts.placeholder || 'add tag…', list: DATALIST_ID,
    }) as HTMLInputElement;
    input.onkeydown = (ev: any) => {
      if (ev.key !== 'Enter' && ev.key !== ',' && ev.key !== 'Tab') return;
      if (ev.key === 'Tab' && !input.value.trim()) return;   // let Tab move on when there's nothing to commit
      ev.preventDefault();
      if (add(input.value)) input.value = '';
      // Redrawing replaced this element, so put the cursor back where it was.
      (wrap.querySelector('.tag-new') as HTMLInputElement)?.focus();
    };
    // Committing on blur too: typing a tag and clicking Save should not lose it.
    input.onblur = () => { if (input.value.trim()) { add(input.value); input.value = ''; } };
    wrap.appendChild(input);
  };

  draw();
  return wrap;
}

/// The "every tag, and what carries it" panel: rename or retire a tag across the whole config in one place.
export function renderTagManager(rerender: () => void): HTMLElement {
  const box = el('div', { style: { margin: '18px 0' } });
  box.appendChild(el('h3', { text: 'Tags in use', style: { margin: '4px 0', fontSize: '15px' } }));
  box.appendChild(el('div', {
    class: 'desc',
    text: 'Every tag this configuration defines, and what carries it. Renaming one here rewrites it on every '
        + 'node, every rule and every destination filter at once — which is the only way a rename does not '
        + 'quietly turn a working filter into one that matches nothing.',
  }));

  const tags = knownTags();
  if (!tags.length) {
    box.appendChild(el('div', { class: 'desc', style: { marginTop: '8px' }, text: 'No tags yet. Add one to a node below, or to a rule for PDUs and outlets.' }));
    return box;
  }

  const t = el('table', { class: 'ld' });
  const head = el('tr');
  ['Tag', 'Carried by', 'Filtered on', ''].forEach(h => head.appendChild(el('th', { text: h })));
  t.appendChild(el('thead', {}, head));
  const tb = el('tbody');

  tags.forEach(tag => {
    const use = tagUsage(tag);
    const tr = el('tr');

    const name = el('input', { type: 'text', value: tag }) as HTMLInputElement;
    name.onchange = () => {
      const next = name.value.trim();
      if (!next || next === tag) { name.value = tag; return; }
      renameTag(tag, next);
      refreshDirty(); rerender();
    };
    tr.appendChild(el('td', {}, name));

    tr.appendChild(el('td', {}, el('span', {
      class: 'desc', style: { margin: '0' },
      text: `${use.holders.length} node(s)/rule(s)`,
      title: use.holders.join('\n') || 'nothing',
    })));

    tr.appendChild(el('td', {}, el('span', {
      class: 'desc', style: { margin: '0' },
      text: use.references.length ? use.references.join(', ') : '—',
      title: use.references.length ? 'Destinations whose filter names this tag.' : 'No destination filter names this tag.',
    })));

    const del = btn('Remove', 'danger');
    del.title = 'Take this tag off everything that carries it, and out of every filter that names it.';
    del.onclick = () => { removeTag(tag); refreshDirty(); rerender(); };
    tr.appendChild(el('td', {}, del));
    tb.appendChild(tr);
  });

  t.appendChild(tb);
  box.appendChild(t);
  return box;
}
