# edge-tts voices with word timings: narration (Andrew), Alexa = Ava (English and Spanish), Swara (Hindi).
# Alexa lines are the real `speech` returned by the MCP tools in agent-responses.json.
import asyncio, json, os, pathlib, re, subprocess
import edge_tts
for k in list(os.environ):
    if k.lower() in ('http_proxy', 'https_proxy', 'all_proxy'): del os.environ[k]
B = pathlib.Path(__file__).resolve().parent.parent / 'build'
T = B / 'tts'; T.mkdir(exist_ok=True)
R = json.load(open(B / 'agent-responses.json'))

VO = {
    'open': "Millions of older parents manage their medicines alone, while the family who'd catch a mistake lives far away. This is Dose Buddy, a voice-first medicine guardian for Alexa Plus.",
    'story': "Meet Dad: four medicines a day. His daughter Maya lives in Chicago. Dose Buddy is an MCP server with ten tools, live FDA label data, and an interaction table where every pair cites its source.",
    's1': "Nine in the morning. Dad just asks.",
    's2': "His knee hurts. Before a painkiller, he checks.",
    's3': "Not sure what a pill is for? Ask in Spanish.",
    's4': "Or in Hindi.",
    's5': "Evening. Two doses slip by.",
    's6': "In Chicago, Maya gets the whole day in one answer.",
    'close': "Every cited quote is re-checked against the live FDA label, and every answer ends with: ask your doctor or pharmacist. Forty-three tests pass, live and offline. Alexa here is a simulator, alerts are simulated, and the tables are small on purpose.",
}


def alexa_text(name):
    s = R[name]['response']['speech']
    if name == 's4':  # Hindi: first three sentences only (brand line, purpose); the card shows the rest
        parts = re.split(r'(?<=[।])\s+', s)
        s = ' '.join(parts[:2])
    return s


def speakable(s):
    return (s.replace('9:05 AM', '9:05 a.m.').replace('8 PM', '8 p.m.').replace('9 PM', '9 p.m.').replace('10:45 PM', '10:45 p.m.')
             .replace('FDA', 'F.D.A.').replace('MCP', 'M.C.P.').replace('EE. UU.', 'Estados Unidos'))


JOBS = {f'vo_{k}': (v, 'en-US-AndrewMultilingualNeural', '+0%') for k, v in VO.items()}
for n in R:
    lang = R[n]['response'].get('lang', 'en')
    JOBS[f'alexa_{n}'] = (alexa_text(n), 'hi-IN-SwaraNeural' if lang == 'hi' else 'en-US-AvaMultilingualNeural', '+10%')


async def run(name, text, voice, rate):
    c = edge_tts.Communicate(speakable(text), voice, rate=rate, boundary='WordBoundary')
    words, audio = [], bytearray()
    async for ch in c.stream():
        if ch['type'] == 'audio': audio += ch['data']
        elif ch['type'] == 'WordBoundary': words.append((ch['offset'] / 1e7, (ch['offset'] + ch['duration']) / 1e7, ch['text']))
    (T / f'{name}.mp3').write_bytes(audio)
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', str(T / f'{name}.mp3'), '-ar', '48000', '-ac', '1', str(T / f'{name}.wav')], check=True)
    dur = float(subprocess.check_output(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', str(T / f'{name}.wav')]))
    return {'display': text, 'voice': voice, 'words': words, 'dur': dur}


async def main():
    out = {}
    for name, (text, voice, rate) in JOBS.items():
        cache = T / f'{name}.json'
        if cache.exists() and json.load(open(cache)).get('display') == text:
            out[name] = json.load(open(cache))
        else:
            for attempt in range(3):
                try: out[name] = await run(name, text, voice, rate); break
                except Exception as e: print('retry', name, e)
            json.dump(out[name], open(cache, 'w'), ensure_ascii=False)
        print(f"{name:10s} {out[name]['dur']:6.2f}s  {len(out[name]['words'])} words")
    json.dump(out, open(T / 'words.json', 'w'), ensure_ascii=False, indent=1)
    print('total voice', round(sum(v['dur'] for v in out.values()), 1))

asyncio.run(main())
