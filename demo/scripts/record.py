# Records real headless-Chromium captures of the Alexa+ simulator (1920x1080) answering six requests with
# live MCP tool output. The demo household is re-seeded first (through MCP), then each scene runs in a fresh
# page with the demo clock set, so the day unfolds in order: morning dose, an Advil question, a Spanish and a
# Hindi explanation, an evening missed-dose check and the caregiver's briefing from another city.
import asyncio, json, pathlib, shutil, subprocess, time, urllib.request
from playwright.async_api import async_playwright

B = pathlib.Path(__file__).resolve().parent.parent / 'build'
B.mkdir(exist_ok=True)
ROOT = B.parent.parent
BASE = 'http://localhost:8788'
HH = 'demo-family'
SCENES = [
    ('s1', '2026-10-18T09:05', None, 'Alexa, what do I take now?'),
    ('s2', '2026-10-18T11:20', None, 'Alexa, can I take Advil for my knee?'),
    ('s3', '2026-10-18T12:00', None, 'Alexa, ¿para qué es la metformina?'),
    ('s4', '2026-10-18T12:02', None, 'Alexa, Plavix kis liye hai? Hindi mein batao.'),
    ('s5', '2026-10-18T22:45', None, 'Alexa, did I miss anything today?'),
    ('s6', '2026-10-18T22:55', "Maya's Echo Show · Chicago", 'Alexa, how is Dad doing today?'),
]
OFFCAM = {'s1': ('I took my pills', '2026-10-18T09:07')}   # Dad confirms the morning doses after scene 1


def agent(text, now):
    req = urllib.request.Request(BASE + '/api/agent', data=json.dumps({'text': text, 'household_id': HH, 'session_id': 'offcam', 'now': now}).encode(), headers={'content-type': 'application/json'})
    return json.load(urllib.request.build_opener(urllib.request.ProxyHandler({})).open(req, timeout=60))


async def main():
    subprocess.run(['node', str(ROOT / 'scripts' / 'seed-demo.mjs'), HH, '2026-10-18T07:30'], check=True)
    out = {}
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context(viewport={'width': 1920, 'height': 1080}, device_scale_factor=1, record_video_dir=str(B / 'vid'), record_video_size={'width': 1920, 'height': 1080})
        for name, now, device, q in SCENES:
            t0 = time.monotonic()
            pg = await ctx.new_page()
            url = f'{BASE}/?household={HH}&now={now}' + (f'&device={urllib.request.quote(device)}' if device else '')
            await pg.goto(url); await pg.wait_for_timeout(1600)
            # voice-style input: mic glows, the transcript appears word by word, then it is sent
            t_listen = time.monotonic() - t0
            await pg.evaluate("setState('listening','listening…')")
            words = q.split(' ')
            for i in range(1, len(words) + 1):
                await pg.evaluate("t => document.getElementById('you').textContent = t", ' '.join(words[:i]))
                await pg.wait_for_timeout(150)
            await pg.wait_for_timeout(350)
            resp_task = asyncio.ensure_future(pg.wait_for_event('response', predicate=lambda r: '/api/agent' in r.url, timeout=60000))
            t_submit = time.monotonic() - t0
            await pg.evaluate("t => ask(t)", q)
            resp = await resp_task; data = await resp.json()
            await pg.wait_for_function("document.getElementById('status').textContent.startsWith('intent')", timeout=60000)
            t_resp = time.monotonic() - t0
            hold = min(34, 3.5 + len(data.get('speech', '')) / 12.5)
            await pg.wait_for_timeout(int(hold * 1000))
            await pg.screenshot(path=str(B / f'{name}.png'))
            t_end = time.monotonic() - t0
            v = pg.video; await pg.close()
            shutil.copy(await v.path(), B / f'{name}.webm')
            out[name] = {'query': q, 'now': now, 'device': device, 't_listen': t_listen, 't_submit': t_submit, 't_resp': t_resp, 't_end': t_end, 'response': data}
            print(name, data.get('intent'), data.get('lang'), [c['tool'] for c in data.get('calls', [])], f"{t_resp - t_submit:.2f}s", data.get('speech', '')[:90])
            if name in OFFCAM:
                r = agent(*OFFCAM[name]); print('   offcam:', r.get('speech', '')[:90])
        await ctx.close(); await b.close()
    (B / 'agent-responses.json').write_text(json.dumps(out, ensure_ascii=False, indent=1))

asyncio.run(main())
