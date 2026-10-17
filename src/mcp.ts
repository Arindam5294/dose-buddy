// The Dose Buddy MCP server: 10 tools + 1 MCP Apps UI resource, on the official @modelcontextprotocol/sdk
// (McpServer) and @modelcontextprotocol/ext-apps/server helpers.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerAppTool, registerAppResource, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import { z } from 'zod';
import * as S from './buddy/service.js';

const HERE = dirname(fileURLToPath(import.meta.url));
export const CARD_URI = 'ui://dose-buddy/card.html';
export function cardHtml() {
  for (const p of [join(HERE, 'ui', 'card.html'), join(HERE, '..', 'src', 'ui', 'card.html')]) {
    try { return readFileSync(p, 'utf8'); } catch { /* next */ }
  }
  throw new Error('card.html not found');
}

const HH = z.string().min(1).max(64).default('default').describe('Stable household id (on Alexa: the household/account). All medicines, doses and alerts are kept per household across sessions.');
const LANG = z.enum(['en', 'es', 'hi']).optional().describe('Reply language: en (English), es (Spanish), hi (Hindi). Defaults to the person\'s saved language.');
const NOW = z.string().regex(/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/).optional().describe('Optional local wall-clock time "YYYY-MM-DDTHH:MM" in the household timezone. Used by the simulator\'s demo clock and tests; omit for the real time.');
const ui = { ui: { resourceUri: CARD_URI } };
const ok = (sc: any) => {
  // every spoken answer ends with the disclaimer in the reply language
  if (sc.disclaimer && !String(sc.speech).includes(sc.disclaimer)) sc.speech = `${sc.speech} ${sc.disclaimer}`;
  return { content: [{ type: 'text' as const, text: sc.speech }], structuredContent: sc };
};
const fail = (e: any) => ({ content: [{ type: 'text' as const, text: `Error: ${e?.message || e}` }], isError: true });
const loose = (shape: any) => z.looseObject({ kind: z.string(), speech: z.string(), disclaimer: z.string(), ...shape });

