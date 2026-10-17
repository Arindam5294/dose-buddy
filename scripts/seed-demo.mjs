// Seeds the demo household through real MCP tool calls (official SDK client over Streamable HTTP).
// Usage: node scripts/seed-demo.mjs [household_id] [YYYY-MM-DDTHH:MM]
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
const URL_ = process.env.MCP_URL || 'http://127.0.0.1:8788/mcp';
const HH = process.argv[2] || 'demo-family';
const NOW = process.argv[3] || '2026-10-18T07:30';
await fetch(new URL('/api/reset', URL_), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ household_id: HH }) });
const c = new Client({ name: 'dose-buddy-seed', version: '1.0.0' });
await c.connect(new StreamableHTTPClientTransport(new URL(URL_)));
const call = async (name, args) => { const r = await c.callTool({ name, arguments: { household_id: HH, now: NOW, ...args } }); console.log(`${name}: ${r.content[0].text.slice(0, 160)}`); return r.structuredContent; };
await call('family_alert', { action: 'set_caregiver', caregiver_name: 'Maya', relation: 'daughter', city: 'Chicago', patient_name: 'Dad', patient_lang: 'en' });
await call('add_medicine', { name: 'Glucophage', strength: '500 mg', times: ['08:00', '20:00'], pills_left: 40 });
await call('add_medicine', { name: 'Zestril', strength: '10 mg', times: ['09:00'], pills_left: 26 });
await call('add_medicine', { name: 'Plavix', strength: '75 mg', times: ['09:00'], pills_left: 4 });
await call('add_medicine', { name: 'Lipitor', strength: '20 mg', times: ['21:00'], pills_left: 30 });
await c.close();
console.log('seeded', HH);
