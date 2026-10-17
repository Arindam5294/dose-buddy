// The simulator's "Alexa+" brain. Parses an utterance into a plan, then runs every step as a real MCP tool call
// through the official SDK Client over Streamable HTTP against our own /mcp endpoint.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { parse, type Session, type Lang } from './intent.js';

let client: Client | null = null;
export const mcpInfo: { protocolVersion?: string; server?: any } = {};

export async function getClient(baseUrl: string) {
  if (client) return client;
  const c = new Client({ name: 'alexa-plus-simulator', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL('/mcp', baseUrl));
  await c.connect(transport);
  mcpInfo.protocolVersion = transport.protocolVersion;
  mcpInfo.server = c.getServerVersion();
  client = c;
  return c;
}

const sessions = new Map<string, Session>();
const HELP: Record<Lang, string> = {
  en: 'Try: "What do I take now?", "I took my Plavix", "Can I take Advil with my medicines?", "What is metformin for? In Spanish", or "Give me Dad\'s daily briefing".',
  es: 'Diga: "¿Qué me toca ahora?", "Ya tomé mi Plavix", "¿Puedo tomar Advil con mis medicamentos?" o "¿Para qué es la metformina?".',
  hi: 'बोलिए: "अभी कौन सी दवा लेनी है?", "मैंने Plavix ले ली", "क्या मैं Advil ले सकता हूँ?" या "metformin kis liye hai, Hindi mein".',
};
const CARD_PRIORITY = ['check_interactions', 'explain_medicine', 'daily_briefing', 'check_missed_doses', 'what_next', 'add_medicine', 'refill_reminder', 'list_schedule', 'mark_taken', 'family_alert'];

export async function handleUtterance(baseUrl: string, hid: string, sessionId: string, text: string, ctx: { now?: string; lang?: Lang } = {}) {
  const s = sessions.get(sessionId) || {}; sessions.set(sessionId, s);
  const plan = parse(text, s, hid, ctx);
  if (plan.ask) return { intent: plan.intent, lang: plan.lang, router: 'deterministic', speech: plan.ask, calls: [], card: null };
  if (!plan.steps.length) return { intent: 'help', lang: plan.lang, router: 'deterministic', speech: HELP[plan.lang], calls: [], card: null };
  const c = await getClient(baseUrl);
  const calls: any[] = []; const speech: string[] = [];
  let card: any = null; let cardRank = 99;
  for (const step of plan.steps) {
    const t0 = Date.now();
    const res: any = await c.callTool({ name: step.tool, arguments: step.args });
    const text0 = (res.content || []).map((x: any) => x.text).join(' ');
    calls.push({ tool: step.tool, args: step.args, why: step.why, ms: Date.now() - t0, isError: !!res.isError, text: text0, structuredContent: res.structuredContent ?? null });
    if (res.isError) { speech.push(text0.replace(/^Error:\s*/, '')); break; }
    // later steps in one plan repeat the disclaimer; keep it once at the end
    speech.push(text0.replace(/\s*(Not medical advice\. Ask your doctor or pharmacist\.|No es consejo médico\. Consulte a su médico o farmacéutico\.|यह चिकित्सकीय सलाह नहीं है। अपने डॉक्टर या फ़ार्मासिस्ट से पूछें।)\s*$/, ''));
    const rank = CARD_PRIORITY.indexOf(step.tool);
    if (rank < cardRank) { card = res.structuredContent; cardRank = rank; }
  }
  const disc = (calls.find((x) => x.structuredContent?.disclaimer)?.structuredContent?.disclaimer) || '';
  return { intent: plan.intent, lang: plan.lang, router: 'deterministic', speech: [...speech, disc].filter(Boolean).join(' '), calls, card };
}
