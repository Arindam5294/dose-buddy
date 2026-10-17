// Dose Buddy core: medicines, schedule, dose log, missed-dose logic, interaction checks, explanations,
// refills, the simulated family-alert feed and the caregiver briefing. All state is per household.

import { DRUG_BY_KEY, findIngredient, norm, dailyMed, type Drug, type Lang } from '../data/drugs.js';
import { BRANDS, findBrand, type Brand } from '../data/brands.js';
import { PAIRS, type Pair, type Severity } from '../data/interactions.js';
import { labelBySetId, searchByName, mentionIn, quoteInLabel, firstSentences, OPENFDA_DISCLAIMER } from '../data/openfda.js';
import { worstProvenance, type Provenance } from '../data/http.js';
import { getHousehold, save, newId, type Household, type Med, type FeedItem } from './store.js';
import { DISCLAIMER, NEVER_STOP, CALL_DOCTOR, ASK_FIRST, fmtTime, SEV, list, tablets } from './i18n.js';

const GRACE = Number(process.env.DB_GRACE_MIN || 90);   // minutes after the scheduled time before a dose counts as missed
const EARLY = 60;                                        // a dose is "due" from 60 minutes before its time
export const SIM_NOTE = 'Simulated alert feed: no SMS, call, e-mail or push notification was sent.';

