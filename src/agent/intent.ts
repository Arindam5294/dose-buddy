// Deterministic intent parser for the Alexa+ simulator: English, Spanish and Hindi/Hinglish, no paid LLM.
// It returns a *plan*: an ordered list of MCP tool calls. The agent runner executes them over MCP.

import { BRANDS } from '../data/brands.js';
import { DRUGS, norm } from '../data/drugs.js';

export type Lang = 'en' | 'es' | 'hi';
export interface Step { tool: string; args: Record<string, any>; why: string }
export interface Plan { intent: string; lang: Lang; steps: Step[]; ask?: string }
export interface Session { lastMed?: string | null }

const HINGLISH = /\b(kya|hai|hain|mera|meri|mere|batao|bataiye|samjhao|karo|kaunsi|kaun|abhi|dawai|dawa|goli|le li|kha li|lena|leni|sakta|sakti|kis liye|ke baare|mein|nahi|chhoot|bhool)\b/g;
const SPANISH = /\b(qué|que|puedo|tomar|tomo|toca|mis|medicinas|medicamentos|pastillas|para qué|explícame|explicame|dime|español|ya tomé|ya tome|me tomé|olvidé|olvide|resumen|cuántas|cuantas|ahora|hoy|dile|agrega|añade|con mis)\b/g;

export function detectLang(text: string): { lang: Lang; explicit: boolean } {
  const t = text.toLowerCase();
  if (/\b(in spanish|en español|en espanol|spanish please)\b/.test(t)) return { lang: 'es', explicit: true };
  if (/\b(in hindi|hindi mein|hindi me|हिंदी में)\b/.test(t)) return { lang: 'hi', explicit: true };
  if (/\bin english\b/.test(t)) return { lang: 'en', explicit: true };
  if (/[\u0900-\u097F]/.test(text)) return { lang: 'hi', explicit: false };
  if (/[¿¡ñ]/.test(text) || (t.match(SPANISH) || []).length >= 2) return { lang: 'es', explicit: false };
  if ((t.match(HINGLISH) || []).length >= 2) return { lang: 'hi', explicit: false };
  return { lang: 'en', explicit: false };
}

const ALL_NAMES: { name: string; canonical: string }[] = [
  ...BRANDS.map((b) => ({ name: b.brand, canonical: b.brand })),
  ...DRUGS.flatMap((d) => [d.key, d.names.en.replace(/\s*\(.*\)$/, ''), d.names.es.replace(/\s*\(.*\)$/, ''), ...d.synonyms].map((n) => ({ name: n, canonical: d.key }))),
].filter((x) => x.name.length >= 3).sort((a, b) => b.name.length - a.name.length);

export function extractMeds(text: string): string[] {
  let t = ' ' + norm(text).replace(/[?,.!¿¡]/g, ' ') + ' ';
  const found: { at: number; canonical: string }[] = [];
  for (const n of ALL_NAMES) {
    const k = norm(n.name);
    const re = new RegExp(`[^a-z0-9]${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+')}[^a-z0-9]`);
    const m = t.match(re);
    if (m && m.index != null) { found.push({ at: m.index, canonical: n.canonical }); t = t.slice(0, m.index + 1) + ' '.repeat(m[0].length - 2) + t.slice(m.index + m[0].length - 1); }
  }
  return [...new Set(found.sort((a, b) => a.at - b.at).map((f) => f.canonical))];
}
function unknownMedAfter(text: string, words: RegExp): string | null {
  const m = text.match(words);
  if (!m) return null;
  const w = m[1]?.replace(/[^A-Za-z\-]/g, '');
  return w && w.length > 2 && !/^(my|the|a|an|it|this|that|some|any|mis|el|la|un|una|meds|medicine|medicines|pills)$/i.test(w) ? w : null;
}

export function extractTimes(text: string): string[] {
  const t = text.toLowerCase();
  const out: string[] = [];
  for (const m of t.matchAll(/\b(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)\b/g)) out.push(`${m[1]}:${m[2] || '00'} ${m[3].replace(/\./g, '')}`);
  for (const m of t.matchAll(/\b([01]?\d|2[0-3]):([0-5]\d)\b(?!\s*(am|pm|a\.m|p\.m))/g)) out.push(`${m[1]}:${m[2]}`);
  if (/\b(morning|breakfast|mañana|desayuno|subah)\b/.test(t) && !out.length) out.push('08:00');
  if (/\b(lunch|noon|mediodía|almuerzo|dopahar)\b/.test(t)) out.push('13:00');
  if (/\b(evening|tarde|shaam)\b/.test(t)) out.push('18:00');
  if (/\b(night|bedtime|dinner|noche|cena|raat)\b/.test(t)) out.push('21:00');
  if (/\btwice a day|two times a day|dos veces al día\b/.test(t) && !out.length) out.push('08:00', '20:00');
  return [...new Set(out)];
}

