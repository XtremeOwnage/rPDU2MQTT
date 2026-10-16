/// On a phone, a table wider than the screen stacks: each row becomes a card, each cell headed by its column.
///
/// Decided by measurement, not per page: a table that fits stays a table, so a short numeric one keeps its
/// columns to compare down, and only the ones that would scroll sideways change shape. A table that must keep
/// its columns opts out with `ld-nostack`. Every page renders its own tables, often on each live update, so
/// one observer heads the cells wherever they are drawn.
const PHONE = '(max-width: 560px)';

const headings = (table: HTMLTableElement): string[] => {
  const row = table.tHead?.rows[table.tHead.rows.length - 1];
  const out: string[] = [];
  if (!row) return out;
  for (const th of Array.from(row.cells)) {
    const text = (th.textContent || '').trim();
    for (let i = 0; i < (th.colSpan || 1); i++) out.push(text);
  }
  return out;
};

const label = (table: HTMLTableElement) => {
  const names = headings(table);
  if (!names.length) return;
  for (const body of Array.from(table.tBodies)) for (const tr of Array.from(body.rows)) {
    let col = 0;
    for (const td of Array.from(tr.cells)) {
      // A cell the page headed itself keeps its own words.
      if (!td.dataset.label && names[col]) td.dataset.label = names[col];
      // A card has no column to keep aligned, so a cell saying only "nothing here" is left out of it.
      td.classList.toggle('ld-blank', !td.querySelector('input, select, button, textarea, svg, img') && /^[\s—–-]*$/.test(td.textContent || ''));
      col += td.colSpan || 1;
    }
  }
};

const settle = (phone: boolean) => {
  document.querySelectorAll<HTMLTableElement>('table.ld:not(.ld-nostack)').forEach(table => {
    const auto = table.classList.contains('ld-auto-stack');
    if (!phone) { if (auto) table.classList.remove('ld-stack', 'ld-auto-stack'); return; }
    if (table.classList.contains('ld-stack')) { label(table); return; }
    // Hidden (another page, a closed panel): measured when it is shown.
    if (!table.offsetParent) return;
    const room = (table.parentElement?.clientWidth || 0);
    if (room && table.scrollWidth > room + 2) {
      table.classList.add('ld-stack', 'ld-auto-stack');
      label(table);
    }
  });
};

export function initStackTables() {
  const mq = typeof window !== 'undefined' ? window.matchMedia?.(PHONE) : null;
  if (!mq || typeof MutationObserver === 'undefined') return;
  let queued = false;
  const run = () => { queued = false; settle(mq.matches); };
  const queue = () => { if (!queued) { queued = true; requestAnimationFrame(run); } };
  new MutationObserver(queue).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'hidden', 'open'] });
  mq.addEventListener?.('change', queue);
  queue();
}