// ── clock ────────────────────────────────────────────────────────────────
export interface Now { date: string; time: string; minutes: number; simulated: boolean; iso: string; tz: string }
export function clock(h: Household, nowArg?: string): Now {
  const src = nowArg || process.env.DB_FIXED_NOW;
  const m = src && String(src).match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})/);
  if (m) return { date: m[1], time: `${m[2]}:${m[3]}`, minutes: Number(m[2]) * 60 + Number(m[3]), simulated: true, iso: `${m[1]}T${m[2]}:${m[3]}`, tz: h.tz };
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: h.tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date()).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}`, minutes: Number(p.hour) * 60 + Number(p.minute), simulated: false, iso: `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`, tz: h.tz };
}
const toMin = (hhmm: string) => { const [a, b] = hhmm.split(':').map(Number); return a * 60 + b; };
export function normTime(t: string): string | null {
  const s = String(t).trim().toLowerCase().replace(/\./g, '');
  const m = s.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm|a m|p m)?$/);
  if (!m) return null;
  let h = Number(m[1]); const min = Number(m[2] || 0); const ap = m[3]?.replace(' ', '');
  if (ap === 'pm' && h < 12) h += 12; if (ap === 'am' && h === 12) h = 0;
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

// ── names ────────────────────────────────────────────────────────────────
export const genericName = (key: string, lang: Lang) => DRUG_BY_KEY.get(key)?.names[lang] || key;
export function medLabel(m: Med, lang: Lang) {
  const g = m.ingredients.map((k) => genericName(k, lang)).join(' + ');
  return m.brand ? `${m.brand} (${g})` : g || m.name;
}
const shortName = (m: Med) => m.brand || m.name;

export interface Resolved { name: string; brand: Brand | null; ingredients: string[]; curated: boolean; via: Med['resolvedVia']; brandSource: string | null; openfda?: any }
export async function resolveMedicine(input: string): Promise<Resolved> {
  const raw = String(input || '').replace(/\b\d+(\.\d+)?\s*(mg|mcg|g|ml)\b/gi, '').replace(/[®™]/g, '').trim();
  const b = findBrand(raw);
  if (b) return { name: b.brand, brand: b, ingredients: b.ingredients, curated: true, via: 'curated_brand', brandSource: b.source };
  const d = findIngredient(raw);
  if (d) return { name: d.key, brand: null, ingredients: [d.key], curated: true, via: 'curated_generic', brandSource: null };
  // Not curated: ask openFDA (brand_name, then generic_name). Map its generic name back to curated keys where possible.
  const hit = await searchByName(raw).catch(() => null);
  if (hit) {
    const gen = String(hit.label.openfda?.generic_name?.[0] || '').toLowerCase();
    const parts = gen.split(/\s*(?:,| and |\/)\s*/).filter(Boolean);
    const keys = parts.map((p) => findIngredient(p)?.key || findIngredient(p.replace(/\s+(hydrochloride|sodium|potassium|calcium|besylate|maleate|citrate|bisulfate|magnesium)$/, ''))?.key || p);
    return { name: raw, brand: null, ingredients: keys, curated: keys.every((k) => DRUG_BY_KEY.has(k)), via: 'openfda', brandSource: hit.ref.url, openfda: hit.ref };
  }
  return { name: raw, brand: null, ingredients: [norm(raw)], curated: false, via: 'unresolved', brandSource: null };
}
export function findMed(h: Household, ref?: string | null): Med | null {
  if (!ref) return null;
  const r = norm(ref);
  return h.meds.find((m) => norm(m.name) === r || norm(m.brand || '') === r || m.ingredients.some((k) => norm(k) === r || norm(DRUG_BY_KEY.get(k)?.names.en || '') === r || DRUG_BY_KEY.get(k)?.synonyms.some((s) => norm(s) === r) || norm(DRUG_BY_KEY.get(k)?.names.es || '') === r))
    || h.meds.find((m) => norm(m.name).includes(r) || r.includes(norm(m.name)) || (m.brand && r.includes(norm(m.brand)))) || null;
}

// ── schedule ─────────────────────────────────────────────────────────────
export interface Slot { medId: string; med: string; label: string; time: string; status: 'taken' | 'missed' | 'skipped' | 'due' | 'overdue' | 'upcoming'; units: number; withFood: string | null; at?: string }
export function slotsFor(h: Household, now: Now, lang: Lang): Slot[] {
  const out: Slot[] = [];
  for (const m of h.meds) for (const t of m.times) {
    if (m.addedLocal && (m.addedLocal.slice(0, 10) > now.date || (m.addedLocal.slice(0, 10) === now.date && t < m.addedLocal.slice(11, 16)))) continue;
    const ev = h.doses.find((d) => d.medId === m.id && d.date === now.date && d.time === t);
    const tm = toMin(t);
    const status: Slot['status'] = ev ? ev.status : now.minutes < tm - EARLY ? 'upcoming' : now.minutes <= tm + GRACE ? 'due' : 'overdue';
    out.push({ medId: m.id, med: shortName(m), label: medLabel(m, lang), time: t, status, units: m.unitsPerDose, withFood: m.withFood, at: ev?.at });
  }
  return out.sort((a, b) => a.time.localeCompare(b.time) || a.med.localeCompare(b.med));
}
const daysLeft = (m: Med) => (m.pillsLeft == null || !m.times.length ? null : Math.floor(m.pillsLeft / (m.unitsPerDose * m.times.length)));

function withFoodFor(ingredients: string[], lang: Lang = 'en') {
  for (const k of ingredients) { const f = DRUG_BY_KEY.get(k)?.facts?.[lang] || DRUG_BY_KEY.get(k)?.facts?.en; if (f?.food) return f.food; }
  return null;
}

export async function addMedicine(hid: string, a: { name: string; strength?: string; times: string[]; units_per_dose?: number; pills_left?: number; refill_threshold_days?: number; now?: string; lang?: Lang }) {
  const h = getHousehold(hid);
  const lang = a.lang || h.patient.lang;
  const times = [...new Set((a.times || []).map(normTime).filter(Boolean) as string[])].sort();
  if (!times.length) throw new Error('Give at least one time, like "8 AM" or "20:00".');
  const r = await resolveMedicine(a.name);
  let label: Med['label'] = null; const modes: Provenance[] = [];
  const first = DRUG_BY_KEY.get(r.ingredients[0]);
  if (first?.setId) { const l = await labelBySetId(first.setId); if (l.ref) { label = { setId: l.ref.setId, url: l.ref.url, dataMode: l.ref.dataMode }; modes.push(l.ref.dataMode); } }
  else if (r.openfda) { label = { setId: r.openfda.setId, url: r.openfda.url, dataMode: r.openfda.dataMode }; modes.push(r.openfda.dataMode); }
  const existing = h.meds.find((m) => norm(m.name) === norm(r.name));
  const med: Med = existing || {
    id: newId(), name: r.name, brand: r.brand?.brand || null, ingredients: r.ingredients, curated: r.curated, resolvedVia: r.via, brandSource: r.brandSource,
    strength: a.strength || null, unitsPerDose: a.units_per_dose || 1, times, withFood: withFoodFor(r.ingredients, 'en'), pillsLeft: a.pills_left ?? null,
    refillThresholdDays: a.refill_threshold_days ?? 5, addedAt: new Date().toISOString(), addedLocal: clock(h, a.now).iso, label,
  };
  if (existing) { existing.times = times; if (a.strength) existing.strength = a.strength; if (a.pills_left != null) existing.pillsLeft = a.pills_left; if (a.units_per_dose) existing.unitsPerDose = a.units_per_dose; }
  else h.meds.push(med);
  save();
  // Check the new medicine against everything already on the list; serious combos notify the caregiver.
  const inter = await checkInteractions(hid, { lang, now: a.now, focusMedId: med.id, source: 'add' });
  const g = med.ingredients.map((k) => genericName(k, lang)).join(' + ');
  const when = list(times.map((t) => fmtTime(t, lang)), lang);
  const L = {
    en: `Added ${shortName(med)}${med.brand ? `, that's ${g},` : ''} at ${when}${med.strength ? `, ${med.strength}` : ''}.${med.pillsLeft != null ? ` ${med.pillsLeft} tablets on hand.` : ''}`,
    es: `Agregué ${shortName(med)}${med.brand ? `, que es ${g},` : ''} a las ${when}${med.strength ? `, ${med.strength}` : ''}.${med.pillsLeft != null ? ` Quedan ${med.pillsLeft} tabletas.` : ''}`,
    hi: `${shortName(med)}${med.brand ? ` (${g})` : ''} ${when} के लिए जोड़ दी।${med.pillsLeft != null ? ` ${med.pillsLeft} गोलियां बची हैं।` : ''}`,
  }[lang];
  const unres = !med.curated ? { en: ' I could not match it to my curated list, so interaction checks for it are limited.', es: ' No la encontré en mi lista curada, así que la revisión de interacciones es limitada.', hi: ' यह दवा मेरी सूची में नहीं मिली, इसलिए इंटरैक्शन जांच सीमित है।' }[lang] : '';
  const speech = [L + unres, inter.hits.length ? inter.speech : ''].filter(Boolean).join(' ');
  return { kind: 'medicine_added', med, resolution: { via: r.via, brandSource: r.brandSource, curated: r.curated }, interactions: inter, speech, dataMode: worstProvenance([...modes, inter.dataMode]), disclaimer: DISCLAIMER[lang] };
}

export function removeMedicine(hid: string, ref: string) {
  const h = getHousehold(hid); const m = findMed(h, ref);
  if (!m) return { removed: false, message: `I couldn't find ${ref} on the list.` };
  h.meds = h.meds.filter((x) => x.id !== m.id); save();
  return { removed: true, message: `Removed ${shortName(m)} from the schedule.` };
}

export function listSchedule(hid: string, a: { now?: string; lang?: Lang }) {
  const h = getHousehold(hid); const lang = a.lang || h.patient.lang; const now = clock(h, a.now);
  const slots = slotsFor(h, now, lang);
  const meds = h.meds.map((m) => ({ id: m.id, name: shortName(m), label: medLabel(m, lang), strength: m.strength, times: m.times, unitsPerDose: m.unitsPerDose, pillsLeft: m.pillsLeft, daysLeft: daysLeft(m), withFood: m.withFood, resolvedVia: m.resolvedVia, brandSource: m.brandSource, label_url: m.label?.url || null }));
  const byTime = [...new Set(slots.map((s) => s.time))].map((t) => `${fmtTime(t, lang)}: ${list(slots.filter((s) => s.time === t).map((s) => s.med), lang)}`);
  const speech = !meds.length ? { en: 'There are no medicines on the list yet.', es: 'Todavía no hay medicamentos en la lista.', hi: 'सूची में अभी कोई दवा नहीं है।' }[lang]
    : { en: `${meds.length} medicines a day. ${byTime.join('. ')}.`, es: `${meds.length} medicamentos al día. ${byTime.join('. ')}.`, hi: `रोज़ ${meds.length} दवाएं। ${byTime.join('। ')}।` }[lang];
  return { kind: 'schedule', patient: h.patient.name, now, meds, slots, speech, disclaimer: DISCLAIMER[lang] };
}