export function parse(raw: string, s: Session, hid: string, ctx: { now?: string; lang?: Lang } = {}): Plan {
  const text = raw.replace(/^\s*(hey\s+|oye\s+)?alexa[,!.\s]*/i, '').trim();
  const t = text.toLowerCase();
  const { lang: detected, explicit } = detectLang(text);
  const lang: Lang = ctx.lang && !explicit ? ctx.lang : detected;
  const base: any = { household_id: hid, lang };
  if (ctx.now) base.now = ctx.now;
  const meds = extractMeds(text);
  const med = meds[0] || null;
  const step = (tool: string, args: any, why: string): Step => ({ tool, args: { ...base, ...args }, why });
  const P = (intent: string, ...steps: Step[]): Plan => ({ intent, lang, steps });

  // caregiver briefing
  if (/\b(briefing|daily summary|how('s| is) (dad|mom|my (father|mother|dad|mom))|how did (dad|mom) do|resumen|cómo va|como va|cómo está (papá|mamá)|briefing do|haal)\b/.test(t))
    return P('daily_briefing', step('daily_briefing', {}, 'caregiver asked for the daily briefing'));
  // interactions: "can I take X", "is it safe to take X with my meds", "puedo tomar X", "X le sakta hoon"
  if (/\b(can i (take|have|use)|is it (ok|okay|safe) to take|safe to take|ok to take|mix|together with|puedo tomar|se puede tomar|es seguro tomar|le sakta|le sakti|le sakte|ले सकता|ले सकती)\b/.test(t) || /\bwith my (meds|medicines|pills)\b/.test(t)) {
    const cand = med || unknownMedAfter(text, /(?:take|have|use|tomar)\s+(?:an?\s+|some\s+|un\s+|una\s+)?([A-Za-z\-]{3,})/i) || s.lastMed || null;
    if (!cand) return { intent: 'check_interactions', lang, steps: [], ask: { en: 'Which medicine are you thinking of taking?', es: '¿Qué medicamento quiere tomar?', hi: 'आप कौन सी दवा लेना चाहते हैं?' }[lang] };
    s.lastMed = cand;
    return P('check_interactions', step('check_interactions', { candidate: cand }, 'check a candidate against the list before taking it'));
  }
  if (/\b(interactions?|check my (meds|medicines|list)|revisa mis medicamentos|interacciones)\b/.test(t))
    return P('check_interactions', step('check_interactions', {}, 'check the whole list'));
  // explain
  if (/\b(what('s| is) .{0,30}\bfor\b|what does .{2,30} do|explain|tell me about|side effects|para qué (es|sirve)|para que (es|sirve)|explícame|explicame|qué es|efectos secundarios|kis liye|ke baare mein|samjhao|क्या है|किस लिए)\b/.test(t)) {
    const m2 = med || unknownMedAfter(text, /(?:about|explain|is|es|explícame|explicame)\s+(?:the\s+|my\s+|el\s+|la\s+)?([A-Za-z\-]{3,})/i) || s.lastMed;
    if (!m2) return { intent: 'explain_medicine', lang, steps: [], ask: { en: 'Which medicine should I explain?', es: '¿Qué medicamento le explico?', hi: 'कौन सी दवा समझाऊं?' }[lang] };
    s.lastMed = m2;
    return P('explain_medicine', step('explain_medicine', { medicine: m2 }, `plain-language explanation (${lang})`));
  }
  // what now (before "add": "what do I take" contains "I take")
  if (/\b(what (do|should|can) i take|what('s| is) (next|due)|take now|which (pill|pills|medicine)|my pills now|qué (me )?toca|que (me )?toca|qué tomo|que tomo|abhi kaunsi|kya lena|अभी कौन)\b/.test(t)) return P('what_next', step('what_next', {}, 'doses due now'));
  // add
  if (/\b(add|i (now )?take|start(ed)? taking|new medicine|new prescription|remind me to take|agrega|añade|agregar|empecé a tomar|jodo|add karo)\b/.test(t) && !/\b(took|taken)\b/.test(t)) {
    const name = med || unknownMedAfter(text, /(?:add|take|taking|agrega|añade)\s+([A-Za-z\-]{3,})/i);
    const times = extractTimes(text);
    const strength = text.match(/\b\d+(\.\d+)?\s*(mg|mcg|g)\b/i)?.[0] || undefined;
    const pills = text.match(/\b(\d{1,4})\s*(tablets|pills|capsules|tabletas|pastillas)\s*(left|on hand|in the bottle)?\b/i);
    const per = text.match(/\b(two|2) (tablets|pills) (each time|per dose|at a time)\b/i);
    if (!name) return { intent: 'add_medicine', lang, steps: [], ask: { en: 'What is the medicine called?', es: '¿Cómo se llama el medicamento?', hi: 'दवा का नाम क्या है?' }[lang] };
    if (!times.length) return { intent: 'add_medicine', lang, steps: [], ask: { en: `What time do you take ${name}?`, es: `¿A qué hora toma ${name}?`, hi: `${name} किस समय लेते हैं?` }[lang] };
    s.lastMed = name;
    return P('add_medicine', step('add_medicine', { name, times, strength, pills_left: pills ? Number(pills[1]) : undefined, units_per_dose: per ? 2 : undefined }, 'add to the schedule, then check it against the list'));
  }
  // taken / skipped
  if (/\b(i took|i('ve| have) taken|took my|just took|done with|ya tomé|ya tome|me tomé|me tome|tomé mi|le li|kha li|ले ली|खा ली)\b/.test(t)) {
    const steps = [step('mark_taken', { medicine: med || undefined }, med ? `log ${med} as taken` : 'log every dose due now')];
    if (/\b(what('s| is) next|next|y ahora|qué sigue)\b/.test(t)) steps.push(step('what_next', {}, 'then say what is next'));
    return P('mark_taken', ...steps);
  }
  if (/\b(skip|skipping|no voy a tomar|omitir)\b/.test(t)) return P('mark_taken', step('mark_taken', { medicine: med || undefined, status: 'skipped' }, 'log as skipped'));
  // missed
  if (/\b(miss(ed)?|forgot|forget|olvidé|olvide|se me olvidó|chhoot|bhool|छूट|भूल)\b/.test(t)) return P('check_missed_doses', step('check_missed_doses', {}, 'record missed doses and alert the family'));
  // refills
  if (/\b(refill|running (low|out)|pills left|how many (pills|tablets)|resurtir|cuántas pastillas|cuantas pastillas|me quedan|kitni goli)\b/.test(t)) return P('refill_reminder', step('refill_reminder', {}, 'days of supply from pill counts'));
  // message family
  const tell = text.match(/\b(?:tell|message|text|let)\s+(?:my\s+)?(daughter|son|[A-Z][a-z]+)\s+(?:know\s+)?(?:that\s+)?(.{3,200})$/i) || text.match(/\bdile a\s+(?:mi\s+)?(hija|hijo|[A-Z][a-z]+)\s+que\s+(.{3,200})$/i);
  if (tell) return P('family_alert', step('family_alert', { action: 'send', message: tell[2].replace(/[.!]$/, '') }, 'send a message to the caregiver (simulated)'));
  if (/\b(alerts?|family feed|notifications|avisos)\b/.test(t)) return P('family_alert', step('family_alert', { action: 'feed' }, 'show the family feed'));
  // schedule
  if (/\b(schedule|my (medicines|meds|pills)|list|today|horario|mis medicamentos|mis pastillas|meri dawaiyan)\b/.test(t) && !/\bnow\b/.test(t)) return P('list_schedule', step('list_schedule', {}, 'list the schedule'));
  // what now
  if (/\b(what (do|should) i take|what('s| is) (next|due)|take now|which (pill|medicine)|my pills now|qué (me )?toca|que (me )?toca|qué tomo|que tomo|abhi kaunsi|kya lena|अभी कौन)\b/.test(t) || /\bnow\b/.test(t)) return P('what_next', step('what_next', {}, 'doses due now'));
  if (med) { s.lastMed = med; return P('explain_medicine', step('explain_medicine', { medicine: med }, 'a medicine name on its own: explain it')); }
  return { intent: 'help', lang, steps: [] };
}
