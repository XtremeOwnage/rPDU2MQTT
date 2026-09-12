// Trends: the whole system over the chosen window — the grid, self-sufficiency, and where the energy came from.
import { el } from '../helpers.js';
import { homeEnergy, selfSufficiencyPct, sumKnown } from '../energy.js';
import { barChart, KIND_COLOR, type Line } from '../charts.js';
import { trendsPage, isReturn, signed } from './trends-shared.js';

export function addTrendsSection(nav: any, sections: any) {
  const { link, sec } = trendsPage(nav, sections, {
    label: 'Trends',
    icon: '▦',
    stackable: false,
    render: (p) => {
      const body = p.body();
      if (!body?.ok) return;

      const days = p.days();
      const units = body.units || 'kWh';
      const partial: string | null = body.partial || null;
      const all: any[] = body.series || [];
      const sumOf = (list: any[]) => days.map((_, d) => sumKnown(list.map((s: any) => signed(s)[d])));
      const byKind = (kind: string) => {
        const members = all.filter((s: any) => s.kind === kind);
        return members.length ? sumOf(members) : null;
      };
      let drawn = 0;

      // --- Grid ------------------------------------------------------------------------------------
      const gridSupply = all.filter((s: any) => s.kind === 'grid' && !isReturn(s));
      const gridReturn = all.filter((s: any) => s.kind === 'grid' && isReturn(s));
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
      const solar = byKind('solar'), batt = byKind('battery'), load = byKind('load');
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
          const v = sumOf(all.filter((s: any) => s.kind === k && !isReturn(s)));
          if (v.some(x => x != null)) supplyLines.push({ label, color: KIND_COLOR[k], values: v });
        });
      ([['battery', 'Battery in', '#2f8f52'], ['grid', 'Grid export', '#6fb0e0']] as [string, string, string][])
        .forEach(([k, label, colour]) => {
          const list = all.filter((s: any) => s.kind === k && isReturn(s));
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

      if (!drawn)
        p.charts.appendChild(el('div', { class: 'desc', text: 'Nothing about the whole system to chart in this window: no grid, solar or battery node reported. Each node’s own series is on the Node Trends page.' }));

      const gaps = days.filter((_, d) => !all.some((s: any) => s.values[d] != null)).length;
      p.status.textContent = p.statusLine(gaps);
    },
  });
  return { link, sec };
}
