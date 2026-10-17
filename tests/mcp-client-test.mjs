// End-to-end MCP test: connects with the official SDK Client over Streamable HTTP, verifies the negotiated
// protocol version, lists tools + the MCP Apps resource, and calls EVERY tool through a full simulated day.
// Usage: start the server (npm start), then `npm test` (MCP_URL defaults to http://127.0.0.1:8788/mcp).
// Run it with the server in DB_OFFLINE=1 mode to prove the whole flow works from the labelled snapshot.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';

const URL_ = process.env.MCP_URL || 'http://127.0.0.1:8788/mcp';
const HH = 'test-' + Date.now().toString(36);
const HH2 = HH + '-b';
const DAY = '2026-10-18';
const at = (hm) => `${DAY}T${hm}`;
const TOOLS = ['add_medicine', 'list_schedule', 'what_next', 'mark_taken', 'check_missed_doses', 'check_interactions', 'explain_medicine', 'family_alert', 'daily_briefing', 'refill_reminder'];
const DISC = /Not medical advice\. Ask your doctor or pharmacist\.|No es consejo médico|चिकित्सकीय सलाह नहीं/;

let pass = 0, fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✔ ${name}${detail ? '  — ' + detail : ''}`); }
  else { fail++; console.log(`  ✘ ${name}${detail ? '  — ' + detail : ''}`); }
}

const client = new Client({ name: 'dose-buddy-test', version: '1.0.0' });
const transport = new StreamableHTTPClientTransport(new URL(URL_));
await client.connect(transport);
console.log(`Connected to ${URL_}  household=${HH}`);
check('negotiated protocol version is 2025-11-25 or later', transport.protocolVersion >= '2025-11-25', `negotiated ${transport.protocolVersion}, SDK latest ${LATEST_PROTOCOL_VERSION}`);
check('session id issued (stateful Streamable HTTP)', !!transport.sessionId, transport.sessionId);
check('server identifies as dose-buddy', client.getServerVersion()?.name === 'dose-buddy', JSON.stringify(client.getServerVersion()));
const { tools } = await client.listTools();
check('lists all 10 tools', TOOLS.every((t) => tools.some((x) => x.name === t)) && tools.length === 10, tools.map((t) => t.name).join(', '));
check('every tool declares an outputSchema', tools.every((t) => t.outputSchema));
check('every tool links the MCP Apps UI resource', tools.every((t) => t._meta?.ui?.resourceUri === 'ui://dose-buddy/card.html'));
const { resources } = await client.listResources();
const card = resources.find((r) => r.uri === 'ui://dose-buddy/card.html');
check('MCP Apps resource listed with text/html;profile=mcp-app', card?.mimeType === 'text/html;profile=mcp-app', card?.mimeType);
const rr = await client.readResource({ uri: 'ui://dose-buddy/card.html' });
check('UI resource is HTML with the ui/initialize handshake', rr.contents[0].text.includes('ui/initialize'), `${rr.contents[0].text.length} bytes`);

async function call(name, args, assert, hh = HH) {
  const t0 = Date.now();
  const r = await client.callTool({ name, arguments: { household_id: hh, ...args } });
  const sc = r.structuredContent; const ms = Date.now() - t0;
  let ok = !r.isError && !!sc; let detail = (r.content?.[0]?.text || '').slice(0, 150);
  try { if (ok && assert) { const a = assert(sc, r); ok = a === true || (a && a.ok); if (a && a.detail) detail = a.detail; } } catch (e) { ok = false; detail = 'assert threw: ' + e.message; }
  check(`${name}(${JSON.stringify(args).slice(0, 90)}) [${ms} ms${sc?.dataMode ? ', ' + sc.dataMode : ''}]`, ok, detail);
  return sc;
}

console.log('\nSetup (a parent at home, an adult child caregiver in another city):');
await call('family_alert', { action: 'set_caregiver', caregiver_name: 'Maya', relation: 'daughter', city: 'Chicago', patient_name: 'Dad', patient_lang: 'en' }, (s) => s.caregiver.name === 'Maya' && s.channel === 'simulated');
await call('add_medicine', { name: 'Glucophage', strength: '500 mg', times: ['8 AM', '8 PM'], pills_left: 40, now: at('07:30') }, (s) => ({ ok: s.med.ingredients[0] === 'metformin' && s.resolution.via === 'curated_brand' && /medlineplus/.test(s.resolution.brandSource), detail: `Glucophage → ${s.med.ingredients} (${s.resolution.via}); times ${s.med.times}` }));
await call('add_medicine', { name: 'Zestril', strength: '10 mg', times: ['09:00'], pills_left: 26, now: at('07:31') }, (s) => s.med.ingredients[0] === 'lisinopril');
await call('add_medicine', { name: 'Plavix', strength: '75 mg', times: ['09:00'], pills_left: 4, now: at('07:32') }, (s) => s.med.ingredients[0] === 'clopidogrel' && !!s.med.label?.setId);
await call('add_medicine', { name: 'Lipitor', strength: '20 mg', times: ['21:00'], pills_left: 30, now: at('07:33') }, (s) => ({ ok: s.med.ingredients[0] === 'atorvastatin' && s.interactions.hits.length === 0, detail: 'no curated high-risk pair among the 4 starting medicines' }));
await call('list_schedule', { now: at('07:35') }, (s) => ({ ok: s.meds.length === 4 && s.slots.length === 5, detail: s.speech }));

console.log('\nMorning: "Alexa, what do I take now?"');
await call('what_next', { now: at('09:05') }, (s) => ({ ok: s.due.length === 3 && /Glucophage/.test(s.speech) && /with meals/.test(s.speech) && DISC.test(s.speech), detail: s.speech }));
await call('what_next', { now: at('09:05'), lang: 'es' }, (s) => ({ ok: /Es hora de/.test(s.speech) && /comidas/.test(s.speech), detail: s.speech.slice(0, 110) }));
await call('mark_taken', { now: at('09:07') }, (s) => ({ ok: s.logged.length === 3 && s.logged.find((l) => l.med === 'Plavix').pillsLeft === 3 && /refill/i.test(s.speech), detail: s.speech }));

console.log('\nLate morning: "Can I take Advil with my medicines?"');
const adv = await call('check_interactions', { candidate: 'Advil', now: at('11:20') }, (s) => {
  const ids = s.hits.map((h) => h.pairId).sort().join(',');
  return { ok: ids === 'ace-nsaid,clopidogrel-nsaid' && s.hits.every((h) => h.source.verifiedInLiveLabel && /dailymed/.test(h.source.url)) && s.alert?.kind === 'risky_combo' && /don't take Advil/.test(s.speech) && /don't stop/.test(s.speech) && DISC.test(s.speech), detail: `${ids}; quotes verified in FDA label text: ${s.hits.map((h) => h.source.verifiedInLiveLabel).join('/')}; caregiver alert: ${s.alert?.title}` };
});
check('interaction speech never tells anyone to stop a medicine', !/\b(stop taking|discontinue)\b/i.test(adv.speech), 'only "please don\'t stop any of your medicines on your own"');
await call('check_interactions', { candidate: 'Nurofen', now: at('11:25') }, (s) => ({ ok: s.candidate.ingredients[0] === 'ibuprofen' && s.hits.length === 2, detail: 'UK brand Nurofen → ibuprofen, same 2 warnings' }));
await call('check_interactions', { candidate: 'Panadol', now: at('11:26') }, (s) => ({ ok: s.candidate.ingredients[0] === 'acetaminophen' && s.hits.length === 0 && /not a guarantee/.test(s.speech), detail: 'Panadol → acetaminophen: nothing in the curated table, says the list is not a guarantee' }));
await call('check_interactions', { candidate: 'Eliquis', now: at('11:27') }, (s) => ({ ok: s.candidate.via === 'openfda' && /apixaban/i.test(s.candidate.ingredients.join()), detail: `uncurated brand resolved live via openFDA → ${s.candidate.ingredients}` }));
await call('add_medicine', { name: 'Prilosec', strength: '20 mg', times: ['07:00'], pills_left: 30, now: at('11:40') }, (s) => ({ ok: s.interactions.hits[0]?.pairId === 'clopidogrel-omeprazole' && /call your doctor/.test(s.speech) && !!s.interactions.alert, detail: s.speech.slice(0, 170) }));
await call('check_interactions', { lang: 'es', now: at('11:45') }, (s) => ({ ok: s.hits.some((h) => h.pairId === 'clopidogrel-omeprazole') && /No es consejo médico/.test(s.speech), detail: s.speech.slice(0, 120) }));

console.log('\nExplanations (English first, Spanish, Hindi):');
await call('explain_medicine', { medicine: 'Lipitor', lang: 'en' }, (s) => ({ ok: /cholesterol/.test(s.speech) && s.sections[0].fda?.setId && /medlineplus\.gov\/druginfo/.test(s.sections[0].medlineplus), detail: s.speech.slice(0, 120) }));
await call('explain_medicine', { medicine: 'metformina', lang: 'es' }, (s) => ({ ok: /diabetes tipo 2/.test(s.speech) && /spanish/.test(s.sections[0].medlineplus) && /No es consejo médico/.test(s.speech), detail: s.speech.slice(0, 120) }));
await call('explain_medicine', { medicine: 'Plavix', lang: 'hi' }, (s) => ({ ok: /[\u0900-\u097F]/.test(s.speech) && /हिंदी अनुवाद/.test(s.speech), detail: s.speech.slice(0, 80) }));
await call('explain_medicine', { medicine: 'Coumadin' }, (s) => ({ ok: /blood thinner/.test(s.speech) && s.sections[0].fda?.hasBoxedWarning === true, detail: 'warfarin: curated summary + live FDA boxed warning flag' }));
await call('explain_medicine', { medicine: 'apixaban' }, (s) => ({ ok: s.curated === false && /FDA label says/.test(s.speech), detail: 'uncurated: falls back to the FDA label indications text, says it has no plain summary' }));

console.log('\nEvening: missed doses → family alert (simulated)');
await call('check_missed_doses', { now: at('22:45') }, (s) => ({ ok: s.newlyMissed.length === 2 && s.alerts.length === 2 && s.channel === 'simulated' && /no SMS/.test(s.simulatedNote) && /Maya/.test(s.speech), detail: s.speech }));
await call('check_missed_doses', { now: at('22:50') }, (s) => ({ ok: s.newlyMissed.length === 0, detail: 'second run: no duplicate alerts' }));
await call('refill_reminder', { now: at('22:50') }, (s) => ({ ok: s.due.length === 1 && s.due[0].med === 'Plavix' && s.due[0].daysLeft === 3, detail: s.speech }));
await call('family_alert', { action: 'send', message: 'I feel a bit dizzy, please call me', now: at('22:52') }, (s) => s.sent?.kind === 'message' && s.channel === 'simulated');
await call('family_alert', { action: 'feed' }, (s) => ({ ok: s.feed.length >= 6 && s.feed.every((f) => f.channel === 'simulated'), detail: s.feed.map((f) => f.kind).join(', ') }));
await call('daily_briefing', { now: at('22:55') }, (s) => ({ ok: s.adherence.taken === 3 && s.adherence.due === 5 && s.lastQuestion?.candidate && s.refills.length === 1 && s.interactions.hits.length >= 1 && /Maya|Dad/.test(s.speech), detail: s.speech.slice(0, 200) }));
await call('daily_briefing', { now: at('22:56'), lang: 'es' }, (s) => ({ ok: /Así va el día de Dad/.test(s.speech) && s.feed.length === 0, detail: 'Spanish briefing; alerts already marked seen' }));

console.log('\nSevere combinations (second household):');
await call('add_medicine', { name: 'Viagra', times: ['20:00'], now: at('10:00') }, null, HH2);
await call('add_medicine', { name: 'Imdur', times: ['08:00'], now: at('10:01') }, (s) => ({ ok: s.interactions.hits[0]?.severity === 'severe' && s.interactions.hits[0].pairId === 'sildenafil-nitrate' && /call your doctor today/.test(s.speech), detail: s.speech.slice(0, 160) }), HH2);
await call('check_interactions', { candidate: 'Bayer Aspirin', now: at('10:05') }, (s) => s.hits.length === 0, HH2);
await call('add_medicine', { name: 'Coumadin', times: ['18:00'], now: at('10:06') }, null, HH2);
await call('check_interactions', { candidate: 'Bayer Aspirin', now: at('10:07') }, (s) => ({ ok: s.hits[0]?.pairId === 'warfarin-antiplatelet' && s.topSeverity === 'severe' && s.alert?.severity === 'urgent', detail: 'warfarin + aspirin → severe, urgent (simulated) caregiver alert' }), HH2);

// Persistence across sessions
const c2 = new Client({ name: 'dose-buddy-test-2', version: '1.0.0' });
const t2 = new StreamableHTTPClientTransport(new URL(URL_));
await c2.connect(t2);
const ls = await c2.callTool({ name: 'list_schedule', arguments: { household_id: HH, now: at('23:00') } });
check('state persists into a new MCP session', t2.sessionId !== transport.sessionId && ls.structuredContent.meds.length === 5, `new session ${t2.sessionId}; ${ls.structuredContent.meds.map((m) => m.name).join(', ')}`);

const bad = await client.callTool({ name: 'add_medicine', arguments: { household_id: HH, name: 'Zocor', times: ['not a time'] } });
check('invalid input returns isError (no crash)', bad.isError === true, bad.content[0].text.slice(0, 80));

await client.close(); await c2.close();
console.log(`\n${pass} passed, ${fail} failed. household=${HH}`);
process.exit(fail ? 1 : 0);
