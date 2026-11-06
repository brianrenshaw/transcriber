// The design tokens: generated CSS in step with design/tokens.json, every colour pair at WCAG AA in both themes,
// and no stylesheet variable left undefined.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const {load, css, checkPairs, OUT} = require('../scripts/tokens');

const tokens = load();
// The app's stylesheet and the primitives page's frame both draw only from the tokens.
const sheets = ['styles.css', 'design.css'].map(f => [f, fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', f), 'utf8')]);

test('tokens.css is what design/tokens.json generates (run npm run tokens)', () => {
  assert.strictEqual(fs.readFileSync(OUT, 'utf8'), css(tokens));
});

test('light and dark name the same colour roles', () => {
  assert.deepStrictEqual(Object.keys(tokens['color-dark']).sort(), Object.keys(tokens.color).sort());
  assert.deepStrictEqual(Object.keys(tokens['shadow-dark']).sort(), Object.keys(tokens.shadow).sort());
});

for (const [theme, name] of [['color', 'light'], ['color-dark', 'dark']]) {
  test(`every ${name} colour pair meets WCAG AA`, () => {
    const failed = checkPairs(tokens[theme], tokens.pairs).filter(p => !p.ok)
      .map(p => `${p.fg} on ${p.bg}: ${p.ratio.toFixed(2)}, needs ${p.needs}`);
    assert.deepStrictEqual(failed, []);
  });
}

for (const [name, styles] of sheets) {
  test(`every variable ${name} uses is a token`, () => {
    const defined = new Set([...css(tokens).matchAll(/--([\w-]+):/g)].map(m => m[1]));
    const missing = [...new Set([...styles.matchAll(/var\(--([\w-]+)\)/g)].map(m => m[1]))].filter(v => !defined.has(v));
    assert.deepStrictEqual(missing, []);
  });

  test(`${name} keeps no colour of its own`, () => {
    const hex = styles.replace(/\/\*[\s\S]*?\*\//g, '').match(/#[0-9a-fA-F]{3,8}\b/g) || [];
    assert.deepStrictEqual(hex, []);
  });
}
