---
name: dose-buddy
description: Use when an older adult or their family caregiver asks what medicine to take now, says they took (or skipped) a dose, adds a new medicine, asks "can I take X with my medicines?", asks what a medicine is for or its side effects (English, Spanish or Hindi), asks about missed doses or refills, or wants a daily caregiver briefing. Works through the Dose Buddy MCP server (Streamable HTTP, /mcp).
license: MIT
metadata:
  author: Swanix
  version: 1.0.0
  mcp_endpoint: /mcp
---

# Dose Buddy: how an agent should use these tools

Dose Buddy is a voice-first medicine guardian. It never diagnoses, never doses and never gives medical advice.
It turns a household's medicine list, openFDA label text, curated MedlinePlus summaries and a small cited
interaction table into short spoken answers plus an MCP Apps card (`ui://dose-buddy/card.html`).

## Golden rules

1. **Always pass the same `household_id`.** Medicines, the dose log, pill counts, the caregiver and the alert feed
   are keyed by it and survive sessions and restarts.
2. **Check before anyone takes something new.** If the person mentions taking, buying or being given a medicine
   that is not on their list ("my neighbour gave me…", "can I have an Advil?"), call `check_interactions` with
   `candidate` first.
3. **Speak the `content` text, show the `structuredContent` card.** The text already ends with the disclaimer in the
   reply language. Do not shorten away the disclaimer or the "don't stop your medicines" line.
4. **Never tell anyone to stop, skip, double or change a dose.** Severe/important combinations on the current list →
   "call your doctor today". A candidate with a warning → "don't take it until you've checked with your doctor or
   pharmacist". Missed dose → "ask your pharmacist what to do about a missed dose".
5. **"No warning found" is not "safe".** Say it was not in Dose Buddy's curated list and that the list is not a
   guarantee (the text already does).
6. **Family alerts are simulated in this build.** Never tell the person their daughter "got a text". Say the
   family feed was updated.
7. **Respect `dataMode`.** `live` = fetched from openFDA now; `cache` = last live fetch; `snapshot` = saved fallback,
   may be out of date.

## Tools

| Tool | Call it when |
|---|---|
| `what_next` | "What do I take now?", "Is it time for my pills?" |
| `mark_taken` | "I took my pills" (no `medicine` = every dose due now), "I took my Plavix", `status: "skipped"` |
| `add_medicine` | A new prescription. Needs `name` and `times`; ask for missing times. Brands (Tylenol, Panadol, Nurofen, Plavix, Lipitor…) are mapped to generics. It also checks the new medicine against the list. |
| `list_schedule` | "What are my medicines?", "What's my schedule today?" |
| `check_interactions` | Before any new medicine (`candidate`), or "check my list". |
| `explain_medicine` | "What is X for?", side effects, "with food?". Pass `lang` (`en`, `es`, `hi`) when the person asks in or for that language. |
| `check_missed_doses` | On a schedule (e.g. hourly) and when asked "did I miss anything?". It alerts the caregiver feed, de-duplicated. |
| `refill_reminder` | "How many pills are left?", or a daily schedule. `set` updates a pill count. |
| `family_alert` | `set_caregiver` once; `send` for "tell my daughter…"; `feed` to read alerts. |
| `daily_briefing` | The caregiver asks how the day went. Marks the feed as seen. |

## Multi-step flows

- **Morning routine:** `what_next` → (person takes them) → `mark_taken` → if the reply mentions running low, offer
  `refill_reminder`.
- **New prescription:** `add_medicine` → read out any warning from `interactions` → if severe/high, the caregiver
  feed was already updated; tell the person to call their doctor and not to stop anything.
- **"Can I take X?":** `check_interactions(candidate: X)`; if the person then asks what X is, `explain_medicine(X)`.
- **Evening safety net:** schedule `check_missed_doses` and `refill_reminder`; send `daily_briefing` to the caregiver.

## Language

Reply in the language the person used. Spanish summaries come from the official MedlinePlus Spanish pages.
Hindi summaries are a marked translation of the English MedlinePlus text. FDA label excerpts are English only;
say so when reading one in another language.

## Limits to state honestly

- Curated tables: 47 brands, 35 ingredients (25 with plain-language summaries), 17 interaction pairs. Not a complete
  interaction database.
- U.S. FDA labels are used for every market; non-US brands are mapped to their ingredient first.
- Alerts are simulated (no SMS/push). The Alexa+ experience in this repo is a web simulator.
- Not medical advice. Ask your doctor or pharmacist.
