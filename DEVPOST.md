# Devpost submission: Dose Buddy (ready to paste)

> Hackathon: Amazon *Build, Ship, Shape* (amazonappdev2026.devpost.com) · Track: **Alexa+**
> Deadline: Oct 23 2026, 12:00 PM PDT (Oct 24, 00:30 IST)
> Builder: **Swanix**
> Video: https://youtu.be/0Bkkw-arcYw (2:57, unlisted)
> Code: MIT, repository link to add after the GitHub push.

---

## Project name
Dose Buddy

## Tagline (≤ 200 chars)
A voice-first medicine guardian for Alexa+: what to take now, dangerous combos caught before they happen with FDA sources, plain-language answers in English, Spanish or Hindi, and alerts for family far away.

## Inspiration
Millions of older adults live on their own and take several medicines a day, while their adult children live in another city or another country. The things that go wrong are small and ordinary: the evening pill that gets forgotten, an over-the-counter painkiller that doesn't mix with a blood thinner, a brand on the box that nobody connects to the generic on the prescription. The person who could catch it is often a phone call away and doesn't know there's anything to catch.

A smart speaker is already in the kitchen, it is patient, it speaks several languages, and nobody has to learn an app. I wanted to see how far a careful, sourced, never-guessing voice helper could go, built on MCP so any assistant could use it.

## What it does
Dose Buddy is an MCP server with 10 tools and an MCP Apps card, shown here in an Alexa+ (Echo Show-style) simulator next to a simulated caregiver phone.

