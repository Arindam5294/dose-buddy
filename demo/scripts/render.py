# Renders the Dose Buddy demo video frame by frame (PIL + numpy) from build/plan.json: designed title, story and
# end cards, the real Playwright screen captures with eased camera moves, chapter bars and word-timed captions.
# Usage: python3 render.py <part_index> <part_count>   → build/part_<i>.mp4 (video only; audio.py makes the mix)
import json, math, pathlib, subprocess, sys, functools
import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageFilter

B = pathlib.Path(__file__).resolve().parent.parent / 'build'
W, H, FPS = 1920, 1080, 30
P = json.load(open(B / 'plan.json')); SHOTS = P['shots']; XF = P['xf']; TOTAL = P['total']
WJ = json.load(open(B / 'tts' / 'words.json'))
R = json.load(open(B / 'agent-responses.json'))
CY, VI, GR, AM, RD, TX, MU = (56, 189, 248), (167, 139, 250), (52, 211, 153), (251, 191, 36), (251, 113, 133), (238, 243, 251), (142, 156, 184)


@functools.lru_cache(maxsize=None)
def font(name, size, weight=None):
    f = ImageFont.truetype(str(B / 'fonts' / f'{name}.ttf'), size, layout_engine=ImageFont.Layout.RAQM)
    if weight:
        try: f.set_variation_by_name(weight)
        except Exception: pass
    return f


def clamp(x, a=0.0, b=1.0): return a if x < a else b if x > b else x
def ease_io(p): p = clamp(p); return 4 * p ** 3 if p < .5 else 1 - (-2 * p + 2) ** 3 / 2
def ease_out(p, k=3): return 1 - (1 - clamp(p)) ** k
def lerp(a, b, p): return a + (b - a) * p


def paste(base, im, x, y, alpha=1.0):
    """alpha-composite RGBA PIL image onto float32 RGB numpy base"""
    if alpha <= 0.004: return
    a = np.asarray(im, dtype=np.float32); x, y = int(round(x)), int(round(y)); h, w = a.shape[:2]
    x0, y0, x1, y1 = max(0, x), max(0, y), min(W, x + w), min(H, y + h)
    if x1 <= x0 or y1 <= y0: return
    sub = a[y0 - y:y1 - y, x0 - x:x1 - x]; al = sub[..., 3:4] / 255.0 * alpha
    base[y0:y1, x0:x1] = base[y0:y1, x0:x1] * (1 - al) + sub[..., :3] * al


def text_img(txt, f, fill=TX + (255,), tracking=0):
    if tracking:
        ws = [f.getlength(c) for c in txt]; asc, desc = f.getmetrics()
        im = Image.new('RGBA', (int(sum(ws) + tracking * len(txt)) + 8, asc + desc + 8), (0, 0, 0, 0)); d = ImageDraw.Draw(im); x = 4
        for c, w_ in zip(txt, ws): d.text((x, 4), c, font=f, fill=fill); x += w_ + tracking
        return im
    l, t, r, b = f.getbbox(txt); im = Image.new('RGBA', (r - l + 8, b - t + 8), (0, 0, 0, 0))
    ImageDraw.Draw(im).text((4 - l, 4 - t), txt, font=f, fill=fill); return im


def rrect(w, h, r, fill, outline=None, width=2):
    im = Image.new('RGBA', (w, h), (0, 0, 0, 0)); ImageDraw.Draw(im).rounded_rectangle([0, 0, w - 1, h - 1], r, fill=fill, outline=outline, width=width); return im


def glow(im, radius=18, strength=1.0):
    g = im.filter(ImageFilter.GaussianBlur(radius)); a = np.asarray(g).astype(np.float32); a[..., 3] *= strength
    out = Image.fromarray(np.clip(a, 0, 255).astype(np.uint8)); out.alpha_composite(im); return out


