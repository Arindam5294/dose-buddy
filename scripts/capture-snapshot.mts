// Captures REAL openFDA label responses for every curated ingredient, every label cited by the interaction
// table, and the uncurated-name lookups used by the tests, into snapshots/fallback.json. The data layer serves
// these (clearly labelled "snapshot") only when the live API and the disk cache both fail, or with DB_OFFLINE=1.
import { writeFileSync, mkdirSync } from 'node:fs';
import { recorder } from '../src/data/http.js';
import { DRUGS } from '../src/data/drugs.js';
import { PAIRS } from '../src/data/interactions.js';
import { labelBySetId, searchByName } from '../src/data/openfda.js';
recorder.on = true;
const ids = new Set<string>([...DRUGS.map((d) => d.setId).filter(Boolean) as string[], ...PAIRS.map((p) => p.source.setId)]);
for (const id of ids) { const r = await labelBySetId(id); console.log(id.slice(0, 8), r.ref ? `${r.ref.generic} ${r.ref.effectiveTime}` : 'MISSING ' + (r as any).error); }
for (const n of ['Eliquis', 'apixaban', 'Xyzzyquil']) { const r = await searchByName(n); console.log('search', n, r ? r.ref.generic : 'no match'); }
mkdirSync('snapshots', { recursive: true });
writeFileSync('snapshots/fallback.json', JSON.stringify({ capturedAt: new Date().toISOString(), source: 'https://api.fda.gov/drug/label.json', note: 'Real openFDA drug label responses (trimmed to the sections Dose Buddy reads), captured by scripts/capture-snapshot.mts. Served only as a labelled fallback when live data and the local cache are unavailable. openFDA: "Do not rely on openFDA to make decisions regarding medical care."', responses: recorder.entries }));
console.log(`saved ${Object.keys(recorder.entries).length} responses`);
