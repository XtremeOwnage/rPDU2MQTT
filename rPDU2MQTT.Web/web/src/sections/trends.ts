// Trends: the whole system over the chosen window — the grid, self-sufficiency, and where the energy came from.
import { el } from '../helpers.js';
import { homeEnergy, selfSufficiencyPct, sumKnown } from '../energy.js';
import { barChart, KIND_COLOR, type Line } from '../charts.js';
import { trendsPage, isReturn, signed } from './trends-shared.js';

export function addTrendsSection(nav: any, sections: any) {
  // The same figures as a table, under the charts: a number is easier to read off than a bar.
  const tableBox = el('div', { class: 'trend-table-wrap' });
  const { link, sec } = trendsPage(nav, sections, {
    label: 'Trends',
    icon: '▦',
    stackable: false,
    below: () => [tableBox],
    render: (p) => {
      const body = p.body();
      if (!body?.ok) return;

      const days = p.days();
      const units = body.units || 'kWh';
      const partial: string | null = body.partial || null;
      const all: any[] = body.series || [];
      const sumOf = (list: any[]) => days.map((_, d) => sumKnown(list.map((s: any) => signed(s)[d])));
      // The series a total is made of, as the server decided: the Balance where one is set, else each node
      // of the kind that nothing else already counts — a PV total and its strings are one solar (#491).
      const ofKind = (role: string, want?: (s: any) => boolean) =>
        all.filter((s: any) => s.balance === role && (!want || want(s)));
      const byKind = (role: string) => {
        const members = ofKind(role);
        return members.length ? sumOf(members) : null;
      };
      let drawn = 0;

      // --- Grid ------------------------------------------------------------------------------------
      const gridSupply = ofKind('grid', (s: any) => !isReturn(s));
      const gridReturn = ofKind('grid', (s: any) => isReturn(s));
      const gridIn = byKind('grid');
      if (gridSupply.length) {
        const exports_ = gridReturn.length ? sumOf(gridReturn) : null;
        const gridLines: Line[] = [{ label: 'Import', color: KIND_COLOR.grid, values: sumOf(gridSupply) }];
        if (exports_) gridLines.push({ label: 'Export', color: '#6fb0e0', values: exports_ });
        p.section(p.perDay() ? 'Grid per day' : 'Grid',
          'Every grid node. Import above the line, export below it'
          + (exports_ ? '.' : ' — no export series is in history for this window, so only import is charted.'),
          barChart({ days, lines: gridLines, units, stacked: true, kind: p.kind(), partial, fitTo: p.fitTo() }), gridLines);
        drawn++;
      }

      // --- Self-sufficiency ---------------------------------------------------------------------------
      const solar = byKind('solar'), batt = byKind('battery'), load = byKind('home');
      // A share of energy over a period; instantaneous power is a different quantity.
      if (p.summable() && gridIn && (load || solar)) {
        const imported = sumOf(gridSupply);
        const pct = days.map((_, d) => selfSufficiencyPct(homeEnergy({
          ...(solar ? { solar: solar[d] } : {}),
          ...(batt ? { battery: batt[d] } : {}),
          ...(gridIn ? { grid: gridIn[d] } : {}),
          ...(load ? { load: load[d] } : {}),
        }), imported[d]));
        if (pct.some(v => v != null)) {
          const ssLines: Line[] = [{ label: 'Self-sufficiency', color: KIND_COLOR.solar, values: pct }];
          p.section(p.perDay() ? 'Self-sufficiency per day' : 'Self-sufficiency',
            'The share of the home’s energy that did not come from the grid'
            + (load ? '.' : ', with the home taken as the balance of the measured sources.')
            + ' A day missing either figure is left empty rather than estimated.',
            barChart({ days, lines: ssLines, units: '%', stacked: false, kind: p.kind(), max: 100, pct: true, partial, fitTo: p.fitTo() }), ssLines);
          drawn++;
        }
      }

      // --- Where the energy came from -------------------------------------------------------------
      const supplyLines: Line[] = [];
      ([['solar', 'Solar'], ['battery', 'Battery out'], ['grid', 'Grid import']] as [string, string][])
        .forEach(([k, label]) => {
          const v = sumOf(ofKind(k, (s: any) => !isReturn(s)));
          if (v.some(x => x != null)) supplyLines.push({ label, color: KIND_COLOR[k], values: v });
        });
      ([['battery', 'Battery in', '#2f8f52'], ['grid', 'Grid export', '#6fb0e0']] as [string, string, string][])
        .forEach(([k, label, colour]) => {
          const list = ofKind(k, (s: any) => isReturn(s));
          if (!list.length) return;
          const v = sumOf(list);
          if (v.some(x => x != null)) supplyLines.push({ label, color: colour, values: v });
        });
      if (supplyLines.length > 1) {
        p.section(p.perDay() ? `Where the day’s ${p.metricName()} came from` : `Where the ${p.metricName()} is coming from`,
          'Each kind summed across its nodes. What went back — battery charge, grid export — is below the line, '
          + 'so the same energy is not counted as produced and then again as returned.',
          barChart({ days, lines: supplyLines, units, stacked: true, kind: p.kind(), partial, fitTo: p.fitTo() }), supplyLines);
        drawn++;
      }

      // --- The same thing as a table ---------------------------------------------------------------
      tableBox.innerHTML = '';
      const positive = (list: any[]) => sumOf(list).map(v => (v == null ? null : Math.abs(v)));
      // A day counted from a counter that had been re-based is what is known to have run since, which may be
      // short of the whole day. The figure is shown, and marked as the floor it is.
      const resetOn = (list: any[]) => days.map((_, d) => list.some((x: any) => x.reset?.[d]));
      const resets: Record<string, boolean[]> = {
        Solar: resetOn(ofKind('solar')),
        'Battery charged': resetOn(ofKind('battery', (x: any) => isReturn(x))),
        'Battery discharged': resetOn(ofKind('battery', (x: any) => !isReturn(x))),
        'Grid used': resetOn(ofKind('grid', (x: any) => !isReturn(x))),
        'Grid exported': resetOn(ofKind('grid', (x: any) => isReturn(x))),
      };
      resets['Net grid'] = days.map((_, d) => resets['Grid used'][d] || resets['Grid exported'][d]);
      resets.Load = days.map((_, d) => Object.entries(resets).some(([k, on]) => k !== 'Load' && on[d]));
      const gridBack = ofKind('grid', (x: any) => isReturn(x));
      const used = sumOf(ofKind('grid', (x: any) => !isReturn(x))), sent = positive(gridBack);
      // What the meter nets out to: import less export. With nothing exporting at all, the import is the net;
      // with an export series that has no reading for a day, that day's net is unknown rather than the import.
      const netGrid = days.map((_, d) => used[d] == null ? null
        : !gridBack.length ? used[d]
          : sent[d] == null ? null : used[d]! - sent[d]!);
      const columns: [string, (number | null)[] | null][] = [
        ['Load', null], ['Solar', byKind('solar')],
        ['Battery charged', positive(ofKind('battery', (x: any) => isReturn(x)))],
        ['Battery discharged', sumOf(ofKind('battery', (x: any) => !isReturn(x)))],
        ['Grid used', used],
        ['Grid exported', sent],
        ['Net grid', netGrid],
      ];
      // The home: what it was measured as, else what the measured sources leave for it.
      const loadKind = byKind('home');
      columns[0][1] = days.map((_, d) => homeEnergy({
        ...(loadKind ? { load: loadKind[d] } : {}),
        ...(loadKind ? {} : {
          ...(solar ? { solar: solar[d] } : {}),
          ...(batt ? { battery: batt[d] } : {}),
          ...(gridIn ? { grid: gridIn[d] } : {}),
        }),
      }));
      const shown = columns.filter(([, v]) => v && v.some(x => x != null)) as [string, (number | null)[]][];
      if (p.summable() && shown.length) {
        const num = (v: number | null) => (v == null ? '—' : Math.round(v * 10) / 10 === 0 ? '0' : (Math.round(v * 10) / 10).toLocaleString('en-US'));
        const table = el('table', { class: 'trend-table' });
        const why: Record<string, string> = {
          Load: 'What the home used: its own reading where something measures it, else what the measured sources leave for it.',
          'Net grid': 'Grid used less grid exported — what the meter nets out to. A day missing either figure is left empty.',
        };
        table.appendChild(el('thead', {}, el('tr', {}, el('th', { text: p.perDay() ? 'Day' : 'At' }),
          ...shown.map(([label]) => el('th', { text: `${label} (${units})`, title: why[label] || '' })))));
        const rows = el('tbody');
        // Newest first: the day being asked about is nearly always the last one.
        days.map((day, d) => ({ day, d })).reverse().forEach(({ day, d }) => {
          const tr = el('tr', { class: day === partial ? 'is-partial' : '' });
          tr.dataset.day = day;
          tr.appendChild(el('th', { text: day + (day === partial ? ' · so far' : '') }));
          shown.forEach(([label, values]) => tr.appendChild(el('td', {
            text: num(values[d]),
            class: values[d] != null && resets[label]?.[d] ? 'is-reset' : '',
            title: values[d] != null && resets[label]?.[d]
              ? 'The counter behind this was re-based during the day, so this is what is known to have run since — the day may have been more.' : '',
          })));
          rows.appendChild(tr);
        });
        table.appendChild(rows);
        // A column's total is only a total when every day of it is known: one missing day makes it unknown.
        const foot = el('tr', { class: 'is-total' });
        foot.appendChild(el('th', { text: 'Total' }));
        shown.forEach(([, values]) => {
          const known = values.filter((v): v is number => v != null);
          foot.appendChild(el('td', {
            text: known.length ? num(known.reduce((a, v) => a + v, 0)) : '—',
            title: known.length === values.length ? '' : `${values.length - known.length} of ${values.length} readings are missing, so this is the sum of what is known.`,
            class: known.length === values.length ? '' : 'is-partial',
          }));
        });
        table.appendChild(el('tfoot', {}, foot));
        tableBox.appendChild(el('h3', { text: p.perDay() ? 'Day by day' : 'Reading by reading' }));
        tableBox.appendChild(table);
      }

      if (!drawn)
        p.charts.appendChild(el('div', { class: 'desc', text: 'Nothing about the whole system to chart in this window: no grid, solar or battery node reported. Each node’s own series is on the Node Trends page.' }));

      const gaps = days.filter((_, d) => !all.some((s: any) => s.values[d] != null)).length;
      p.status.textContent = p.statusLine(gaps);
    },
  });
  return { link, sec };
}