# ── backgrounds ─────────────────────────────────────────────────────────────
def make_bg(seed=0):
    y, x = np.mgrid[0:H, 0:W].astype(np.float32)
    base = np.zeros((H, W, 3), np.float32) + np.array([7, 10, 22], np.float32)
    for cx, cy, r, col, a in [(300, -100, 900, (20, 45, 95), .9), (1750, 1150, 800, (55, 25, 90), .8), (1100, 500, 700, (10, 30, 55), .5)]:
        d = np.sqrt((x - cx) ** 2 + (y - cy) ** 2) / r; m = np.clip(1 - d, 0, 1) ** 2 * a
        base = base * (1 - m[..., None]) + np.array(col, np.float32) * m[..., None] + base * 0
    vig = np.clip(1.15 - 0.55 * (((x - W / 2) / (W / 1.2)) ** 2 + ((y - H / 2) / (H / 1.1)) ** 2), 0.55, 1)
    base *= vig[..., None]
    rng = np.random.default_rng(seed); base += rng.normal(0, 1.6, (H, W, 1))
    return np.clip(base, 0, 255).astype(np.float32)
BG = make_bg()

# capsule logo (cyan/violet halves), drawn once at 2x
def capsule(size=360):
    s = size; im = Image.new('RGBA', (s, s), (0, 0, 0, 0)); d = ImageDraw.Draw(im)
    w, h = int(s * .8), int(s * .34); x0, y0 = (s - w) // 2, (s - h) // 2
    left = Image.new('RGBA', (s, s), (0, 0, 0, 0)); ImageDraw.Draw(left).rounded_rectangle([x0, y0, x0 + w, y0 + h], h // 2, fill=CY + (255,))
    right = Image.new('RGBA', (s, s), (0, 0, 0, 0)); ImageDraw.Draw(right).rounded_rectangle([x0, y0, x0 + w, y0 + h], h // 2, fill=VI + (255,))
    mask = Image.new('L', (s, s), 0); ImageDraw.Draw(mask).rectangle([0, 0, s // 2, s], fill=255)
    im = Image.composite(left, right, mask)
    hl = Image.new('RGBA', (s, s), (0, 0, 0, 0)); ImageDraw.Draw(hl).rounded_rectangle([x0 + h * .3, y0 + h * .18, x0 + w - h * .3, y0 + h * .36], h // 8, fill=(255, 255, 255, 70)); im.alpha_composite(hl)
    ImageDraw.Draw(im).line([s // 2, y0 + 4, s // 2, y0 + h - 4], fill=(7, 10, 22, 255), width=max(3, s // 90))
    return glow(im.rotate(32, resample=Image.BICUBIC), 28, 1.1)
CAPS = capsule()

# ── captions ────────────────────────────────────────────────────────────────
import difflib, re as _re
def _n(w): return _re.sub(r'[^\w\u0900-\u097F]', '', w.lower())
def phrases(clip):
    """caption phrases from the DISPLAY text (with punctuation), timed by aligning to edge-tts word boundaries"""
    words = WJ[clip]['words']; disp = WJ[clip]['display'].split()
    if clip == 'alexa_s4': disp = ' '.join(_re.split(r'(?<=[।])\s+', WJ[clip]['display'])[:2]).split()
    sp = [_n(w[2].replace('F.D.A.', 'FDA').replace('M.C.P.', 'MCP').replace('a.m.', 'AM').replace('p.m.', 'PM')) for w in words]
    dn = [_n(w) for w in disp]
    times = [None] * len(disp)
    sm = difflib.SequenceMatcher(None, dn, sp, autojunk=False)
    for a, b, n in sm.get_matching_blocks():
        for k in range(n): times[a + k] = (words[b + k][0], words[b + k][1])
    # fill gaps by interpolation between known neighbours
    known = [i for i, t in enumerate(times) if t]
    for i in range(len(disp)):
        if times[i] is None:
            prev = max([k for k in known if k < i] or [None], key=lambda x: -1 if x is None else x)
            nxt = min([k for k in known if k > i] or [None], key=lambda x: 1e9 if x is None else x)
            t0 = times[prev][1] if prev is not None else 0.0
            t1 = times[nxt][0] if nxt is not None else (t0 + 0.4)
            times[i] = (t0 + (t1 - t0) * 0.3, t0 + (t1 - t0) * 0.9)
    lim = 40 if clip == 'alexa_s4' else 50
    out, cur = [], []
    for w, (s0, e0) in zip(disp, times):
        cur.append([s0, e0, w]); txt = ' '.join(x[2] for x in cur)
        if (w.endswith(('.', '?', '!', '।')) and len(txt) > 8) or (w.endswith((',', ':', ';')) and len(txt) > 26) or len(txt) >= lim:
            out.append(cur); cur = []
    if cur: out.append(cur)
    return out
PH = {k: phrases(k) for k in WJ}

@functools.lru_cache(maxsize=4096)
def caption_img(clip, pi, wi, tagged):
    ph = PH[clip][pi]; deva = clip == 'alexa_s4'
    f = font('NotoDeva', 40, 'SemiBold') if deva else font('Inter', 40, 'SemiBold')
    ftag = font('Inter', 19, 'Bold')
    words = [w[2] for w in ph]; space = f.getlength(' ')
    widths = [f.getlength(w) for w in words]; tw = sum(widths) + space * (len(words) - 1)
    tagw = (ftag.getlength('ALEXA') + 26 + 18) if tagged else 0
    pw, ph_ = int(tw + tagw + 56), 76
    im = rrect(pw, ph_, 22, (6, 9, 20, 205), (60, 74, 110, 140), 1); d = ImageDraw.Draw(im)
    x = 28
    if tagged:
        tg = rrect(int(ftag.getlength('ALEXA') + 26), 30, 9, VI + (255,)); ImageDraw.Draw(tg).text((13, 4), 'ALEXA', font=ftag, fill=(10, 8, 30, 255)); im.alpha_composite(tg, (x, 23)); x += tagw
    asc = f.getmetrics()[0]; ty = (ph_ - asc) // 2 - (2 if not deva else 6)
    for i, (w, ww) in enumerate(zip(words, widths)):
        col = (CY + (255,)) if i == wi else (TX + (255,)) if i < wi else (205, 214, 230, 255)
        d.text((x, ty), w, font=f, fill=col); x += ww + space
    return im

def draw_caption(base, clip, local_t, tagged):
    for pi, ph in enumerate(PH[clip]):
        s0 = ph[0][0]; e0 = PH[clip][pi + 1][0][0] if pi + 1 < len(PH[clip]) else ph[-1][1] + 0.6
        if s0 - 0.05 <= local_t < e0:
            wi = max([i for i, w in enumerate(ph) if w[0] <= local_t] or [0])
            im = caption_img(clip, pi, wi, tagged); a = clamp((local_t - s0 + 0.05) / 0.15)
            paste(base, im, (W - im.width) / 2, H - 120, a); return

def voice_captions(base, shot, lt):
    for clip, at in shot['voices']:
        tt = lt - at
        if 0 <= tt <= WJ[clip]['dur'] + 0.4: draw_caption(base, clip, tt, clip.startswith('alexa'))

# ── designed cards ──────────────────────────────────────────────────────────
def title_assets():
    t = text_img('Dose Buddy', font('SpaceGrotesk', 150, 'Bold'), TX + (255,))
    sub = text_img('A voice-first medicine guardian for Alexa+', font('Inter', 40, 'Medium'), (190, 204, 228, 255))
    by = text_img('by Swanix', font('Inter', 26, 'SemiBold'), MU + (255,), tracking=3)
    return t, sub, by
TITLE = title_assets()

def story_assets():
    f1, f2, f3 = font('Inter', 22, 'Bold'), font('Inter', 30, 'SemiBold'), font('Inter', 25, 'Medium')
    dad = rrect(620, 560, 30, (16, 24, 44, 245), (52, 70, 110, 255), 2); d = ImageDraw.Draw(dad)
    d.text((40, 36), 'DAD · AT HOME', font=f1, fill=CY + (255,)); d.text((40, 70), 'Four medicines a day', font=font('Inter', 40, 'Bold'), fill=TX + (255,))
    rows = [('Glucophage', 'metformin', '8 AM · 8 PM'), ('Zestril', 'lisinopril', '9 AM'), ('Plavix', 'clopidogrel', '9 AM'), ('Lipitor', 'atorvastatin', '9 PM')]
    for i, (b_, g, tm) in enumerate(rows):
        y = 150 + i * 96; r = rrect(540, 80, 18, (11, 18, 36, 255), (34, 46, 74, 255), 1); dr = ImageDraw.Draw(r)
        dr.ellipse([22, 26, 50, 54], fill=[CY, VI, GR, AM][i] + (255,)); dr.text((70, 12), b_, font=f2, fill=TX + (255,)); dr.text((70, 47), g, font=font('Inter', 20, 'Medium'), fill=MU + (255,))
        tw = f3.getlength(tm); dr.text((520 - tw, 24), tm, font=f3, fill=(200, 214, 240, 255)); dad.alpha_composite(r, (40, y))
    maya = rrect(520, 400, 30, (16, 24, 44, 245), (52, 70, 110, 255), 2); d = ImageDraw.Draw(maya)
    d.text((40, 36), 'MAYA · DAUGHTER · CHICAGO', font=f1, fill=VI + (255,)); d.text((40, 70), 'Another city', font=font('Inter', 40, 'Bold'), fill=TX + (255,))
    ph = rrect(440, 220, 26, (10, 15, 30, 255), (40, 52, 84, 255), 2); dp = ImageDraw.Draw(ph)
    dp.text((26, 22), 'Dose Buddy alerts', font=font('Inter', 24, 'Bold'), fill=TX + (255,))
    sim = rrect(150, 30, 8, (60, 48, 12, 255)); ImageDraw.Draw(sim).text((12, 5), 'SIMULATED', font=font('Inter', 17, 'Bold'), fill=(253, 230, 138, 255)); ph.alpha_composite(sim, (266, 20))
    for j, (tt, col) in enumerate([('Missed dose', AM), ('Medicine warning', RD), ('Refill soon', CY)]):
        nr = rrect(390, 42, 12, (22, 31, 58, 255)); dn = ImageDraw.Draw(nr); dn.rectangle([0, 6, 4, 36], fill=col + (255,)); dn.text((18, 8), tt, font=font('Inter', 21, 'SemiBold'), fill=(220, 228, 244, 255)); ph.alpha_composite(nr, (26, 70 + j * 48))
    maya.alpha_composite(ph, (40, 150))
    return dad, maya
DAD, MAYA = story_assets()

def arch_asset():
    im = Image.new('RGBA', (W, H), (0, 0, 0, 0)); d = ImageDraw.Draw(im)
    def box(x, y, w, h, title, lines, col):
        b = rrect(w, h, 26, (14, 21, 40, 250), col + (255,), 3); db = ImageDraw.Draw(b)
        db.text((34, 28), title, font=font('Inter', 38, 'Bold'), fill=TX + (255,))
        for i, (ln, c) in enumerate(lines): db.text((34, 92 + i * 44), ln, font=font('Inter', 28, 'Medium'), fill=(c or (200, 212, 236)) + (255,))
        im.alpha_composite(glow(b, 14, .35), (x - 14, y - 14) if False else (x, y))
    box(70, 300, 520, 400, 'Alexa+ / any MCP host', [('Echo Show simulator', None), ('mic · speech · demo clock', None), ('EN · ES · HI intent parser', None), ('caregiver phone (simulated)', AM)], (60, 80, 125))
    box(700, 230, 540, 540, 'MCP server · /mcp', [('@modelcontextprotocol/sdk 1.32.1', None), ('protocol 2025-11-25', CY), ('Streamable HTTP sessions', None), ('10 tools · structured output', None), ('MCP Apps card (ui://)', VI), ('JSON state per household', None), ('missed-dose + refill logic', None), ('', None)], VI)
    box(1350, 300, 500, 400, 'Real, cited data', [('openFDA drug labels (live)', GR), ('MedlinePlus EN + ES', None), ('17 cited FDA-label pairs', None), ('47 global brands, curated', None), ('offline snapshot fallback', MU)], (60, 80, 125))
    for x0, x1 in [(590, 700), (1240, 1350)]:
        d.line([x0, 500, x1, 500], fill=CY + (255,), width=4)
    d.text((606, 450), 'MCP', font=font('Inter', 24, 'Bold'), fill=CY + (255,))
    t = text_img('One MCP server. Real data. Every warning cited.', font('SpaceGrotesk', 54, 'Bold')); im.alpha_composite(t, ((W - t.width) // 2, 110))
    return im
ARCH = arch_asset()

def close_assets():
    tiles = []
    for big, small, col in [('17/17', 'cited FDA-label quotes\nverified in live label text', GR), ('43/43', 'MCP tests pass\nlive and offline', CY), ('10', 'MCP tools + an\nMCP Apps card', VI)]:
        t = rrect(470, 220, 26, (14, 21, 40, 245), col + (200,), 2); d = ImageDraw.Draw(t)
        d.text((34, 26), big, font=font('SpaceGrotesk', 80, 'Bold'), fill=col + (255,))
        for i, ln in enumerate(small.split('\n')): d.text((36, 130 + i * 36), ln, font=font('Inter', 27, 'Medium'), fill=(205, 215, 236, 255))
        tiles.append(t)
    lim = []
    for ln in ['Alexa+ shown in a web simulator', 'Family alerts simulated · no SMS sent', 'Curated tables, small on purpose']:
        t = rrect(len(ln) * 15 + 60, 54, 16, (30, 24, 10, 230), (120, 96, 30, 255), 1); ImageDraw.Draw(t).text((28, 12), ln, font=font('Inter', 25, 'SemiBold'), fill=(253, 230, 160, 255)); lim.append(t)
    disc = text_img('Not medical advice. Ask your doctor or pharmacist.', font('Inter', 32, 'SemiBold'), (200, 190, 255, 255))
    by = text_img('Built by Swanix · MIT licensed · openFDA · MedlinePlus', font('Inter', 26, 'Medium'), MU + (255,))
    return tiles, lim, disc, by
TILES, LIMS, DISC, BYLINE = close_assets()

# ── capture readers ─────────────────────────────────────────────────────────
class Reader:
    def __init__(self, src, start):
        self.p = subprocess.Popen(['ffmpeg', '-v', 'error', '-ss', f'{start:.3f}', '-i', str(B / src), '-vf', f'fps={FPS},scale={W}:{H}', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], stdout=subprocess.PIPE)
        self.idx = -1; self.last = None
    def frame(self, i):
        while self.idx < i:
            buf = self.p.stdout.read(W * H * 3)
            if len(buf) < W * H * 3: break
            self.last = np.frombuffer(buf, np.uint8).reshape(H, W, 3); self.idx += 1
        return self.last
READERS = {}

def cam_at(keys, t):
    if t <= keys[0][0]: return keys[0][1:]
    for a, b in zip(keys, keys[1:]):
        if t < b[0]:
            span = b[0] - a[0]; mv = min(1.3, span)  # move over at most 1.3 s, then hold with slow drift
            p = ease_io((t - (b[0] - mv)) / mv) if mv > 0 else 1
            return [lerp(a[i], b[i], p) for i in (1, 2, 3)]
    return keys[-1][1:]

def capture(shot, lt, fi_global):
    key = shot['name']
    if key not in READERS: READERS[key] = (Reader(shot['src'], shot['cap_in'] + lt), fi_global)
    rd, f0 = READERS[key]
    fr = rd.frame(fi_global - f0)
    cx, cy, s = cam_at(shot['cam'], lt)
    s *= 1 + 0.012 * math.sin(lt * 0.35)  # breathing
    cw, ch = W / s, H / s; x0 = clamp(cx - cw / 2, 0, W - cw); y0 = clamp(cy - ch / 2, 0, H - ch)
    im = Image.fromarray(fr).resize((W, H), Image.BILINEAR, box=(x0, y0, x0 + cw, y0 + ch)) if s > 1.001 else Image.fromarray(fr)
    base = np.asarray(im, dtype=np.float32).copy()
    # chapter bar
    n, title, tool = shot['chapter']; a = ease_out(lt / 0.6)
    bar = np.zeros((70, W, 3), np.float32); base[:70] = base[:70] * 0.25 + bar * 0.75
    f = font('Inter', 24, 'Bold'); fm = font('JBMono', 21)
    paste(base, text_img(f'{n}', font('SpaceGrotesk', 30, 'Bold'), CY + (255,)), 40 - 30 * (1 - a), 16, a)
    paste(base, text_img(title.upper() if shot.get('lang') != 'hi' or True else title, font('NotoDeva', 24, 'Bold') if 'हिंदी' in title else f, TX + (255,), tracking=0), 92, 18, a)
    paste(base, text_img(tool, fm, (125, 211, 252, 255)), 92 + f.getlength(title.upper()) + 40 + (60 if 'हिंदी' in title else 0), 20, a)
    rt = text_img('●  REAL CAPTURE · ALEXA+ SIMULATOR · LIVE MCP TOOL OUTPUT', font('Inter', 18, 'Bold'), (150, 165, 192, 255), tracking=1)
    paste(base, rt, W - rt.width - 36, 22, a)
    paste(base, text_img('●', font('Inter', 18, 'Bold'), RD + (255,)), W - rt.width - 32, 21, a * (0.6 + 0.4 * math.sin(lt * 5)))
    # big chapter title at the start
    ca = clamp(1 - (lt - 1.15) / 0.35) if lt > 1.15 else ease_out(lt / 0.35)
    if ca > 0:
        base *= 1 - 0.45 * ca
        big = text_img(title, font('NotoDeva', 76, 'Bold') if 'हिंदी' in title else font('SpaceGrotesk', 76, 'Bold'))
        num = text_img(n, font('SpaceGrotesk', 34, 'Bold'), CY + (255,), tracking=4)
        paste(base, num, (W - num.width) / 2, 420 - 12 * (1 - ca), ca)
        paste(base, big, (W - big.width) / 2, 470 - 12 * (1 - ca), ca)
    return base

def open_frame(shot, lt):
    base = BG.copy(); rv = shot['reveal']
    # breathing light ring before the reveal
    pre = clamp(1 - (lt - (rv - 0.3)) / 0.3) if lt > rv - 0.3 else 1
    if pre > 0:
        r = 120 + 14 * math.sin(lt * 2.2); ring = Image.new('RGBA', (420, 420), (0, 0, 0, 0)); ImageDraw.Draw(ring).ellipse([210 - r, 210 - r, 210 + r, 210 + r], outline=CY + (230,), width=6)
        ring = glow(ring, 20, 1.2); paste(base, ring, W / 2 - 210, H / 2 - 260, pre * ease_out(lt / 1.2))
        sm = CAPS.resize((180, 180)); paste(base, sm, W / 2 - 90, H / 2 - 140, pre * ease_out(lt / 1.2))
    if lt > rv:
        p = ease_out((lt - rv) / 0.9); s = int(lerp(140, 300, p)); cap = CAPS.resize((s, s))
        paste(base, cap, W / 2 - s / 2, 230 - s / 2 + 20, p)
        t, sub, by = TITLE; sc = lerp(0.92, 1.0, p); ti = t.resize((int(t.width * sc), int(t.height * sc)))
        paste(base, ti, (W - ti.width) / 2, 420, p)
        p2 = ease_out((lt - rv - 0.35) / 0.8); paste(base, sub, (W - sub.width) / 2, 610 + 10 * (1 - p2), p2)
        p3 = ease_out((lt - rv - 0.8) / 0.8); paste(base, by, (W - by.width) / 2, 690, p3)
    return base

def story_frame(shot, lt):
    base = BG.copy(); aa = shot['arch_at']
    sa = clamp(1 - (lt - aa) / 0.5) if lt > aa else 1
    if sa > 0:
        p1 = ease_out(lt / 0.8); p2 = ease_out((lt - 1.6) / 0.8)
        paste(base, DAD, 150 - 40 * (1 - p1), 250, p1 * sa); paste(base, MAYA, 1250 + 40 * (1 - p2), 330, p2 * sa)
        # dashed link with a travelling dot
        if p2 > 0:
            y = 530; d = Image.new('RGBA', (500, 40), (0, 0, 0, 0)); dd = ImageDraw.Draw(d)
            for x in range(0, 480, 26): dd.line([x, 20, x + 14, 20], fill=(90, 110, 160, 255), width=3)
            dx = (lt * 160) % 480; dd.ellipse([dx - 9, 11, dx + 9, 29], fill=AM + (255,)); paste(base, glow(d, 6, .8), 770, y, p2 * sa)
    if lt > aa - 0.1:
        p = ease_out((lt - aa + 0.1) / 0.7); z = 1 + 0.035 * clamp((lt - aa) / 10)
        im = ARCH if z < 1.001 else ARCH.resize((int(W * z), int(H * z)), Image.BILINEAR)
        paste(base, im, (W - im.width) / 2, (H - im.height) / 2 + 20 * (1 - p), p)
    return base

def close_frame(shot, lt):
    base = BG.copy()
    p = ease_out(lt / 0.8); s = 150; cap = CAPS.resize((s, s)); paste(base, cap, W / 2 - 390, 70, p)
    t = TITLE[0].resize((int(TITLE[0].width * .62), int(TITLE[0].height * .62))); paste(base, t, W / 2 - 200, 100, p)
    for i, tl in enumerate(TILES):
        q = ease_out((lt - 0.8 - i * 0.6) / 0.7); paste(base, tl, 180 + i * 540, 330 + 20 * (1 - q), q)
    xs = sum(l.width for l in LIMS) + 30 * (len(LIMS) - 1); x = (W - xs) / 2
    for i, l in enumerate(LIMS):
        q = ease_out((lt - 9.5 - i * 0.5) / 0.6); paste(base, l, x, 610, q); x += l.width + 30
    q = ease_out((lt - 2.5) / 0.8); paste(base, DISC, (W - DISC.width) / 2, 720, q)
    q = ease_out((lt - 12.5) / 0.8); paste(base, BYLINE, (W - BYLINE.width) / 2, 790, q)
    return base

def shot_frame(shot, lt, fi):
    k = shot['kind']
    base = open_frame(shot, lt) if k == 'open' else story_frame(shot, lt) if k == 'story' else close_frame(shot, lt) if k == 'close' else capture(shot, lt, fi)
    voice_captions(base, shot, lt)
    return base

def frame(fi):
    t = fi / FPS; act = [s for s in SHOTS if s['start'] <= t < s['start'] + s['dur']]
    if not act: act = [SHOTS[-1]]
    out = shot_frame(act[0], t - act[0]['start'], fi)
    if len(act) > 1:
        a = ease_io((t - act[1]['start']) / XF); out = out * (1 - a) + shot_frame(act[1], t - act[1]['start'], fi) * a
    # global fade in/out
    if t < 0.6: out *= t / 0.6
    if t > TOTAL - 1.0: out *= max(0, (TOTAL - t) / 1.0)
    return np.clip(out, 0, 255).astype(np.uint8)

if __name__ == '__main__':
    part, parts = int(sys.argv[1]), int(sys.argv[2])
    N = int(round(TOTAL * FPS)); a, b = N * part // parts, N * (part + 1) // parts
    if len(sys.argv) > 3:  # still frames for checking: render.py 0 1 t1,t2,...
        for tt in sys.argv[3].split(','):
            READERS.clear(); fi = int(float(tt) * FPS)
            Image.fromarray(frame(fi)).save(B / f'still_{float(tt):06.2f}.png')
        sys.exit()
    enc = subprocess.Popen(['ffmpeg', '-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', f'{W}x{H}', '-r', str(FPS), '-i', '-', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '19', '-pix_fmt', 'yuv420p', str(B / f'part_{part}.mp4')], stdin=subprocess.PIPE)
    for fi in range(a, b):
        enc.stdin.write(frame(fi).tobytes())
        if fi % 150 == 0: print(f'part {part}: {fi}/{b}', flush=True)
    enc.stdin.close(); enc.wait(); print('done part', part, a, b)
