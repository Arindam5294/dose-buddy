# Sound for the Dose Buddy demo, all synthesized here (no samples, no copyrighted music): a warm pad bed in
# A major, whooshes, a riser + soft boom for the title, UI blips, an alert tone and a phone ping. Voices are placed
# from plan.json, the bed is ducked under speech, and the mix is loudness-normalised to -16 LUFS.
import json, pathlib, subprocess
import numpy as np
from scipy import signal

B = pathlib.Path(__file__).resolve().parent.parent / 'build'
P = json.load(open(B / 'plan.json')); SR = 48000
N = int((P['total'] + 1.0) * SR); rng = np.random.default_rng(11)
env = lambda n, tau: np.exp(-np.arange(n) / (tau * SR))
lp = lambda x, f: signal.sosfilt(signal.butter(2, f, 'low', fs=SR, output='sos'), x)
hp = lambda x, f: signal.sosfilt(signal.butter(2, f, 'high', fs=SR, output='sos'), x)
bp = lambda x, a, b: signal.sosfilt(signal.butter(2, [a, b], 'band', fs=SR, output='sos'), x)

def reverb(x, sec=1.4, wet=.28):
    n = int(sec * SR); ir = lp(rng.standard_normal(n) * env(n, sec / 6), 6000); ir /= np.sqrt(np.sum(ir ** 2))
    y = signal.fftconvolve(x, ir); out = np.zeros(len(y)); out[:len(x)] += x * (1 - wet); out += y * wet; return out

def norm(x, g=1.0): return x / (np.max(np.abs(x)) + 1e-9) * g
def st(x, pan=0.0): return np.stack([x * np.cos((pan + 1) * np.pi / 4), x * np.sin((pan + 1) * np.pi / 4)], 1)

def whoosh(d=0.7):
    n = int(d * SR); t = np.linspace(0, 1, n); x = np.zeros(n); noise = rng.standard_normal(n)
    for i, fc in enumerate(np.geomspace(300, 4200, 8)):
        x += bp(noise, fc / 1.35, fc * 1.35) * np.exp(-((t - i / 7) ** 2) / 0.02)
    x *= np.where(t < .55, (t / .55) ** 2, np.exp(-(t - .55) / .22)); x = norm(x, .5)
    return np.stack([x * np.cos(t * np.pi / 2), x * np.sin(t * np.pi / 2)], 1)

def riser(d=1.6):
    n = int(d * SR); t = np.arange(n) / SR; f = 220 * 4 ** (t / d); ph = 2 * np.pi * np.cumsum(f) / SR
    x = (np.sin(ph) * .5 + np.sin(2 * ph) * .2 + bp(rng.standard_normal(n), 800, 6000) * .4) * (t / d) ** 2.4
    return st(norm(reverb(lp(x, 5000), 1.0, .3), .45))

def boom():
    n = int(3 * SR); t = np.arange(n) / SR; f = 40 + 70 * np.exp(-t / .1)
    x = np.tanh(1.6 * np.sin(2 * np.pi * np.cumsum(f) / SR) * env(n, .8)) + lp(rng.standard_normal(n), 150) * env(n, .5) * 1.5
    return st(norm(reverb(x, 2.2, .3), .8))

def bell(freqs, d=1.6, g=.35):
    n = int(d * SR); t = np.arange(n) / SR; x = sum(a * np.sin(2 * np.pi * fr * t) * env(n, d / (2 + k)) for k, (fr, a) in enumerate(freqs))
    return st(norm(reverb(x, 1.2, .3), g))

blip = lambda: bell([(1760, 1), (2640, .4)], .5, .22)
alert = lambda: bell([(659.3, 1), (987.8, .7), (1318.5, .3)], 1.6, .32)       # E5+B5: soft "attention" chime
ping = lambda: bell([(1567.98, 1), (2349.3, .5)], 1.2, .3)                   # phone notification
tick = lambda: bell([(2200, 1)], .3, .18)
def shimmer():
    n = int(2.4 * SR); t = np.arange(n) / SR
    x = sum(a * np.sin(2 * np.pi * fr * t + rng.uniform(0, 6)) for fr, a in [(1318.5, .5), (1760, .4), (2217.5, .3), (2637, .2)])
    x *= np.minimum(t / .4, 1) * np.exp(-np.maximum(t - .4, 0) / .7); return st(norm(reverb(x, 2, .4), .3))
SFX = {'whoosh': whoosh, 'riser': riser, 'boom': boom, 'blip': blip, 'alert': alert, 'ping': ping, 'tick': tick, 'shimmer': shimmer}

def pad():
    # A – F#m – D – E, 8 s per chord, soft detuned saws through a low-pass, slow swell
    chords = [[220, 277.18, 329.63], [185, 220, 277.18], [146.83, 220, 293.66], [164.81, 207.65, 246.94]]
    out = np.zeros(N); seg = 8 * SR; t = np.arange(seg) / SR
    for i in range(N // seg + 1):
        ch = chords[i % 4]; x = np.zeros(seg)
        for f in ch:
            for det in (-0.25, 0.25): x += signal.sawtooth(2 * np.pi * (f + det) * t) * .12
            x += np.sin(2 * np.pi * f / 2 * t) * .18
        x = lp(x, 900) * np.minimum(1, np.minimum(t / 1.5, (8 - t) / 1.5) + .35)
        a = i * seg; b = min(N, a + seg); out[a:b] += x[:b - a]
    return np.stack([out, np.roll(out, int(.015 * SR))], 1) * .5

def load(name):
    raw = subprocess.check_output(['ffmpeg', '-v', 'error', '-i', str(B / 'tts' / f'{name}.wav'), '-f', 'f32le', '-ac', '1', '-ar', str(SR), '-'])
    return np.frombuffer(raw, np.float32).copy()

voice = np.zeros(N); sfx = np.zeros((N, 2))
for s in P['shots']:
    for clip, at in s['voices']:
        x = load(clip); a = int((s['start'] + at) * SR); voice[a:a + len(x)] += x[:max(0, N - a)]
    for name, at in s.get('sfx', []):
        x = SFX[name](); a = int(max(0, s['start'] + at) * SR); b = min(N, a + len(x)); sfx[a:b] += x[:b - a]
bed = pad()
# duck the bed under the voices
envl = np.abs(voice); envl = signal.filtfilt(*signal.butter(1, 4 / (SR / 2)), envl)
duck = 1 - 0.72 * np.clip(envl / (np.percentile(envl[envl > 1e-4], 70) + 1e-9), 0, 1)
t = np.arange(N) / SR; fade = np.clip(t / 2.5, 0, 1) * np.clip((P['total'] - t) / 2.5, 0, 1)
mix = bed * (0.16 * duck * fade)[:, None] + sfx * 0.55 + np.stack([voice, voice], 1) * 0.95
mix = np.tanh(mix * 1.1) / 1.1
wav = B / 'mix_raw.wav'
subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'f32le', '-ar', str(SR), '-ac', '2', '-i', '-', str(wav)], input=mix.astype(np.float32).tobytes(), check=True)
subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', str(wav), '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11', '-ar', '48000', '-c:a', 'aac', '-b:a', '192k', str(B / 'mix.m4a')], check=True)
print('audio ok', round(P['total'], 2), 's')
