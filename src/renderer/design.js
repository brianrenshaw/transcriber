// The primitives page: the colour swatches and scales come from tokens.css itself, so the page always shows what
// ships. Widths and positions go through the CSSOM, which the page's CSP allows; style attributes it does not.

const rootRule = () => {
  for (const sheet of document.styleSheets) {
    if (!sheet.href || !sheet.href.endsWith('/tokens.css')) continue;
    for (const rule of sheet.cssRules) if (rule.selectorText === ':root') return rule;
  }
  return null;
};

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function render() {
  const rule = rootRule();
  if (!rule) return;
  const names = [...rule.style].filter(n => n.startsWith('--')).map(n => n.slice(2));
  const value = n => getComputedStyle(document.documentElement).getPropertyValue(`--${n}`).trim();

  const swatches = document.getElementById('swatches');
  swatches.replaceChildren(...names.filter(n => /^#[0-9a-f]{6,8}$/i.test(value(n))).map(n => {
    const chip = el('span', 'chip');
    chip.style.background = `var(--${n})`;
    const s = el('div', 'swatch');
    s.append(chip, el('span', 'name', n), el('span', 'val', value(n).toUpperCase()));
    return s;
  }));

  const scale = (title, cls, list, draw, label = n => `${n} ${value(n)}`) => {
    const box = el('div', 'scale ' + cls);
    box.append(el('span', 'cap', title));
    for (const n of list) {
      const row = el('div', 'item-row');
      row.append(el('span', 'val', label(n)), draw(n));
      box.append(row);
    }
    return box;
  };
  const bar = n => { const b = el('span', 'bar'); b.style.width = `var(--${n})`; return b; };
  const box = prop => n => { const b = el('span', 'box'); b.style[prop] = `var(--${n})`; return b; };
  const motion = el('div', 'scale');
  motion.append(el('span', 'cap', 'Motion'));
  const dl = el('dl', 'motion-list');
  for (const n of names.filter(n => /^(t-|enter$|exit$)/.test(n))) dl.append(el('dt', '', n), el('dd', '', value(n)));
  motion.append(dl);
  document.getElementById('scales').replaceChildren(
    scale('Space', 'space', names.filter(n => /^sp-\d$/.test(n)), bar),
    scale('Radius', 'radius', names.filter(n => /^r-[sml]$/.test(n)), box('borderRadius')),
    scale('Elevation', 'elev', names.filter(n => /^elev-\d$/.test(n)), box('boxShadow'), n => n),
    motion);
}

// The fills and marks the app sets from the recording's position.
function place() {
  const set = (id, prop, v) => { const e = document.getElementById(id); if (e) e.style[prop] = v; };
  set('meter-fill', 'width', '42%');
  set('progress-fill', 'width', '43%');
  set('clip-band', 'left', '38%'); set('clip-band', 'width', '22%');
  set('clip-head', 'left', '46%'); set('clip-head', 'opacity', '1');
  set('track-fill', 'width', '34%');
  const track = document.getElementById('track');
  const ticks = [[6, 'done'], [11, 'done'], [19, 'done'], [27, 'current'], [41, ''], [48, ''], [63, ''], [71, ''], [86, '']];
  for (const [at, kind] of ticks) {
    const t = el('span', 'tick' + (kind ? ' ' + kind : ''));
    t.style.left = `${at}%`;
    track.append(t);
  }
  const head = el('span', 'head');
  head.style.left = '34%';
  track.append(head);
}

render();
place();
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', render);
