# Dose Buddy

**A voice-first medicine guardian for Alexa+.** It helps an older parent living at home take the right pill
at the right time, catches dangerous combinations *before* they happen, explains medicines in plain English,
Spanish or Hindi, and keeps an adult child in another city in the loop.

> "Alexa, what do I take now?" · "I took my pills." · "Can I take Advil with my medicines?" ·
> "¿Para qué es la metformina?" · "Did I miss anything?" · "Give me Dad's daily briefing."

Built by **Swanix** for Amazon's *Build, Ship, Shape* hackathon (Alexa+ track). MIT licensed.

> ⚕ **Not medical advice.** Dose Buddy is a hackathon prototype. Every warning shows its source and tells the
> person to ask their doctor or pharmacist. It never tells anyone to stop a medicine.

---

## Why

Older adults often take several daily medicines, and the people who help them often live somewhere else.
The failures are ordinary: a dose forgotten in the evening, a painkiller grabbed from the cupboard that doesn't
mix with a blood thinner, a brand name on the box that nobody connects to the generic on the prescription.
A voice assistant is already in the kitchen. Dose Buddy turns it into a patient, sourced, multilingual helper
that also tells the family when something slips.

## What it does

| Tool (MCP) | What the person says | What happens |
|---|---|---|
| `add_medicine` | "I now take Prilosec 20 mg at 7 AM" | Maps brand → generic (curated, cited global table, then openFDA), saves times, tablets per dose and pill count, then checks the new medicine against the list. |
| `list_schedule` | "What's my schedule?" | Today's slots: taken / take now / later / missed, pill counts, days left. |
| `what_next` | "What do I take now?" | Doses due now (60 min before to 90 min after), overdue ones, the next one, and food rules from MedlinePlus ("with meals", "on an empty stomach"). |
| `mark_taken` | "I took my pills" | Logs the due doses (or one named medicine, or "skipped"), decrements pill counts, warns about refills. |
| `check_missed_doses` | runs on a schedule, or "Did I miss anything?" | Records doses >90 min late as missed, tells the person to ask the pharmacist about the late dose, and posts a **simulated** family alert. De-duplicated. |
| `check_interactions` | "Can I take Advil with my medicines?" | Curated table of 17 high-risk pairs, each citing an exact FDA-label quote that is **re-verified against the live openFDA label** on every check, plus an openFDA label text scan. Severe/high results for something not yet taken alert the caregiver. |
| `explain_medicine` | "What is Plavix for? In Hindi" | What it's for, common side effects, take with food? From curated MedlinePlus summaries (English + the official MedlinePlus Spanish page; Hindi is a marked translation) plus the live FDA label (indications, boxed warning). |
| `family_alert` | "Tell Maya I feel dizzy" | Caregiver set-up, messages and the alert feed. **Simulated: no SMS, call, e-mail or push is sent**, and the app says so everywhere. |
| `daily_briefing` | (caregiver) "How is Dad doing?" | Doses taken vs due, missed and late doses, what was asked and flagged, combinations to raise with the doctor, refills, alerts since last time. |
| `refill_reminder` | "How many pills are left?" | Days of supply from pill counts; at or under the threshold posts a refill alert. |

Everything is stored per household in one JSON file and survives sessions and restarts.

### Safety rules built into the code

- No medical fact is generated. Facts come from three places only: curated MedlinePlus summaries (each entry
  links its English and Spanish MedlinePlus page), the curated FDA-label-cited interaction table, or live
  openFDA label text.
- Every spoken answer ends with "Not medical advice. Ask your doctor or pharmacist." in the reply language.
- Severe or important combinations on the current list say **"Please call your doctor today"**. For something not
  yet taken: "Please don't take X until you've checked with your doctor or pharmacist." Every warning adds
  "Please don't stop any of your medicines on your own." The test suite asserts the words "stop taking" and
  "discontinue" never appear in interaction speech.
- Missed doses never get dosing advice ("take two" etc.): only "ask your pharmacist what to do about a missed dose."
- If a medicine isn't in the curated tables, Dose Buddy says so and falls back to the FDA label text in English.