- **"Alexa, what do I take now?"** Doses due now, anything overdue, what's next, and the food rule that matters ("Glucophage: the regular tablet is usually taken with meals").
- **"I took my pills."** Logs the doses, counts pills down, warns when a refill is close.
- **"Can I take Advil for my knee?"** Advil → ibuprofen through a curated, cited global brand map (Tylenol/Panadol, Advil/Nurofen, Coumadin, Plavix, Lipitor, Zestril, Zoloft/Lustral, Prilosec/Losec…). Then a curated table of 17 high-risk pairs, each citing an exact FDA label quote that Dose Buddy re-checks against the live openFDA label on every request. For Dad's list it finds two warnings (with Plavix: bleeding; with Zestril: kidney risk), shows both sources, says "please don't take Advil until you've checked with your doctor or pharmacist" and "please don't stop any of your medicines on your own", and posts a warning to the family feed.
- **"¿Para qué es la metformina?"** Plain-language answers in English or Spanish from curated MedlinePlus summaries (the Spanish comes from MedlinePlus's own Spanish pages), and in Hindi as a marked translation, plus the live FDA label's indications and boxed warning.
- **Missed doses.** A dose more than 90 minutes late is recorded as missed; Dose Buddy tells the person to ask their pharmacist about it (it never gives dosing advice) and alerts the caregiver.
- **Caregiver briefing.** "How is Dad doing?" gives doses taken vs due, what was missed, what Dad asked about and what was flagged, combinations to raise with the doctor, and refills.
- **Refills** from pill counts, **family messages** ("tell Maya I feel dizzy"), and a **demo clock** so judges can test an evening missed dose at any time of day.

Family alerts are a **simulated feed**: no SMS, call or push is sent, and the app says so on every alert.

## How we built it
- **MCP server** in TypeScript on the official `@modelcontextprotocol/sdk` (1.32.1): `McpServer` with stateful Streamable HTTP sessions, negotiating protocol **2025-11-25**. Ten tools with Zod input and output schemas returning `structuredContent`.
- **MCP Apps** via `@modelcontextprotocol/ext-apps` 1.7.5 (`registerAppTool`, `registerAppResource`): one HTML card renders schedules, warnings with their sources, explanations, alerts and the briefing.
- **Alexa+ simulator**: Web Speech mic, typed input, speech synthesis, an MCP Apps host shim, an agent trace showing every tool call, and a caregiver phone panel. Utterances in English, Spanish and Hindi go through a deterministic intent parser into a plan of real MCP tool calls made with the SDK Client. No paid LLM.
- **Data**: openFDA drug label API (no key) for live label text and for brands nobody curated (Eliquis → apixaban); MedlinePlus (NLM) English and Spanish pages for plain-language summaries and US brand names; UK emc, EMA and Spain's AEMPS for non-US brands; DailyMed links for every label.
- **Reliability**: live → memory → disk cache → a real snapshot of 36 openFDA responses. Every card shows which one it used. `DB_OFFLINE=1` runs the whole thing with no network.
- **Tests**: an MCP client test walks a full simulated day across all 10 tools (43 checks), live and offline; a source verifier re-fetches all 17 cited labels and checks each quote is really in the text.

## Challenges we ran into
- **Being useful without inventing anything.** Every fact had to trace to a source. I paraphrased MedlinePlus line by line, kept the citation on every entry, and made the interaction table cite exact FDA label quotes, then wrote a verifier so a wrong quote fails the build.
- **Safety wording.** It's easy for a helpful assistant to say "stop taking it". Dose Buddy never does: serious combos mean "call your doctor today", a new medicine means "check first", a missed dose means "ask your pharmacist". The tests assert those phrases and assert that "stop taking" never appears.
- **Going global.** Brand names differ by country (Advil vs Nurofen, Prilosec vs Losec, Zoloft vs Lustral). I mapped brands from US, UK, EU and Spanish regulator sources onto one ingredient list, while being honest that the label text underneath is U.S.
- **Time.** A missed-dose feature needs a clock you can control. Every tool takes an optional household-local `now`, which made the tests deterministic and the demo honest.

## Accomplishments that we're proud of
- 17 cited interaction quotes, all verified against live FDA label text, and the check runs again on every request.
- The whole demo day passes 43/43 tests live and 43/43 with no network.
- The answers are short enough to say out loud, and every one ends with "Not medical advice. Ask your doctor or pharmacist."

## What we learned
- MCP plus MCP Apps is a good fit for voice: one tool call gives a sentence to speak and a card to show.
- openFDA is excellent free data, but it is label text, not a clinical interaction database. A small curated table with exact quotes is more trustworthy than a big guess.
- Writing for older listeners means fewer words, the brand name first, and one clear next step.

## What's next
- Real notifications (SMS or the Alexa notifications API) once the caregiver opts in.
- Pharmacy refill hand-off and pill-count photos.
- A pharmacist-reviewed, larger interaction table and more languages (Portuguese, French, Mandarin, Tagalog).
- A certified Alexa+ integration instead of the simulator.

## Built with
typescript · node.js · model-context-protocol · mcp-apps · express · zod · openfda · medlineplus · dailymed · web-speech-api · playwright · ffmpeg · edge-tts

---

## Product Feedback answers

**Which tools did you use, and for what?**
- `@modelcontextprotocol/sdk` 1.32.1: `McpServer`, `StreamableHTTPServerTransport` (server), `Client` + `StreamableHTTPClientTransport` (simulator agent, seed script and test suite), `isInitializeRequest`, `LATEST_PROTOCOL_VERSION`.
- `@modelcontextprotocol/ext-apps` 1.7.5: `registerAppTool` and `registerAppResource` for the card.
- Zod 4 for schemas, Express 5, TypeScript/tsx. Playwright for screen capture, ffmpeg for editing, edge-tts for the voices.
- Amazon/AWS services: none. Alexa+ is represented by a web simulator; I had no Alexa+ MCP access or AWS account.

**What worked well?**
- Streamable HTTP with session ids and protocol negotiation to 2025-11-25 worked out of the box.
- `outputSchema` + `structuredContent` made it easy to assert behaviour in tests, not just text.
- `registerAppTool` / `registerAppResource` kept the MCP Apps wiring to a few lines.

**What needs work?**
- There is still no small reference MCP Apps host; I reused my hand-written `ui/initialize` / `tool-result` shim.
- ext-apps 2.x vs SDK 1.x compatibility isn't stated in the README, so I pinned 1.7.5 again.
- Strict Zod output schemas reject extra fields; `z.looseObject` works but isn't documented as the pattern for evolving tool results.
- For voice hosts, a convention for "text to speak" vs "text to show" in tool results would help; I used the content text for speech and `structuredContent` for the card.

**How was onboarding?**
Quick this time: I reused my server skeleton from an earlier MCP project. The slow part was data, not MCP.

**Would you build with these tools again?**
Yes. One MCP server served the simulator, the test client and any MCP host, with no extra glue.

---

## Friction log (real problems hit while building)

1. **openFDA answers "no match" with HTTP 404.** A brand that isn't in openFDA (or a typo) returns 404 plus an error body, not an empty result. My fallback chain would have treated that as an outage and served stale or no data. Fix: treat 404 as a real, cacheable "no results" answer, so the uncurated-brand lookup also works offline.
2. **openFDA label responses are huge.** Full label JSON runs to 100 KB+ per label. Fix: trim to the sections Dose Buddy reads before caching; the snapshot of 36 responses is still about 1 MB.
3. **"What do I take now?" was parsed as "add a medicine".** The phrase contains "I take", which my add-medicine pattern matched first; the first smoke test answered "What time do you take now?". Fix: match "what do/should I take" before the add intent.
4. **False missed-dose alarm in testing.** The first full test run failed 3 of 43 checks: a medicine added at 11:40 with a 7 AM time was reported as missed that evening and pushed to the caregiver. Fix: dose slots before the moment a medicine was added don't count that day.
5. **The briefing forgot what Dad asked.** The briefing runs its own interaction check, which overwrote the stored "last question", so "Dad asked about Advil" disappeared. Fix: keep the last candidate question separately from list checks.
6. **Scope change mid-build.** I first planned a single-country brand map; for a global hackathon I switched to US/UK/EU/Spanish brands with regulator sources. Because brands map onto shared ingredient keys, the switch touched only the curated table and the demo script.

(Environment-only notes: the sandbox's headless Chromium needed extra system libraries and a Devanagari font; edge-tts needed proxy variables unset.)