export function whatNext(hid: string, a: { now?: string; lang?: Lang }) {
  const h = getHousehold(hid); const lang = a.lang || h.patient.lang; const now = clock(h, a.now);
  const slots = slotsFor(h, now, lang);
  const due = slots.filter((s) => s.status === 'due');
  const overdue = slots.filter((s) => s.status === 'overdue');
  const next = slots.find((s) => s.status === 'upcoming');
  const parts: string[] = [];
  const item = (s: Slot) => `${s.med}, ${tablets(s.units, lang)}`;
  if (due.length) {
    const allOne = due.every((s) => s.units === 1);
    const what = allOne ? list(due.map((s) => s.med), lang) + (due.length > 1 ? { en: ', one tablet each', es: ', una tableta de cada uno', hi: ', हर एक की एक गोली' }[lang] : { en: ', one tablet', es: ', una tableta', hi: ', एक गोली' }[lang]) : list(due.map(item), lang);
    parts.push({ en: `It's ${fmtTime(now.time, lang)}. Time for ${what}.`, es: `Son las ${fmtTime(now.time, lang)}. Es hora de ${what}.`, hi: `अभी ${fmtTime(now.time, lang)} हैं। ${what} लेने का समय है।` }[lang]);
    // only food rules that matter (skip "with or without food")
    for (const s of due) {
      const m = h.meds.find((x) => x.id === s.medId)!;
      const f = DRUG_BY_KEY.get(m.ingredients[0])?.facts?.[lang]?.food || (lang === 'en' ? m.withFood : null);
      if (f && /meal|food|milk|stomach|breakfast|comida|alimento|leche|estómago|desayuno|खाने|पेट|नाश्ते|दूध/i.test(f) && !/with or without|con o sin|साथ या बिना/i.test(f)) parts.push(`${s.med}: ${f.charAt(0).toLowerCase() + f.slice(1)}`);
    }
  } else parts.push({ en: `It's ${fmtTime(now.time, lang)}. Nothing is due right now.`, es: `Son las ${fmtTime(now.time, lang)}. No le toca nada ahora.`, hi: `अभी ${fmtTime(now.time, lang)} हैं। इस समय कोई दवा नहीं लेनी है।` }[lang]);
  if (overdue.length) parts.push({ en: `You haven't taken ${list(overdue.map((s) => `the ${fmtTime(s.time, lang)} ${s.med}`), lang)} yet. Ask your pharmacist what to do about a late dose.`, es: `Todavía no ha tomado ${list(overdue.map((s) => `${s.med} de las ${fmtTime(s.time, lang)}`), lang)}. Pregunte a su farmacéutico qué hacer con una dosis atrasada.`, hi: `${list(overdue.map((s) => `${fmtTime(s.time, lang)} की ${s.med}`), lang)} अभी नहीं ली गई। देर से खुराक के बारे में फ़ार्मासिस्ट से पूछें।` }[lang]);
  if (next) parts.push({ en: `Next: ${next.med} at ${fmtTime(next.time, lang)}.`, es: `Después: ${next.med} a las ${fmtTime(next.time, lang)}.`, hi: `अगली दवा: ${next.med}, ${fmtTime(next.time, lang)}।` }[lang]);
  if (due.length) parts.push({ en: 'Tell me when you have taken it.', es: 'Avíseme cuando lo haya tomado.', hi: 'लेने के बाद मुझे बता दीजिए।' }[lang]);
  return { kind: 'what_next', patient: h.patient.name, now, due, overdue, next: next || null, slots, speech: parts.join(' '), disclaimer: DISCLAIMER[lang] };
}

export function markTaken(hid: string, a: { medicine?: string; time?: string; status?: 'taken' | 'skipped'; now?: string; lang?: Lang }) {
  const h = getHousehold(hid); const lang = a.lang || h.patient.lang; const now = clock(h, a.now);
  const status = a.status || 'taken';
  const slots = slotsFor(h, now, lang);
  let targets: Slot[];
  const med = a.medicine ? findMed(h, a.medicine) : null;
  if (a.medicine && !med) return { kind: 'dose_logged', logged: [], speech: { en: `I couldn't find ${a.medicine} on the list.`, es: `No encontré ${a.medicine} en la lista.`, hi: `${a.medicine} सूची में नहीं मिली।` }[lang], disclaimer: DISCLAIMER[lang] };
  const open = slots.filter((s) => s.status === 'due' || s.status === 'overdue' || s.status === 'missed');
  if (med) {
    const mine = slots.filter((s) => s.medId === med.id && s.status !== 'taken' && s.status !== 'skipped');
    const t = a.time ? normTime(a.time) : null;
    targets = t ? mine.filter((s) => s.time === t) : [mine.filter((s) => s.status !== 'upcoming').sort((x, y) => Math.abs(toMin(x.time) - now.minutes) - Math.abs(toMin(y.time) - now.minutes))[0] || mine[0]].filter(Boolean);
  } else targets = open.filter((s) => s.status === 'due');
  const logged: any[] = []; const lowStock: string[] = [];
  for (const s of targets) {
    const m = h.meds.find((x) => x.id === s.medId)!;
    const prev = h.doses.find((d) => d.medId === m.id && d.date === now.date && d.time === s.time);
    const late = now.minutes > toMin(s.time) + GRACE;
    if (prev) { prev.status = status; prev.at = now.iso; prev.late = late; } else h.doses.push({ id: newId(), medId: m.id, date: now.date, time: s.time, status, at: now.iso, late });
    if (status === 'taken' && m.pillsLeft != null) { m.pillsLeft = Math.max(0, m.pillsLeft - m.unitsPerDose); const dl = daysLeft(m); if (dl != null && dl <= m.refillThresholdDays) lowStock.push(`${shortName(m)} (${m.pillsLeft})`); }
    logged.push({ med: shortName(m), time: s.time, status, pillsLeft: m.pillsLeft, late });
  }
  save();
  let speech: string;
  if (!logged.length) speech = { en: 'Nothing is due right now, so I did not log anything.', es: 'No le toca nada ahora, así que no registré nada.', hi: 'अभी कोई दवा बाकी नहीं है, इसलिए कुछ दर्ज नहीं किया।' }[lang];
  else {
    const names = list(logged.map((l) => l.med), lang);
    speech = status === 'taken'
      ? { en: `Got it. ${names} marked as taken at ${fmtTime(now.time, lang)}.`, es: `Entendido. ${names} registrado como tomado a las ${fmtTime(now.time, lang)}.`, hi: `ठीक है। ${names} ${fmtTime(now.time, lang)} पर ली गई दर्ज कर दी।` }[lang]
      : { en: `Okay, ${names} marked as skipped.`, es: `De acuerdo, ${names} marcado como omitido.`, hi: `ठीक है, ${names} छोड़ी गई दर्ज की।` }[lang];
    if (lowStock.length) speech += ' ' + { en: `Running low: ${list(lowStock, lang)} left. Time to ask for a refill.`, es: `Quedan pocas: ${list(lowStock, lang)}. Es momento de pedir más.`, hi: `कम बची हैं: ${list(lowStock, lang)}। रीफ़िल मंगवाने का समय है।` }[lang];
  }
  return { kind: 'dose_logged', now, logged, slots: slotsFor(h, now, lang), speech, disclaimer: DISCLAIMER[lang] };
}