## Data sources (real, free, no keys)

| Source | Used for |
|---|---|
| [openFDA drug label API](https://open.fda.gov/apis/drug/label/) | Live label text: indications, boxed warnings, drug interactions; resolving brands nobody curated (e.g. Eliquis → apixaban); verifying every cited quote. |
| [MedlinePlus drug information](https://medlineplus.gov/druginformation.html) (U.S. National Library of Medicine), English and Spanish | Plain-language purpose, side effects and food guidance (curated, paraphrased, linked per medicine), and US brand names. |
| UK [emc](https://www.medicines.org.uk/emc), [EMA](https://www.ema.europa.eu/), Spain's [AEMPS CIMA](https://cima.aemps.es/) | Non-US brand names (Nurofen, Panadol/Calpol, Losec, Tritace, Lustral, Cipralex, Voltarol, Adiro, Gelocatil). |
| [DailyMed](https://dailymed.nlm.nih.gov/) | Human-readable link for every FDA label cited. |

**Curated tables, clearly labelled as curated:**
- `src/data/brands.ts`: 47 brand names across the US, UK, EU, Spain and other markets → 30 ingredients
  (Tylenol/Panadol → acetaminophen/paracetamol, Advil/Nurofen → ibuprofen, Coumadin → warfarin,
  Glucophage → metformin, Plavix → clopidogrel, Zoloft/Lustral → sertraline, Lipitor → atorvastatin,
  Zestril/Prinivil → lisinopril, Prilosec/Losec → omeprazole …). Each row has a source URL.
- `src/data/interactions.ts`: 17 high-risk pairs (warfarin + aspirin/NSAIDs/SSRIs, sildenafil + nitrates,
  tramadol + SSRIs, clopidogrel + omeprazole/esomeprazole or NSAIDs, ACE inhibitors/ARBs + potassium or NSAIDs,
  ibuprofen + aspirin, SSRIs + NSAIDs/aspirin, metformin + iodinated contrast, atorvastatin + clarithromycin,
  amlodipine + simvastatin, levothyroxine + calcium/iron). Each has a DailyMed set id, section and exact quote.
- `src/data/drugs.ts`: 35 recognised ingredients (32 with a representative FDA label); plain-language summaries for 25 in English and Spanish, 14 also in Hindi.

**Offline:** `snapshots/fallback.json` holds 36 real openFDA responses captured by `npm run snapshot`.
The data layer goes live → memory → disk cache → snapshot, and every card shows which one it used
(`LIVE openFDA` / `CACHED` / `FALLBACK SNAPSHOT`). `DB_OFFLINE=1` forces cache/snapshot only.

## Architecture

```
Alexa+ simulator (public/index.html)          any MCP host (Alexa+, Claude, …)
  mic (Web Speech) / text / demo clock                     │
  speechSynthesis · caregiver phone panel                  │
        │ POST /api/agent                                   │
        ▼                                                   │
  agent (src/agent) ── deterministic EN/ES/HI intent parser │
        │  plan = [tool calls]                              │
        ▼  MCP SDK Client, Streamable HTTP                  ▼
  ┌──────────────────────── /mcp  (McpServer, stateful sessions, protocol 2025-11-25) ─────────────────────┐
  │ 10 tools (zod in/out schemas, structuredContent)   ui://dose-buddy/card.html (MCP Apps resource)      │
  └──────────────┬───────────────────────────────────────────────────────────────────────────────────────┘
                 ▼
  src/buddy/service.ts  schedule · dose log · missed logic · interactions · explanations · refills · feed · briefing
                 ▼
  src/data  openFDA client (live → cache → snapshot)  ·  curated brands / interactions / MedlinePlus summaries
  data/state.json  households (atomic writes)
```

- **TypeScript / Node**, `@modelcontextprotocol/sdk` 1.32.1, `@modelcontextprotocol/ext-apps` **1.7.5** (pinned:
  2.x expects the split server packages), Express 5, Zod 4.
- **MCP Apps card**: one HTML resource renders every result kind (schedule, warnings with sources, explanations,
  missed-dose alerts, briefing). The simulator implements the host side (`ui/initialize` →
  `ui/notifications/tool-result`).
- **Demo clock**: every tool accepts an optional `now` ("YYYY-MM-DDTHH:MM", household time) so a judge can
  test a missed evening dose at 10 AM. Omit it for the real time.

## Run it

```bash
npm install
npm run build
npm start                      # http://localhost:8788  (MCP endpoint: /mcp)
node scripts/seed-demo.mjs     # optional: demo household "Dad" + caregiver "Maya" with 4 medicines
```

Open `http://localhost:8788/?household=demo-family&now=2026-10-18T09:05` and ask "What do I take now?".

Connect any MCP client to `http://localhost:8788/mcp` (Streamable HTTP). `GET /health` shows the negotiated
protocol version and data mode.

## Tests

```bash
npm start &                    # live data
npm test                       # 43 checks over every tool and a full simulated day
npm run test:sources           # re-fetches all 17 cited FDA labels and verifies each quote is in the text

DB_OFFLINE=1 DB_CACHE_DIR=/tmp/empty npm start &   # no network, snapshot only
npm test                       # same 43 checks
```

Latest results (2026-10-17): **43/43 live, 43/43 offline (snapshot), 17/17 cited quotes verified, 32/32
labels resolve.** Saved in `tests/results/`.

## Demo video

`demo/dose_buddy_demo.mp4` (2:57, 1920x1080): one day in the life of Dad at home and Maya in Chicago, all real
Playwright captures of the simulator with live MCP tool output: "what do I take now?", an Advil question caught
with its FDA sources, a Spanish and a Hindi explanation, a missed evening dose that alerts Maya (simulated), and
Maya's briefing from her own Echo. Voices are edge-tts (narration: Andrew; Alexa: Ava for English and Spanish,
Swara for Hindi); every sound effect and the music bed are synthesized in `demo/scripts/audio.py`.
Rebuild with `demo/scripts/build_video.sh` (server running).

## Honest limitations

- **It's a simulator, not a certified Alexa skill.** The Echo Show-style page and the deterministic intent parser
  stand in for Alexa+. The MCP server itself is standard and works with any MCP host.
- **Family alerts are simulated.** Nothing is sent by SMS, call, e-mail or push. The feed, the caregiver phone
  panel and every alert say so.
- **The curated tables are small on purpose.** 47 brands, 35 ingredients (25 with plain-language summaries), 17 interaction pairs. "No warning found"
  means "not in my list", and Dose Buddy says that list is not a guarantee. It is not a replacement for a
  pharmacist's full interaction check.
- **openFDA labels are U.S. labels.** Non-US brands are mapped to their ingredient and then checked against U.S.
  label text. openFDA itself warns: "Do not rely on openFDA to make decisions regarding medical care."
- **Hindi summaries are the builder's translation** of the English MedlinePlus text, marked as such. Spanish comes
  from the official MedlinePlus Spanish pages. Live FDA label excerpts are English only.
- **Doses only.** No dose calculations, no "take it now or skip it" advice, no clinical judgement.
- **One time zone per household**, no multi-user auth, JSON storage. Fine for a demo, not for production.

## Project layout

```
src/server.ts          Express: /mcp, /api/agent, /api/feed, /api/card, /health, static simulator
src/mcp.ts             McpServer: 10 tools + MCP Apps resource
src/agent/             SDK Client + deterministic EN/ES/HI intent parser
src/buddy/             service (all logic), store (atomic JSON), i18n
src/data/              http (fallback chain), openfda, brands, interactions, drugs (curated)
src/ui/card.html       MCP Apps card
public/index.html      Alexa+ simulator + caregiver phone
tests/                 MCP client test + saved results
scripts/               capture-snapshot, verify-sources, seed-demo, restart
skills/dose-buddy/     SKILL.md for agents using these tools
snapshots/             real openFDA fallback responses
demo/                  video build scripts
```

Brand names are trademarks of their owners and are used only to identify what a medicine contains.
