// Real-world lengths on the floor plans (#463): feet and inches or metres and centimetres, as the GUI settings say.

export type UnitSystem = 'imperial' | 'metric';

const INCH = 0.0254;
const FOOT = 0.3048;

/// The system to show: the setting when it names one, else what the browser's language implies.
export function planUnitSystem(pref?: string, lang?: string): UnitSystem {
  if (pref === 'imperial' || pref === 'metric') return pref;
  const l = (lang || '').toLowerCase();
  return l === 'en-us' || l.startsWith('en-us') || l === 'en-lr' || l === 'my' || l.startsWith('my-') ? 'imperial' : 'metric';
}

/// A length in metres, written the way a tape measure reads: 12′ 6″, or 3.75 m / 85 cm.
export function planFmtLen(m: number, sys: UnitSystem): string {
  if (!Number.isFinite(m)) return '';
  const neg = m < 0 ? '−' : '';
  m = Math.abs(m);
  if (sys === 'imperial') {
    let inches = Math.round(m / INCH);
    const ft = Math.floor(inches / 12);
    inches -= ft * 12;
    if (!ft) return `${neg}${inches}″`;
    return inches ? `${neg}${ft}′ ${inches}″` : `${neg}${ft}′`;
  }
  if (m < 1) return `${neg}${Math.round(m * 100)} cm`;
  return `${neg}${(Math.round(m * 100) / 100).toString()} m`;
}

/// An area in square metres, as ft² or m².
export function planFmtArea(m2: number, sys: UnitSystem): string {
  if (!Number.isFinite(m2)) return '';
  return sys === 'imperial' ? `${Math.round(m2 / (FOOT * FOOT)).toLocaleString('en-US')} ft²` : `${(Math.round(m2 * 10) / 10).toLocaleString('en-US')} m²`;
}

/// A typed length, in metres: 12' 6", 12ft 6in, 12 6, 150", 3.75m, 3m 75cm, 375 cm, 3750mm. A bare number is feet or metres.
export function planParseLen(text: string, sys: UnitSystem): number | null {
  const t = String(text || '').toLowerCase().replace(/[’′]/g, "'").replace(/[”″]/g, '"').replace(/,/g, '.').replace(/\s+/g, ' ').trim();
  if (!t) return null;
  const num = '(\\d+(?:\\.\\d+)?|\\.\\d+)';
  let m = t.match(new RegExp(`^${num} ?(?:'|ft|feet|foot)(?: ?${num} ?(?:"|in|inch|inches)?)?$`));
  if (m) return Number(m[1]) * FOOT + (m[2] ? Number(m[2]) * INCH : 0);
  m = t.match(new RegExp(`^${num} ?(?:"|in|inch|inches)$`));
  if (m) return Number(m[1]) * INCH;
  m = t.match(new RegExp(`^${num} ?m(?: ?${num} ?cm)?$`));
  if (m) return Number(m[1]) + (m[2] ? Number(m[2]) / 100 : 0);
  m = t.match(new RegExp(`^${num} ?cm$`));
  if (m) return Number(m[1]) / 100;
  m = t.match(new RegExp(`^${num} ?mm$`));
  if (m) return Number(m[1]) / 1000;
  m = t.match(new RegExp(`^${num} ${num}$`));
  if (m) return sys === 'imperial' ? Number(m[1]) * FOOT + Number(m[2]) * INCH : Number(m[1]) + Number(m[2]) / 100;
  m = t.match(new RegExp(`^${num}$`));
  if (m) return sys === 'imperial' ? Number(m[1]) * FOOT : Number(m[1]);
  return null;
}

/// The grid a plan is drawn on, in metres: a foot, or half a metre.
export function planGridStep(sys: UnitSystem): number { return sys === 'imperial' ? FOOT : 0.5; }

/// What a corner snaps to when nothing else is near, in metres: three inches, or five centimetres.
export function planSnapStep(sys: UnitSystem): number { return sys === 'imperial' ? 3 * INCH : 0.05; }

/// A round length for the scale bar that is at least `minM` metres, and its label.
export function planScaleBar(minM: number, sys: UnitSystem): { m: number; label: string } {
  const steps = sys === 'imperial' ? [1, 2, 5, 10, 20, 25, 50, 100, 200, 500].map(f => f * FOOT) : [0.25, 0.5, 1, 2, 5, 10, 20, 50, 100, 200];
  const m = steps.find(s => s >= minM) ?? steps[steps.length - 1];
  return { m, label: planFmtLen(m, sys) };
}

/// The size a new floor starts at, in metres: a 60 × 40 ft lot, or 20 × 14 m.
export function planDefaultPlot(sys: UnitSystem): { w: number; h: number } {
  return sys === 'imperial' ? { w: 60 * FOOT, h: 40 * FOOT } : { w: 20, h: 14 };
}