// ── simulated family alerts ──────────────────────────────────────────────
function pushFeed(h: Household, now: Now, f: Omit<FeedItem, 'id' | 'at' | 'simNow' | 'to' | 'channel' | 'seen'>) {
  if (h.feed.some((x) => x.dedupe === f.dedupe)) return null;
  const item: FeedItem = { id: newId(), at: new Date().toISOString(), simNow: now.simulated ? now.iso : null, to: h.caregiver?.name || 'caregiver', channel: 'simulated', seen: false, ...f };
  h.feed.unshift(item); h.feed = h.feed.slice(0, 200);
  return item;
}

export function checkMissed(hid: string, a: { now?: string; lang?: Lang }) {
  const h = getHousehold(hid); const lang = a.lang || h.patient.lang; const now = clock(h, a.now);
  const overdue = slotsFor(h, now, lang).filter((s) => s.status === 'overdue');
  const alerts: FeedItem[] = [];
  for (const s of overdue) {
    const m = h.meds.find((x) => x.id === s.medId)!;
    h.doses.push({ id: newId(), medId: m.id, date: now.date, time: s.time, status: 'missed', at: now.iso });
    const it = pushFeed(h, now, { kind: 'missed_dose', severity: 'warning', title: 'Missed dose', message: `${h.patient.name} hasn't taken the ${fmtTime(s.time, 'en')} ${medLabel(m, 'en')} (checked at ${fmtTime(now.time, 'en')}). Dose Buddy reminded ${h.patient.name} and suggested asking the pharmacist about the late dose.`, dedupe: `missed:${m.id}:${now.date}:${s.time}` });
    if (it) alerts.push(it);
  }
  save();
  const missedToday = h.doses.filter((d) => d.date === now.date && d.status === 'missed').map((d) => ({ med: shortName(h.meds.find((m) => m.id === d.medId)!), time: d.time }));
  const cg = h.caregiver?.name || { en: 'your family', es: 'su familia', hi: 'आपके परिवार' }[lang];
  const speech = !overdue.length
    ? { en: 'No missed doses right now.', es: 'No hay dosis olvidadas en este momento.', hi: 'इस समय कोई खुराक छूटी नहीं है।' }[lang]
    : { en: `You missed ${list(overdue.map((s) => `the ${fmtTime(s.time, lang)} ${s.med}`), lang)}. I've let ${cg} know. Please ask your pharmacist what to do about a missed dose.`, es: `Olvidó ${list(overdue.map((s) => `${s.med} de las ${fmtTime(s.time, lang)}`), lang)}. Le avisé a ${cg}. Pregunte a su farmacéutico qué hacer con una dosis olvidada.`, hi: `${list(overdue.map((s) => `${fmtTime(s.time, lang)} की ${s.med}`), lang)} छूट गई। मैंने ${cg} को बता दिया है। छूटी खुराक के बारे में फ़ार्मासिस्ट से पूछें।` }[lang];
  return { kind: 'missed_check', now, newlyMissed: overdue.map((s) => ({ med: s.med, time: s.time })), missedToday, alerts, caregiver: h.caregiver, channel: 'simulated', simulatedNote: SIM_NOTE, speech, disclaimer: DISCLAIMER[lang] };
}

export function familyAlert(hid: string, a: { action: 'send' | 'feed' | 'set_caregiver'; message?: string; caregiver_name?: string; relation?: string; city?: string; patient_name?: string; patient_lang?: Lang; now?: string; lang?: Lang }) {
  const h = getHousehold(hid); const lang = a.lang || h.patient.lang; const now = clock(h, a.now);
  if (a.action === 'set_caregiver') {
    if (a.caregiver_name) h.caregiver = { name: a.caregiver_name, relation: a.relation || h.caregiver?.relation || 'family', city: a.city || h.caregiver?.city || null };
    if (a.patient_name) h.patient.name = a.patient_name;
    if (a.patient_lang) h.patient.lang = a.patient_lang;
    save();
    return { kind: 'feed', caregiver: h.caregiver, patient: h.patient, feed: h.feed.slice(0, 20), channel: 'simulated', simulatedNote: SIM_NOTE, speech: `${h.caregiver?.name || 'The caregiver'} will get Dose Buddy alerts for ${h.patient.name} (simulated feed in this demo).`, disclaimer: DISCLAIMER[lang] };
  }
  if (a.action === 'send') {
    const msg = String(a.message || '').slice(0, 300) || 'Please give me a call.';
    const it = pushFeed(h, now, { kind: 'message', severity: 'info', title: `Message from ${h.patient.name}`, message: msg, dedupe: `msg:${newId()}` });
    save();
    const cg = h.caregiver?.name || { en: 'your family', es: 'su familia', hi: 'आपके परिवार' }[lang];
    return { kind: 'feed', sent: it, caregiver: h.caregiver, feed: h.feed.slice(0, 20), channel: 'simulated', simulatedNote: SIM_NOTE, speech: { en: `I've sent that to ${cg}. This demo uses a simulated alert feed.`, es: `Se lo envié a ${cg}. Esta demo usa un aviso simulado.`, hi: `मैंने ${cg} को भेज दिया। इस डेमो में अलर्ट सिम्युलेटेड हैं।` }[lang], disclaimer: DISCLAIMER[lang] };
  }
  return { kind: 'feed', caregiver: h.caregiver, feed: h.feed.slice(0, 30), unseen: h.feed.filter((f) => !f.seen).length, channel: 'simulated', simulatedNote: SIM_NOTE, speech: h.feed.length ? `${h.feed.length} alert${h.feed.length > 1 ? 's' : ''} in the family feed. Latest: ${h.feed[0].title}: ${h.feed[0].message}` : 'The family feed is empty.', disclaimer: DISCLAIMER[lang] };
}

