// Temperatures are stored in °C and shown in the unit picked under Gui.TemperatureUnits.
import { state } from './state.js';

export function tempIsF(): boolean {
  const pref = state.data?.Gui?.TemperatureUnits;
  if (pref === 'fahrenheit') return true;
  if (pref === 'celsius') return false;
  const l = String((globalThis as any).navigator?.language || '').toLowerCase();
  return /^en-(us|lr|bs|bz|ky|pw)\b/.test(l) || l === 'en-us';
}
export const tempUnit = () => (tempIsF() ? '°F' : '°C');
export const toTemp = (c: number) => (tempIsF() ? c * 9 / 5 + 32 : c);
export const fromTemp = (v: number) => (tempIsF() ? (v - 32) * 5 / 9 : v);
export const fmtTemp = (c: number, digits = 0) => `${(Number(toTemp(c).toFixed(digits)) || 0).toFixed(digits)} ${tempUnit()}`;
