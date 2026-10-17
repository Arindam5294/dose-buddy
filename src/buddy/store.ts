// Per-household state that survives sessions and restarts: medicines, schedule, dose log, pill counts,
// caregiver and the (simulated) family alert feed. One JSON file (data/state.json), written atomically.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import type { Lang } from '../data/drugs.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const STATE_FILE = process.env.DB_STATE_FILE || join(ROOT, 'data', 'state.json');

export interface Med {
  id: string;
  name: string;                 // what the person calls it ("Plavix", "metformin")
  brand: string | null;
  ingredients: string[];        // canonical ingredient keys
  curated: boolean;             // every ingredient is in the curated table
  resolvedVia: 'curated_brand' | 'curated_generic' | 'openfda' | 'unresolved';
  brandSource: string | null;   // citation for the brand → generic mapping
  strength: string | null;
  unitsPerDose: number;
  times: string[];              // "HH:MM" local household time
  withFood: string | null;      // from curated MedlinePlus facts
  pillsLeft: number | null;
  refillThresholdDays: number;
  addedAt: string;
  addedLocal?: string;          // household-local "YYYY-MM-DDTHH:MM" (slots before this don't count)
  label: { setId: string; url: string; dataMode: string } | null;
}
export interface DoseEvent { id: string; medId: string; date: string; time: string; status: 'taken' | 'missed' | 'skipped'; at: string; late?: boolean }
export interface FeedItem {
  id: string; at: string; simNow: string | null;
  kind: 'missed_dose' | 'risky_combo' | 'refill' | 'message' | 'briefing';
  severity: 'info' | 'warning' | 'urgent';
  to: string; channel: 'simulated'; title: string; message: string; dedupe: string; seen: boolean;
}
export interface Household {
  id: string; createdAt: string; tz: string;
  patient: { name: string; lang: Lang };
  caregiver: { name: string; relation: string; city: string | null } | null;
  meds: Med[]; doses: DoseEvent[]; feed: FeedItem[];
  lastBriefingAt: string | null; lastInteractionCheck: any | null;
}

type DB = { version: 1; households: Record<string, Household> };
let db: DB | null = null;

function load(): DB {
  if (db) return db;
  try { db = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, 'utf8')) : null; } catch { db = null; }
  if (!db || !db.households) db = { version: 1, households: {} };
  return db!;
}
export function save() {
  const d = load();
  mkdirSync(dirname(STATE_FILE), { recursive: true });
  const tmp = STATE_FILE + '.tmp';
  writeFileSync(tmp, JSON.stringify(d, null, 1));
  renameSync(tmp, STATE_FILE);
}
export function getHousehold(id: string): Household {
  const d = load();
  const hid = String(id || 'default').slice(0, 64);
  if (!d.households[hid]) {
    d.households[hid] = { id: hid, createdAt: new Date().toISOString(), tz: process.env.DB_TZ || 'America/New_York', patient: { name: 'Dad', lang: 'en' }, caregiver: null, meds: [], doses: [], feed: [], lastBriefingAt: null, lastInteractionCheck: null };
  }
  return d.households[hid];
}
export function resetHousehold(id: string) { const d = load(); delete d.households[id]; save(); }
export const newId = () => randomUUID().slice(0, 8);
export const stateFilePath = () => STATE_FILE;