// ── interactions ─────────────────────────────────────────────────────────
const classesOf = (k: string) => DRUG_BY_KEY.get(k)?.classes || [];
const sideMatch = (side: string[], k: string) => side.some((s) => (s.startsWith('class:') ? classesOf(k).includes(s.slice(6)) : s === k));
const SEV_RANK: Record<string, number> = { severe: 3, high: 2, moderate: 1, label: 0 };

interface Item { id: string; name: string; label: string; ingredients: string[]; candidate: boolean }

export async function checkInteractions(hid: string, a: { candidate?: string; lang?: Lang; now?: string; focusMedId?: string; source?: 'add' | 'ask' | 'list' | 'briefing'; notify?: boolean }) {
  const h = getHousehold(hid); const lang = a.lang || h.patient.lang; const now = clock(h, a.now);
  const items: Item[] = h.meds.map((m) => ({ id: m.id, name: shortName(m), label: medLabel(m, lang), ingredients: m.ingredients, candidate: false }));
  let cand: Resolved | null = null;
  if (a.candidate) {
    cand = await resolveMedicine(a.candidate);
    const already = items.find((i) => norm(i.name) === norm(cand!.name));
    if (already) already.candidate = true;
    else items.push({ id: 'candidate', name: cand.brand?.brand || cand.name, label: cand.brand ? `${cand.brand.brand} (${cand.ingredients.map((k) => genericName(k, lang)).join(' + ')})` : cand.ingredients.map((k) => genericName(k, lang)).join(' + '), ingredients: cand.ingredients, candidate: true });
  }
  const focus = (x: Item, y: Item) => (a.focusMedId ? x.id === a.focusMedId || y.id === a.focusMedId : a.candidate ? x.candidate || y.candidate : true);
  const hits: any[] = []; const mentions: any[] = []; const modes: Provenance[] = [];
  const labelCache = new Map<string, any>();
  const getLabel = async (setId: string) => { if (!labelCache.has(setId)) labelCache.set(setId, await labelBySetId(setId)); return labelCache.get(setId); };
  for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
    const x = items[i], y = items[j];
    if (!focus(x, y)) continue;
    let curatedHit = false;
    for (const ka of x.ingredients) for (const kb of y.ingredients) for (const p of PAIRS) {
      let A: Item | null = null, B: Item | null = null, ia = '', ib = '';
      if (sideMatch(p.a, ka) && sideMatch(p.b, kb)) { A = x; B = y; ia = ka; ib = kb; }
      else if (sideMatch(p.a, kb) && sideMatch(p.b, ka)) { A = y; B = x; ia = kb; ib = ka; }
      if (!A || !B) continue;
      if (hits.some((hh) => hh.pairId === p.id && [hh.a.id, hh.b.id].sort().join() === [A!.id, B!.id].sort().join())) continue;
      curatedHit = true;
      const l = await getLabel(p.source.setId);
      if (l.ref) modes.push(l.ref.dataMode);
      hits.push({
        pairId: p.id, severity: p.severity, severityLabel: SEV[lang][p.severity],
        a: { id: A.id, name: A.name, label: A.label, ingredient: ia, candidate: A.candidate }, b: { id: B.id, name: B.name, label: B.label, ingredient: ib, candidate: B.candidate },
        risk: p.risk[lang], source: { ...p.source, url: dailyMed(p.source.setId), verifiedInLiveLabel: l.label ? quoteInLabel(l.label, p.source.quote) : false, labelEffective: l.ref?.effectiveTime || null, dataMode: l.ref?.dataMode || null, curated: true },
      });
    }
    if (curatedHit) continue;
    // openFDA label scan: does one label name the other ingredient? (lower confidence, shown for review)
    for (const [P, Q] of [[x, y], [y, x]] as [Item, Item][]) for (const kp of P.ingredients) {
      const dp = DRUG_BY_KEY.get(kp); if (!dp?.setId) continue;
      const l = await getLabel(dp.setId); if (!l.label) continue;
      modes.push(l.ref.dataMode);
      for (const kq of Q.ingredients) { const dq = DRUG_BY_KEY.get(kq); if (!dq) continue; const ex = mentionIn(l.label, dq); if (ex && !mentions.some((m) => m.a.id === P.id && m.b.id === Q.id)) mentions.push({ severity: 'label', severityLabel: SEV[lang].label, a: { id: P.id, name: P.name, ingredient: kp }, b: { id: Q.id, name: Q.name, ingredient: kq }, excerpt: ex, source: { label: `${dp.names.en} (FDA label)`, setId: dp.setId, url: dailyMed(dp.setId), dataMode: l.ref.dataMode, curated: false } }); }
    }
  }
  hits.sort((p, q) => SEV_RANK[q.severity] - SEV_RANK[p.severity]);
  const top = hits[0]?.severity as Severity | undefined;
  // Speech
  const parts: string[] = [];
  const candName = items.find((i) => i.candidate)?.name;
  if (!hits.length) {
    parts.push(a.candidate
      ? { en: `I didn't find ${candName} with your medicines in my curated high-risk list.`, es: `No encontré ${candName} en mi lista curada de combinaciones de alto riesgo con sus medicamentos.`, hi: `मेरी जोखिम-सूची में ${candName} का आपकी दवाओं से कोई गंभीर मेल नहीं मिला।` }[lang]
      : { en: 'No combinations from my curated high-risk list were found.', es: 'No encontré combinaciones de mi lista curada de alto riesgo.', hi: 'मेरी जोखिम-सूची की कोई ख़तरनाक जोड़ी नहीं मिली।' }[lang]);
    parts.push({ en: 'That list is small, so it is not a guarantee.', es: 'Esa lista es pequeña, así que no es una garantía.', hi: 'यह सूची छोटी है, इसलिए यह कोई गारंटी नहीं है।' }[lang]);
    if (mentions.length) parts.push({ en: `The FDA labels also mention ${mentions.length} combination${mentions.length > 1 ? 's' : ''} worth reviewing with your pharmacist.`, es: `Las etiquetas de la FDA mencionan ${mentions.length} combinación(es) para revisar con su farmacéutico.`, hi: `FDA लेबल में ${mentions.length} जोड़ी का ज़िक्र है, फ़ार्मासिस्ट से पूछें।` }[lang]);
  } else {
    const say = hits.slice(0, 2).map((x) => {
      const other = x.a.candidate ? x.b : x.a; const c = x.a.candidate ? x.a : x.b;
      const pairTxt = a.candidate ? { en: `${c.name} with ${other.name}`, es: `${c.name} con ${other.name}`, hi: `${c.name} के साथ ${other.name}` }[lang] : { en: `${x.a.name} with ${x.b.name}`, es: `${x.a.name} con ${x.b.name}`, hi: `${x.a.name} के साथ ${x.b.name}` }[lang];
      return `${pairTxt}: ${x.risk}.`;
    });
    const intro = a.candidate
      ? { en: `Careful. ${candName} contains ${list(cand!.ingredients.map((k) => genericName(k, lang)), lang)}. I found ${hits.length} warning${hits.length > 1 ? 's' : ''} from FDA drug labels.`, es: `Cuidado. ${candName} contiene ${list(cand!.ingredients.map((k) => genericName(k, lang)), lang)}. Encontré ${hits.length} advertencia${hits.length > 1 ? 's' : ''} en etiquetas de la FDA.`, hi: `सावधान। ${candName} में ${list(cand!.ingredients.map((k) => genericName(k, lang)), lang)} है। FDA लेबल से ${hits.length} चेतावनी मिलीं।` }[lang]
      : { en: `I found ${hits.length} warning${hits.length > 1 ? 's' : ''} from FDA drug labels.`, es: `Encontré ${hits.length} advertencia${hits.length > 1 ? 's' : ''} en etiquetas de la FDA.`, hi: `FDA लेबल से ${hits.length} चेतावनी मिलीं।` }[lang];
    parts.push(intro, ...say);
    if (a.candidate && (top === 'severe' || top === 'high')) parts.push(ASK_FIRST[lang](candName!));
    else if (a.candidate) parts.push({ en: `Check with your pharmacist before taking ${candName}.`, es: `Consulte a su farmacéutico antes de tomar ${candName}.`, hi: `${candName} लेने से पहले फ़ार्मासिस्ट से पूछें।` }[lang]);
    if (!a.candidate && (top === 'severe' || top === 'high')) parts.push(CALL_DOCTOR[lang]);
    if (!a.candidate && top === 'moderate') parts.push({ en: 'Mention this to your pharmacist at your next visit.', es: 'Coménteselo a su farmacéutico en su próxima visita.', hi: 'अगली बार फ़ार्मासिस्ट को यह ज़रूर बताएं।' }[lang]);
    parts.push(NEVER_STOP[lang]);
  }
  // Serious combos notify the caregiver (simulated feed).
  let alert: FeedItem | null = null;
  if (a.notify !== false && (top === 'severe' || top === 'high') && a.source !== 'briefing' && a.source !== 'list') {
    const what = a.candidate ? `asked about taking ${candName}` : 'has a new medicine on the list';
    alert = pushFeed(h, now, { kind: 'risky_combo', severity: top === 'severe' ? 'urgent' : 'warning', title: top === 'severe' ? 'Serious medicine warning' : 'Medicine warning', message: `${h.patient.name} ${what}. ${hits.slice(0, 2).map((x) => `${x.a.name} + ${x.b.name}: ${x.risk.replace(/\.$/, '')} (source: ${x.source.label})`).join('; ')}. ${h.patient.name} was told to check with the doctor or pharmacist first and not to stop any medicine.`, dedupe: `combo:${hits.map((x) => x.pairId + x.a.name + x.b.name).sort().join('|')}:${now.date}` });
  }
  const result = { kind: 'interactions', patient: h.patient.name, candidate: cand ? { name: candName, ingredients: cand.ingredients, via: cand.via, brandSource: cand.brandSource } : null, checked: items.map((i) => ({ name: i.name, label: i.label, candidate: i.candidate })), hits, labelMentions: mentions, topSeverity: top || null, alert, channel: 'simulated', speech: [...parts, DISCLAIMER[lang]].join(' '), disclaimer: DISCLAIMER[lang], openfdaDisclaimer: OPENFDA_DISCLAIMER, dataMode: worstProvenance(modes), coverageNote: 'Curated table of 17 FDA-label-cited high-risk pairs plus an openFDA label text scan. Not a complete interaction database.' };
  const summary = { at: now.iso, date: now.date, candidate: result.candidate?.name || null, hits: hits.map((x) => ({ pairId: x.pairId, severity: x.severity, a: x.a.name, b: x.b.name, risk: x.risk, source: x.source.label })), source: a.source || 'ask' };
  if (a.source !== 'briefing') h.lastInteractionCheck = summary;
  if (cand) (h as any).lastQuestion = summary;
  save();
  return result;
}

