// Re-fetches every FDA label cited by the curated interaction table and checks that the cited quote is really
// in the label text. Also checks every curated ingredient's representative label resolves. Exit 1 on any miss.
import { PAIRS } from '../src/data/interactions.js';
import { DRUGS } from '../src/data/drugs.js';
import { BRANDS } from '../src/data/brands.js';
import { labelBySetId, quoteInLabel } from '../src/data/openfda.js';
let bad = 0;
for (const p of PAIRS) {
  const l = await labelBySetId(p.source.setId);
  const ok = !!l.label && quoteInLabel(l.label, p.source.quote);
  if (!ok) bad++;
  console.log(`${ok ? '✔' : '✘'} ${p.id.padEnd(28)} ${l.ref?.dataMode || '-'}  ${p.source.label}: "${p.source.quote.slice(0, 60)}…"`);
}
for (const d of DRUGS.filter((x) => x.setId)) {
  const l = await labelBySetId(d.setId!);
  const ok = !!l.label; if (!ok) bad++;
  console.log(`${ok ? '✔' : '✘'} label ${d.key.padEnd(24)} ${l.ref?.generic || 'MISSING'} (${l.ref?.dataMode || '-'})`);
}
const known = new Set(DRUGS.map((d) => d.key));
for (const b of BRANDS) { const ok = b.ingredients.every((k) => known.has(k)) && /^https:\/\//.test(b.source); if (!ok) bad++; if (!ok) console.log('✘ brand', b.brand); }
console.log(`brands: ${BRANDS.length} curated, all mapped to curated ingredients with a source URL`);
console.log(bad ? `\n${bad} source check(s) FAILED` : `\nall ${PAIRS.length} cited quotes verified in FDA label text; ${DRUGS.filter((x) => x.setId).length} labels resolve`);
process.exit(bad ? 1 : 0);
