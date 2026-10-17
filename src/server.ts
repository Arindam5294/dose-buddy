// HTTP entry point. One process serves:
//   POST/GET/DELETE /mcp   – MCP Streamable HTTP endpoint (stateful sessions, official SDK transport)
//   GET  /                 – Alexa+ simulator (Echo Show-style web UI) + simulated caregiver phone
//   POST /api/agent        – simulator utterance -> plan -> MCP tool calls (via SDK Client)
//   GET  /api/feed         – caregiver phone panel: family_alert(action=feed) through MCP
//   GET  /api/card         – the MCP Apps UI resource, read through MCP resources/read
//   POST /api/reset        – demo helper: wipe one household
//   GET  /health           – status, negotiated protocol version, data mode

import express from 'express';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest, LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import { buildMcpServer, CARD_URI } from './mcp.js';
import { handleUtterance, getClient, mcpInfo } from './agent/agent.js';
import { snapshotInfo } from './data/http.js';
import { resetHousehold } from './buddy/store.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8788);
const HOST = process.env.HOST || '0.0.0.0';
const BASE = `http://127.0.0.1:${PORT}`;

const app = express();
app.use(express.json({ limit: '1mb' }));

const transports: Record<string, StreamableHTTPServerTransport> = {};

app.post('/mcp', async (req, res) => {
  try {
    const sid = req.headers['mcp-session-id'] as string | undefined;
    let transport = sid ? transports[sid] : undefined;
    if (!transport) {
      if (sid || !isInitializeRequest(req.body)) {
        res.status(400).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Bad Request: no valid session. Send initialize first.' }, id: null });
        return;
      }
      transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID(), onsessioninitialized: (id) => { transports[id] = transport!; } });
      transport.onclose = () => { if (transport!.sessionId) delete transports[transport!.sessionId]; };
      await buildMcpServer().connect(transport);
    }
    await transport.handleRequest(req, res, req.body);
  } catch (e: any) {
    if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: e.message }, id: null });
  }
});
const sessionReq = async (req: express.Request, res: express.Response) => {
  const sid = req.headers['mcp-session-id'] as string | undefined;
  if (!sid || !transports[sid]) { res.status(400).send('Invalid or missing session ID'); return; }
  await transports[sid].handleRequest(req, res);
};
app.get('/mcp', sessionReq);
app.delete('/mcp', sessionReq);

app.post('/api/agent', async (req, res) => {
  const { text, household_id, session_id, now, lang } = req.body || {};
  if (!text || typeof text !== 'string') { res.status(400).json({ error: 'text required' }); return; }
  try {
    const out = await handleUtterance(BASE, String(household_id || 'demo-family'), String(session_id || 'default'), text.slice(0, 500), { now: now || undefined, lang: lang || undefined });
    res.json({ ...out, protocolVersion: mcpInfo.protocolVersion });
  } catch (e: any) {
    res.status(500).json({ error: e.message, speech: 'Sorry, something went wrong on my side.' });
  }
});

app.get('/api/feed', async (req, res) => {
  try {
    const c = await getClient(BASE);
    const r: any = await c.callTool({ name: 'family_alert', arguments: { action: 'feed', household_id: String(req.query.household_id || 'demo-family') } });
    res.json(r.structuredContent);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

app.get('/api/card', async (_req, res) => {
  try { const c = await getClient(BASE); const r: any = await c.readResource({ uri: CARD_URI }); res.type('html').send(r.contents[0].text); } catch (e: any) { res.status(500).send(e.message); }
});

app.post('/api/reset', (req, res) => { resetHousehold(String(req.body?.household_id || 'demo-family')); res.json({ ok: true }); });

app.get('/health', async (_req, res) => {
  let pv = mcpInfo.protocolVersion;
  try { await getClient(BASE); pv = mcpInfo.protocolVersion; } catch { /* ignore */ }
  res.json({ ok: true, name: 'dose-buddy', mcpEndpoint: '/mcp', sdkLatestProtocolVersion: LATEST_PROTOCOL_VERSION, negotiatedProtocolVersion: pv, activeSessions: Object.keys(transports).length, offlineMode: process.env.DB_OFFLINE === '1', snapshot: snapshotInfo(), alerts: 'simulated feed (no SMS/push)' });
});

app.use(express.static(join(HERE, '..', 'public')));
app.listen(PORT, HOST, () => console.log(`Dose Buddy on http://${HOST}:${PORT}  (MCP: /mcp, simulator: /)`));