// ── explanations ─────────────────────────────────────────────────────────
export async function explainMedicine(hid: string, a: { medicine: string; lang?: Lang }) {
  const h = getHousehold(hid); const lang = a.lang || h.patient.lang;
  const onList = findMed(h, a.medicine);
  const r: Resolved = onList ? { name: shortName(onList), brand: onList.brand ? BRANDS.find((b) => b.brand === onList.brand) || null : null, ingredients: onList.ingredients, curated: onList.curated, via: onList.resolvedVia, brandSource: onList.brandSource } : await resolveMedicine(a.medicine);
  const sections: any[] = []; const modes: Provenance[] = []; const speech: string[] = [];
  const display = r.brand?.brand || (DRUG_BY_KEY.get(r.ingredients[0])?.names[lang] ?? r.name);
  if (r.brand) speech.push({ en: `${r.brand.brand} is ${list(r.ingredients.map((k) => genericName(k, lang)), lang)}.`, es: `${r.brand.brand} es ${list(r.ingredients.map((k) => genericName(k, lang)), lang)}.`, hi: `${r.brand.brand} में ${list(r.ingredients.map((k) => genericName(k, lang)), lang)} है।` }[lang]);
  let translated = false;
  for (const k of r.ingredients) {
    const d: Drug | undefined = DRUG_BY_KEY.get(k);
    const f = d?.facts?.[lang] || d?.facts?.en; if (d?.facts?.[lang] == null && d?.facts?.en) translated = lang !== 'en';
    let fda: any = null;
    const l: any = d?.setId ? await labelBySetId(d.setId) : await searchByName(k).catch(() => null);
    if (l && l.label) {
      modes.push(l.ref.dataMode);
      fda = { setId: l.ref.setId, url: l.ref.url, effectiveTime: l.ref.effectiveTime, dataMode: l.ref.dataMode, indicationsExcerpt: firstSentences(l.label.indications_and_usage?.[0] || l.label.purpose?.[0]), hasBoxedWarning: !!l.label.boxed_warning, boxedWarningExcerpt: firstSentences(l.label.boxed_warning?.[0], 220) };
    }
    sections.push({ ingredient: k, name: d?.names[lang] || k, facts: f || null, factsLang: d?.facts?.[lang] ? lang : f ? 'en' : null, medlineplus: d?.medlineplus ? d.medlineplus[lang === 'es' ? 'es' : 'en'] : null, fda });
    if (f) speech.push(r.ingredients.length > 1 ? `${d!.names[lang]}: ${f.purpose}` : f.purpose, f.food, f.sideEffects, f.tip || '');
    else if (fda?.indicationsExcerpt) speech.push({ en: `I don't have a plain-language summary for ${k}. Its FDA label says: ${fda.indicationsExcerpt}`, es: `No tengo un resumen sencillo de ${k}. Su etiqueta de la FDA dice (en inglés): ${fda.indicationsExcerpt}`, hi: `${k} का सरल सारांश मेरे पास नहीं है। FDA लेबल (अंग्रेज़ी में): ${fda.indicationsExcerpt}` }[lang]);
    else speech.push({ en: `I couldn't find reliable information for ${k}. Please ask your pharmacist.`, es: `No encontré información confiable sobre ${k}. Pregunte a su farmacéutico.`, hi: `${k} की भरोसेमंद जानकारी नहीं मिली। फ़ार्मासिस्ट से पूछें।` }[lang]);
    if (fda?.hasBoxedWarning) speech.push({ en: 'Its FDA label carries a boxed warning; I am showing it on screen.', es: 'Su etiqueta de la FDA tiene una advertencia en recuadro; la muestro en pantalla.', hi: 'इसके FDA लेबल पर बॉक्स्ड चेतावनी है; मैं इसे स्क्रीन पर दिखा रहा हूँ।' }[lang]);
  }
  if (translated) speech.push({ en: '', es: '(No tengo este resumen en español; se muestra en inglés.)', hi: '(यह सारांश हिंदी में उपलब्ध नहीं है; अंग्रेज़ी में दिखाया गया है।)' }[lang]);
  const sourceNote = { en: 'Sources: MedlinePlus and the FDA label.', es: 'Fuentes: MedlinePlus en español y la etiqueta de la FDA.', hi: 'स्रोत: MedlinePlus (हिंदी अनुवाद: Dose Buddy) और FDA लेबल।' }[lang];
  return { kind: 'explanation', medicine: display, brand: r.brand ? { name: r.brand.brand, source: r.brand.source, markets: r.brand.markets } : null, ingredients: r.ingredients, lang, sections, sourceNote, curated: r.curated, speech: [...speech.filter(Boolean), sourceNote, DISCLAIMER[lang]].join(' '), disclaimer: DISCLAIMER[lang], openfdaDisclaimer: OPENFDA_DISCLAIMER, dataMode: worstProvenance(modes) };
}

