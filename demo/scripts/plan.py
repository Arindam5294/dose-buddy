# Edit decision list for the Dose Buddy demo: shot order and durations, where each voice line sits, the slice of
# each real screen capture to use, camera keyframes and sound cues. Writes build/plan.json for render.py + audio.py.
import json, pathlib
B = pathlib.Path(__file__).resolve().parent.parent / 'build'
R = json.load(open(B / 'agent-responses.json'))
W = json.load(open(B / 'tts' / 'words.json'))
D = {k: v['dur'] for k, v in W.items()}
XF = 0.5          # crossfade between shots

def word_t(clip, needle, default=0.0):
    for s, e, w in W[clip]['words']:
        if needle.lower() in w.lower(): return s
    return default

shots, t = [], 0.0
def add(**kw):
    global t
    kw['start'] = round(t, 3); shots.append(kw); t += kw['dur'] - XF

# 0 · cold open
reveal = word_t('vo_open', 'Dose') - 0.35
add(name='open', kind='open', dur=round(D['vo_open'] + 1.0, 2), voices=[['vo_open', 0.3]], reveal=round(reveal + 0.3, 2),
    sfx=[['riser', reveal + 0.3 - 1.6], ['boom', reveal + 0.3]])
# 1 · story → architecture
arch_at = word_t('vo_story', 'Buddy') - 0.6
add(name='story', kind='story', dur=round(D['vo_story'] + 0.8, 2), voices=[['vo_story', 0.5]], arch_at=round(arch_at + 0.5, 2), sfx=[['whoosh', 0.0], ['tick', arch_at + 0.5]])

CH = {
    's1': ('01', 'What do I take now?', 'what_next'),
    's2': ('02', 'A dangerous combination, caught', 'check_interactions'),
    's3': ('03', 'Explained simply · Español', 'explain_medicine'),
    's4': ('04', 'Explained simply · हिंदी', 'explain_medicine'),
    's5': ('05', 'Missed dose → family alert', 'check_missed_doses'),
    's6': ('06', "Caregiver briefing · from Chicago", 'daily_briefing'),
}
# camera targets (cx, cy, scale) in page pixels: reply column, MCP Apps card, caregiver phone
REPLY, CARD, PHONE, FULL = (345, 360, 1.62), (1040, 390, 1.42), (1680, 300, 2.0), (960, 540, 1.0)
CAM = {   # (fraction of the Alexa line, target)
    's1': [(0.0, REPLY), (0.42, CARD)],
    's2': [(0.0, REPLY), (0.30, CARD), (0.62, (1040, 330, 1.75)), (0.86, PHONE)],
    's3': [(0.0, REPLY), (0.35, CARD)],
    's4': [(0.0, REPLY), (0.5, CARD)],
    's5': [(0.0, REPLY), (0.45, PHONE)],
    's6': [(0.0, REPLY), (0.38, CARD), (0.8, PHONE)],
}
for k in ['s1', 's2', 's3', 's4', 's5', 's6']:
    r = R[k]; lead, al = f'vo_{k}', f'alexa_{k}'
    typing = r['t_resp'] - r['t_listen']
    pre = max(0.5, D[lead] + 0.35 - typing)                    # capture seconds shown before "listening" starts
    cap_in = max(0.0, r['t_listen'] - pre)
    resp_local = r['t_resp'] - cap_in                           # when the reply appears, shot-local
    a_at = resp_local + 0.35
    dur = a_at + D[al] + 0.6
    cap_avail = r['t_end'] - cap_in
    keys = [[0.0, *FULL], [max(0.3, resp_local - 0.1), *FULL]]
    for frac, tgt in CAM[k]:
        tt = a_at + frac * D[al] + (1.0 if frac == 0 else 0.6)
        if keys[-1][0] >= tt: tt = keys[-1][0] + 0.9
        keys.append([round(tt, 2), *tgt])
    sfx = [['whoosh', 0.0], ['blip', resp_local]]
    if k in ('s2',): sfx.append(['alert', resp_local + 0.25])
    if k in ('s2', 's5'): sfx.append(['ping', a_at + CAM[k][-1][0] * D[al]])
    add(name=k, kind='capture', dur=round(min(dur, cap_avail + 0.0), 2), src=f'{k}.webm', cap_in=round(cap_in, 3), resp=round(resp_local, 2),
        voices=[[lead, 0.25], [al, round(a_at, 2)]], cam=keys, chapter=CH[k], lang=r['response'].get('lang', 'en'), sfx=sfx)
# close
add(name='close', kind='close', dur=round(D['vo_close'] + 2.4, 2), voices=[['vo_close', 0.5]], sfx=[['whoosh', 0.0], ['shimmer', D['vo_close'] - 1.5]])
total = round(shots[-1]['start'] + shots[-1]['dur'], 2)
json.dump({'shots': shots, 'total': total, 'xf': XF}, open(B / 'plan.json', 'w'), ensure_ascii=False, indent=1)
for s in shots: print(f"{s['name']:6s} start {s['start']:7.2f}  dur {s['dur']:6.2f}")
print('TOTAL', total, 's')
