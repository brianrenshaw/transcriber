// Python's difflib.SequenceMatcher with autojunk off and no junk, the matcher the shadow test used.
// The same port ran inside the browser for the NYT/WSJ pass and matched Python on all 48 test cases.

function SM(a, b) {
  const b2j = new Map();
  b.forEach((x, j) => { if (!b2j.has(x)) b2j.set(x, []); b2j.get(x).push(j); });

  function flm(alo, ahi, blo, bhi) {
    let besti = alo, bestj = blo, bestsize = 0, j2len = new Map();
    for (let i = alo; i < ahi; i++) {
      const nj = new Map();
      for (const j of (b2j.get(a[i]) || [])) {
        if (j < blo) continue;
        if (j >= bhi) break;
        const k = (j2len.get(j - 1) || 0) + 1;
        nj.set(j, k);
        if (k > bestsize) { besti = i - k + 1; bestj = j - k + 1; bestsize = k; }
      }
      j2len = nj;
    }
    while (besti > alo && bestj > blo && a[besti - 1] === b[bestj - 1]) { besti--; bestj--; bestsize++; }
    while (besti + bestsize < ahi && bestj + bestsize < bhi && a[besti + bestsize] === b[bestj + bestsize]) bestsize++;
    return [besti, bestj, bestsize];
  }

  let cache = null;
  function blocks() {
    if (cache) return cache;
    const la = a.length, lb = b.length, q = [[0, la, 0, lb]], mb = [];
    while (q.length) {
      const [alo, ahi, blo, bhi] = q.pop();
      const [i, j, k] = flm(alo, ahi, blo, bhi);
      if (k) {
        mb.push([i, j, k]);
        if (alo < i && blo < j) q.push([alo, i, blo, j]);
        if (i + k < ahi && j + k < bhi) q.push([i + k, ahi, j + k, bhi]);
      }
    }
    mb.sort((x, y) => x[0] - y[0] || x[1] - y[1] || x[2] - y[2]);
    const out = [];
    let i1 = 0, j1 = 0, k1 = 0;
    for (const [i2, j2, k2] of mb) {
      if (i1 + k1 === i2 && j1 + k1 === j2) k1 += k2;
      else { if (k1) out.push([i1, j1, k1]); i1 = i2; j1 = j2; k1 = k2; }
    }
    if (k1) out.push([i1, j1, k1]);
    out.push([la, lb, 0]);
    return (cache = out);
  }

  function opcodes() {
    let i = 0, j = 0;
    const ans = [];
    for (const [ai, bj, size] of blocks()) {
      const tag = i < ai && j < bj ? 'replace' : i < ai ? 'delete' : j < bj ? 'insert' : '';
      if (tag) ans.push([tag, i, ai, j, bj]);
      i = ai + size; j = bj + size;
      if (size) ans.push(['equal', ai, i, bj, j]);
    }
    return ans;
  }

  function ratio() {
    const m = blocks().reduce((n, x) => n + x[2], 0), t = a.length + b.length;
    return t ? 2 * m / t : 1;
  }

  return {flm, blocks, opcodes, ratio};
}

module.exports = {SM};