// ── refills ──────────────────────────────────────────────────────────────
export function refillReminder(hid: string, a: { now?: string; lang?: Lang; threshold_days?: number; set?: { medicine: string; pills_left: number } }) {
  const h = getHousehold(hid); const lang = a.lang || h.patient.lang; const now = clock(h, a.now);
  if (a.set) { const m = findMed(h, a.set.medicine); if (m) { m.pillsLeft = a.set.pills_left; save(); } }
  const rows = h.meds.map((m) => ({ med: shortName(m), label: medLabel(m, lang), pillsLeft: m.pillsLeft, perDay: m.unitsPerDose * m.times.length, daysLeft: daysLeft(m), threshold: a.threshold_days ?? m.refillThresholdDays, refillBy: null as string | null }));
  for (const r of rows) if (r.daysLeft != null) { const d = new Date(now.date + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + r.daysLeft); r.refillBy = d.toISOString().slice(0, 10); }
  const due = rows.filter((r) => r.daysLeft != null && r.daysLeft <= r.threshold);
  const alerts: FeedItem[] = [];
  for (const r of due) { const it = pushFeed(h, now, { kind: 'refill', severity: r.daysLeft! <= 2 ? 'warning' : 'info', title: 'Refill soon', message: `${h.patient.name}'s ${r.label}: ${r.pillsLeft} tablets left, about ${r.daysLeft} day${r.daysLeft === 1 ? '' : 's'} at ${r.perDay} a day.`, dedupe: `refill:${r.med}:${now.date}` }); if (it) alerts.push(it); }
  save();
  const unknown = rows.filter((r) => r.pillsLeft == null).map((r) => r.med);
  const speech = due.length
    ? { en: `Refill soon: ${list(due.map((r) => `${r.med}, about ${r.daysLeft} day${r.daysLeft === 1 ? '' : 's'} left`), lang)}.`, es: `Pedir pronto: ${list(due.map((r) => `${r.med}, quedan unos ${r.daysLeft} días`), lang)}.`, hi: `जल्द रीफ़िल करें: ${list(due.map((r) => `${r.med}, लगभग ${r.daysLeft} दिन की बची`), lang)}।` }[lang]
    : { en: 'No refills needed this week.', es: 'No hace falta pedir más esta semana.', hi: 'इस हफ़्ते रीफ़िल की ज़रूरत नहीं है।' }[lang];
  return { kind: 'refills', now, rows, due, unknownCounts: unknown, alerts, channel: 'simulated', speech: speech + (unknown.length ? ` (${unknown.length} without a pill count.)` : ''), disclaimer: DISCLAIMER[lang] };
}