export function buildMcpServer() {
  const server = new McpServer(
    { name: 'dose-buddy', title: 'Dose Buddy', version: '1.0.0' } as any,
    {
      capabilities: { logging: {} },
      instructions:
        'Voice-first medicine guardian for older adults and their family caregivers. Use what_next for "what do I take now?", ' +
        'mark_taken when they say they took it, check_interactions BEFORE they take anything new ("can I take X?"), explain_medicine for ' +
        '"what is this for?" (en/es/hi), check_missed_doses on a schedule, daily_briefing for the caregiver. Speak the content text; it ' +
        'always ends with "Not medical advice". Never tell anyone to stop a medicine; serious combinations mean "call your doctor". ' +
        'Family alerts are a simulated feed in this build (no SMS). Always pass the same household_id.',
    },
  );

  registerAppResource(server, 'Dose Buddy card', CARD_URI, { description: 'Echo Show card: schedule, what to take now, interaction warnings with sources, explanations, family alert feed, caregiver briefing.', mimeType: RESOURCE_MIME_TYPE }, async () => ({
    contents: [{ uri: CARD_URI, mimeType: RESOURCE_MIME_TYPE, text: cardHtml(), _meta: { ui: { prefersBorder: false, csp: { connectDomains: [], resourceDomains: [] } } } }],
  }));

  registerAppTool(server, 'add_medicine', {
    title: 'Add a medicine',
    description: 'Adds a medicine to the household schedule. Accepts a brand (Tylenol, Panadol, Advil, Nurofen, Plavix, Lipitor, Glucophage, Zestril, Coumadin, Zoloft…) or a generic name; brands map to generics through a curated, cited table, then openFDA. Stores strength, times, tablets per dose and pill count, and checks the new medicine against the existing list (serious combinations alert the caregiver feed).',
    inputSchema: { name: z.string().min(2).describe('Brand or generic name'), strength: z.string().max(40).optional(), times: z.array(z.string()).min(1).max(6).describe('Local times, e.g. ["08:00","20:00"] or ["8 AM"]'), units_per_dose: z.number().int().min(1).max(10).optional(), pills_left: z.number().int().min(0).max(2000).optional(), refill_threshold_days: z.number().int().min(1).max(60).optional(), lang: LANG, now: NOW, household_id: HH },
    outputSchema: loose({ med: z.object({ id: z.string(), name: z.string(), ingredients: z.array(z.string()), times: z.array(z.string()) }).passthrough(), interactions: z.any() }),
    annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: true },
    _meta: ui,
  }, async ({ household_id, ...a }: any) => { try { return ok(await S.addMedicine(household_id, a)); } catch (e) { return fail(e); } });

  registerAppTool(server, 'list_schedule', {
    title: 'List today\'s schedule',
    description: 'Lists every medicine with its times, tablets per dose, pill count and days left, plus today\'s dose slots and their status (taken, missed, due, upcoming).',
    inputSchema: { lang: LANG, now: NOW, household_id: HH },
    outputSchema: loose({ meds: z.array(z.any()), slots: z.array(z.any()) }),
    annotations: { readOnlyHint: true },
    _meta: ui,
  }, async ({ household_id, ...a }: any) => { try { return ok(S.listSchedule(household_id, a)); } catch (e) { return fail(e); } });

  registerAppTool(server, 'what_next', {
    title: 'What do I take now?',
    description: '"Alexa, what do I take now?" Returns the doses due now (from 60 minutes before to 90 minutes after their time), any overdue doses, the next one, and food guidance from MedlinePlus.',
    inputSchema: { lang: LANG, now: NOW, household_id: HH },
    outputSchema: loose({ due: z.array(z.any()), overdue: z.array(z.any()) }),
    annotations: { readOnlyHint: true },
    _meta: ui,
  }, async ({ household_id, ...a }: any) => { try { return ok(S.whatNext(household_id, a)); } catch (e) { return fail(e); } });

  registerAppTool(server, 'mark_taken', {
    title: 'Mark a dose taken (or skipped)',
    description: 'Logs a dose as taken or skipped. With no medicine, logs every dose that is due now. Decrements the pill count and warns when a refill is near.',
    inputSchema: { medicine: z.string().optional(), time: z.string().optional().describe('Which scheduled time, if several'), status: z.enum(['taken', 'skipped']).default('taken'), lang: LANG, now: NOW, household_id: HH },
    outputSchema: loose({ logged: z.array(z.any()) }),
    annotations: { readOnlyHint: false },
    _meta: ui,
  }, async ({ household_id, ...a }: any) => { try { return ok(S.markTaken(household_id, a)); } catch (e) { return fail(e); } });

  registerAppTool(server, 'check_missed_doses', {
    title: 'Missed-dose check',
    description: 'Finds doses more than 90 minutes past their time with nothing logged, records them as missed, tells the person to ask their pharmacist about the late dose, and sends a family alert (simulated feed, no SMS). Safe to run on a schedule; alerts are de-duplicated.',
    inputSchema: { lang: LANG, now: NOW, household_id: HH },
    outputSchema: loose({ newlyMissed: z.array(z.any()), alerts: z.array(z.any()) }),
    annotations: { readOnlyHint: false, idempotentHint: true },
    _meta: ui,
  }, async ({ household_id, ...a }: any) => { try { return ok(S.checkMissed(household_id, a)); } catch (e) { return fail(e); } });

  registerAppTool(server, 'check_interactions', {
    title: 'Check medicine interactions',
    description: 'Checks the current medicine list, and optionally a candidate ("Can I take Advil with my meds?"), against a curated table of high-risk pairs, each citing an FDA label quote that is re-verified against the live openFDA label, plus an openFDA label text scan. Severe or high results for a candidate alert the caregiver feed. Always says to ask a doctor or pharmacist and never to stop a medicine alone.',
    inputSchema: { candidate: z.string().optional().describe('Medicine the person is thinking of taking'), lang: LANG, now: NOW, household_id: HH },
    outputSchema: loose({ hits: z.array(z.any()), labelMentions: z.array(z.any()), topSeverity: z.string().nullable() }),
    annotations: { readOnlyHint: false, openWorldHint: true },
    _meta: ui,
  }, async ({ household_id, candidate, ...a }: any) => { try { return ok(await S.checkInteractions(household_id, { ...a, candidate, source: candidate ? 'ask' : 'list' })); } catch (e) { return fail(e); } });

  registerAppTool(server, 'explain_medicine', {
    title: 'Explain a medicine simply',
    description: 'What a medicine is for, common side effects and whether to take it with food, in simple English, Spanish or Hindi. Facts come from curated MedlinePlus summaries (English and official Spanish pages; Hindi is a marked translation) plus the live FDA label (indications, boxed warning).',
    inputSchema: { medicine: z.string().min(2), lang: LANG, household_id: HH },
    outputSchema: loose({ sections: z.array(z.any()), ingredients: z.array(z.string()) }),
    annotations: { readOnlyHint: true, openWorldHint: true },
    _meta: ui,
  }, async ({ household_id, ...a }: any) => { try { return ok(await S.explainMedicine(household_id, a)); } catch (e) { return fail(e); } });

  registerAppTool(server, 'family_alert', {
    title: 'Family alerts (simulated feed)',
    description: 'Family caregiver channel. action=set_caregiver (name, relation, city; optional patient_name/patient_lang), action=send (the person sends a message: "tell Maya I feel dizzy"), action=feed (list alerts). Missed doses, serious combinations and refills post here automatically. SIMULATED: nothing is sent by SMS, call, e-mail or push.',
    inputSchema: { action: z.enum(['send', 'feed', 'set_caregiver']).default('feed'), message: z.string().max(300).optional(), caregiver_name: z.string().max(30).optional(), relation: z.string().max(30).optional(), city: z.string().max(40).optional(), patient_name: z.string().max(30).optional(), patient_lang: z.enum(['en', 'es', 'hi']).optional(), lang: LANG, now: NOW, household_id: HH },
    outputSchema: loose({ feed: z.array(z.any()), channel: z.literal('simulated') }),
    annotations: { readOnlyHint: false },
    _meta: ui,
  }, async ({ household_id, ...a }: any) => { try { return ok(S.familyAlert(household_id, a)); } catch (e) { return fail(e); } });

  registerAppTool(server, 'daily_briefing', {
    title: 'Caregiver daily briefing',
    description: 'For the family caregiver: doses taken vs due so far today, missed and late doses, what the person asked about and what was flagged, combinations on the current list to raise with the doctor, refills due, and alerts since the last briefing (then marks them seen).',
    inputSchema: { lang: LANG, now: NOW, household_id: HH },
    outputSchema: loose({ adherence: z.object({ due: z.number(), taken: z.number() }).passthrough(), refills: z.array(z.any()), feed: z.array(z.any()) }),
    annotations: { readOnlyHint: false, openWorldHint: true },
    _meta: ui,
  }, async ({ household_id, ...a }: any) => { try { return ok(await S.dailyBriefing(household_id, a)); } catch (e) { return fail(e); } });

  registerAppTool(server, 'refill_reminder', {
    title: 'Refill reminder',
    description: 'Days of supply left per medicine from pill counts (pills ÷ tablets per day). Medicines at or under their threshold (default 5 days) post a refill alert to the family feed. Optionally update a pill count first (set).',
    inputSchema: { threshold_days: z.number().int().min(1).max(60).optional(), set: z.object({ medicine: z.string(), pills_left: z.number().int().min(0) }).optional(), lang: LANG, now: NOW, household_id: HH },
    outputSchema: loose({ rows: z.array(z.any()), due: z.array(z.any()) }),
    annotations: { readOnlyHint: false, idempotentHint: true },
    _meta: ui,
  }, async ({ household_id, ...a }: any) => { try { return ok(S.refillReminder(household_id, a)); } catch (e) { return fail(e); } });

  return server;
}
