// Panel Types page: PV module datasheets, stored in Plugins.tigo.PanelTypes and assigned on Solar Array.
let btn     , el     , ensure     , state     , refreshDirty     , saveConfig     ;

/// [field, label, unit, step]
const PT_FIELDS                                     = [
  ['Watts', 'Pmax', 'W', '1'],
  ['Voc', 'Voc', 'V', '0.01'],
  ['Isc', 'Isc', 'A', '0.01'],
  ['Vmp', 'Vmp', 'V', '0.01'],
  ['Imp', 'Imp', 'A', '0.01'],
  ['TempCoeffVoc', 'Voc temp. coeff.', '%/°C', '0.01'],
];

const ptTypes = ()        => ensure(ensure(ensure(state.data, 'Plugins', {}), 'tigo', {}), 'PanelTypes', []);
const ptSlug = (s        ) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'panel';
const ptUses = (id        ) => (state.data?.EnergyFlow?.Nodes || []).filter((n     ) =>
  (n.Sources || []).some((s     ) => (s.Type || '').toLowerCase() === 'tigo' && s.Settings?.PanelType === id)).length;

function mount(sec     , host     ) {
  ({ btn, el, ensure, state, refreshDirty, saveConfig } = host);

  const add = btn('+ Add type');
  const save = btn('Save', 'primary');
  sec.append(
    el('div', { class: 'pt-head' }, el('h2', { text: 'Panel Types' }), add, save),
    el('div', { class: 'desc', text: 'Datasheet values at STC. Assign a type to panels on the Solar Array page (Edit).' }));
  const list = el('div', { class: 'pt-list' });
  sec.appendChild(list);
  const changed = () => { refreshDirty(); render(); };

  add.onclick = () => {
    const types = ptTypes();
    let id = 'panel';
    for (let n = 2; types.some(t => t.Id === id); n++) id = `panel-${n}`;
    types.push({ Id: id, Manufacturer: '', Model: '' });
    changed();
  };
  save.onclick = () => saveConfig(() => render());

  const render = () => {
    list.innerHTML = '';
    const types        = state.data?.Plugins?.tigo?.PanelTypes || [];
    if (!types.length) { list.appendChild(el('div', { class: 'sa-note', text: 'No panel types yet.' })); return; }
    types.forEach((t, i) => {
      const card = el('div', { class: 'pt-card' });
      const text = (field        , label        ) => {
        const input = el('input', { type: 'text', value: t[field] || '' })                    ;
        input.onchange = () => {
          t[field] = input.value.trim();
          const used = ptUses(t.Id);
          if (!used && (t.Manufacturer || t.Model)) {
            let id = ptSlug(`${t.Manufacturer} ${t.Model}`);
            for (let n = 2; types.some((o, j) => j !== i && o.Id === id); n++) id = `${ptSlug(`${t.Manufacturer} ${t.Model}`)}-${n}`;
            t.Id = id;
          }
          changed();
        };
        return el('label', { class: 'pt-field' }, el('span', { text: label }), input);
      };
      const num = ([field, label, unit, step]                                  ) => {
        const input = el('input', { type: 'number', step, value: t[field] ?? '' })                    ;
        input.onchange = () => { const v = parseFloat(input.value); if (Number.isFinite(v)) t[field] = v; else delete t[field]; changed(); };
        return el('label', { class: 'pt-field' }, el('span', { text: `${label} (${unit})` }), input);
      };
      const used = ptUses(t.Id);
      const remove = btn('Remove', 'danger');
      remove.disabled = used > 0;
      remove.title = used ? `Assigned to ${used} panel(s)` : 'Remove this type';
      remove.onclick = () => { types.splice(i, 1); changed(); };
      card.append(
        el('div', { class: 'pt-card-head' },
          el('strong', { text: [t.Manufacturer, t.Model].filter(Boolean).join(' ') || 'New type' }),
          el('span', { class: 'pt-uses', text: used ? `${used} panel${used === 1 ? '' : 's'}` : 'unused' }), remove),
        el('div', { class: 'pt-grid' }, text('Manufacturer', 'Manufacturer'), text('Model', 'Model'), ...PT_FIELDS.map(num)));
      list.appendChild(card);
    });
  };

  render();
  return { show: render };
}
return mount;