// ── caregiver briefing ───────────────────────────────────────────────────
export async function dailyBriefing(hid: string, a: { now?: string; lang?: Lang }) {
  const h = getHousehold(hid); const lang = a.lang || 'en'; const now = clock(h, a.now);
  const slots = slotsFor(h, now, lang);
  const soFar = slots.filter((s) => s.status !== 'upcoming');
  const taken = soFar.filter((s) => s.status === 'taken');
  const missed = soFar.filter((s) => s.status === 'missed' || s.status === 'overdue');
  const late = h.doses.filter((d) => d.date === now.date && d.status === 'taken' && d.late).length;
  const inter = await checkInteractions(hid, { lang, now: a.now, source: 'briefing', notify: false });
  const refills = refillReminder(hid, { now: a.now, lang });
  const since = h.lastBriefingAt;
  const feed = h.feed.filter((f) => !f.seen);
  const lq = (h as any).lastQuestion;
  const asked = lq && lq.candidate && lq.date === now.date ? lq : null;
  const candidateAlert = asked && asked.hits.length ? true : null;
  const P = h.patient.name;
  const parts: string[] = [];
  parts.push({ en: `Here's ${P}'s day so far.`, es: `Así va el día de ${P}.`, hi: `${P} का आज का हाल।` }[lang]);
  parts.push(soFar.length ? { en: `${taken.length} of ${soFar.length} doses due so far were taken${late ? `, ${late} late` : ''}.`, es: `Tomó ${taken.length} de ${soFar.length} dosis hasta ahora${late ? `, ${late} con retraso` : ''}.`, hi: `अब तक की ${soFar.length} में से ${taken.length} खुराक ली गईं।` }[lang] : { en: 'No doses were due yet today.', es: 'Todavía no le tocaba ninguna dosis hoy.', hi: 'आज अभी तक कोई खुराक नहीं थी।' }[lang]);
  if (missed.length) parts.push({ en: `Missed: ${list(missed.map((s) => `${s.med} at ${fmtTime(s.time, lang)}`), lang)}.`, es: `Olvidadas: ${list(missed.map((s) => `${s.med} a las ${fmtTime(s.time, lang)}`), lang)}.`, hi: `छूटी: ${list(missed.map((s) => `${fmtTime(s.time, lang)} की ${s.med}`), lang)}।` }[lang]);
  if (candidateAlert && asked) parts.push({ en: `${P} asked about ${asked.candidate}. I flagged ${asked.hits.length} warning${asked.hits.length === 1 ? '' : 's'} from FDA labels and said to check with the doctor first.`, es: `${P} preguntó por ${asked.candidate}. Marqué ${asked.hits.length} advertencia(s) de etiquetas de la FDA y le dije que consultara primero al médico.`, hi: `${P} ने ${asked.candidate} के बारे में पूछा। मैंने FDA लेबल की ${asked.hits.length} चेतावनी बताईं और पहले डॉक्टर से पूछने को कहा।` }[lang]);
  if (inter.hits.length) parts.push({ en: `On the current list, ${inter.hits.length} combination${inter.hits.length > 1 ? 's' : ''} to raise with the doctor: ${inter.hits.slice(0, 2).map((x: any) => `${x.a.name} with ${x.b.name}`).join('; ')}.`, es: `En la lista actual hay ${inter.hits.length} combinación(es) para comentar con el médico: ${inter.hits.slice(0, 2).map((x: any) => `${x.a.name} con ${x.b.name}`).join('; ')}.`, hi: `मौजूदा सूची में ${inter.hits.length} जोड़ी डॉक्टर से पूछने लायक हैं।` }[lang]);
  if (refills.due.length) parts.push({ en: `Refill soon: ${list(refills.due.map((r: any) => `${r.med}, about ${r.daysLeft} days left`), lang)}.`, es: `Pedir pronto: ${list(refills.due.map((r: any) => `${r.med}, quedan unos ${r.daysLeft} días`), lang)}.`, hi: `जल्द रीफ़िल: ${list(refills.due.map((r: any) => `${r.med} (${r.daysLeft} दिन)`), lang)}।` }[lang]);
  const next = slots.find((s) => s.status === 'upcoming');
  if (next) parts.push({ en: `Next up: ${next.med} at ${fmtTime(next.time, lang)}.`, es: `Lo siguiente: ${next.med} a las ${fmtTime(next.time, lang)}.`, hi: `अगली: ${fmtTime(next.time, lang)} पर ${next.med}।` }[lang]);
  // (the number of feed alerts is shown on the card, not spoken)
  const out = { kind: 'briefing', patient: P, caregiver: h.caregiver, now, since, adherence: { due: soFar.length, taken: taken.length, missed: missed.map((s) => ({ med: s.med, time: s.time })), late }, slots, interactions: { hits: inter.hits, labelMentions: inter.labelMentions.length }, lastQuestion: asked, refills: refills.due, feed: feed.slice(0, 10), channel: 'simulated', simulatedNote: SIM_NOTE, speech: [...parts, DISCLAIMER[lang]].join(' '), disclaimer: DISCLAIMER[lang], dataMode: inter.dataMode };
  for (const f of h.feed) f.seen = true;
  h.lastBriefingAt = new Date().toISOString(); save();
  return out;
}
