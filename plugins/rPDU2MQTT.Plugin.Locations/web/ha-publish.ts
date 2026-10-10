// Publish to Home Assistant: preview the plan, then apply it.

const HA_WORDS: Record<string, string> = { create: 'create', rename: 'rename', link: 'link', ok: 'no change', set: 'set', keep: 'left alone', skip: 'skipped' };

/// `call` posts an action with what is on screen; `onLinked` records the links apply made.
export function haPublishSheet(call: (action: string) => Promise<any>, onLinked: (rooms: Record<string, string>, floors: Record<string, string>) => void) {
  const body = el('div', { class: 'ha-sheet' });
  body.appendChild(el('div', { class: 'desc', text: 'Reading Home Assistant…' }));
  openSheet({ title: 'Publish to Home Assistant', body, wide: true });
  (async () => {
    const r: any = await call('areas-preview').catch((e: any) => ({ body: { ok: false, message: e?.message } }));
    body.innerHTML = '';
    if (!r.body?.ok) { body.appendChild(el('div', { class: 'desc', text: `${r.body?.message || 'Could not reach Home Assistant.'} Set the URL and token under Home Assistant.` })); return; }
    const plan = r.body.plan;
    const table = (title: string, rows: any[], cells: (x: any) => string[]) => {
      if (!rows?.length) return;
      body.appendChild(el('h4', { text: title }));
      const t = el('div', { class: 'ha-plan' });
      rows.forEach(x => t.appendChild(el('div', { class: 'ha-row is-' + x.action }, ...cells(x).map(c => el('span', { text: c })))));
      body.appendChild(t);
    };
    table('Floors', plan.floors, (x: any) => [x.name, HA_WORDS[x.action] || x.action, x.why]);
    table('Rooms', plan.rooms, (x: any) => [x.name, HA_WORDS[x.action] || x.action, x.why]);
    table('Area settings', plan.fields, (x: any) => [`${x.name} · ${x.field}`, HA_WORDS[x.action] || x.action, x.why]);
    table('Devices', plan.devices, (x: any) => [x.deviceName, HA_WORDS[x.action] || x.action, x.why]);
    if (plan.leftAlone?.length) body.appendChild(el('div', { class: 'desc', text: `Left alone: ${plan.leftAlone.map((a: any) => a.name).join(', ')}.` }));
    if (!plan.rooms.length) body.appendChild(el('div', { class: 'desc', text: 'No rooms yet.' }));
    const writes = (rows: any[], acts: string[]) => (rows || []).filter((x: any) => acts.includes(x.action)).length;
    const changes = writes(plan.floors, ['create', 'rename', 'link']) + writes(plan.rooms, ['create', 'rename', 'link'])
      + writes(plan.fields, ['set']) + writes(plan.devices, ['set']);
    const go = btn(changes ? `Apply ${changes} change${changes > 1 ? 's' : ''}` : 'Nothing to change', 'primary');
    go.disabled = !changes;
    go.onclick = async () => {
      go.disabled = true;
      const a: any = await call('areas-apply').catch((e: any) => ({ body: { ok: false, message: e?.message } }));
      const rooms = a.body?.linked || {}, floors = a.body?.linkedFloors || {};
      const any = Object.keys(rooms).length + Object.keys(floors).length > 0;
      if (any) onLinked(rooms, floors);
      closeSheet();
      toast((a.body?.message || 'Done.') + (any ? ' Save to keep the links.' : ''), !!a.body?.ok);
    };
    body.appendChild(el('div', { class: 'ha-actions' }, go));
  })();
}
