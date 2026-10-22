"""Compose the 49 s music bed for the drafting-sheet film.

The chiptune belongs to the 1997 desktop in the other cut. This film is a cyanotype
drawing sheet: cold, slow, technical. Drawn-out sine pads, a low pulse like a
metronome left running in the corner, and one four-note motif that comes back three
times. No drums, nothing in the band a chart has to read through.

    python mkbgm2.py --out assets/bgm/sheet.wav
"""

import argparse
import pathlib

import numpy as np
import soundfile as sf

from mkbgm import lpf, midi

SR = 44100
TOTAL = 49.0
BPM = 52.0
BEAT = 60.0 / BPM
BAR = BEAT * 4

# one bar each: Dm - Bbmaj7 - Gm - A
PROG = [
    (38, [0, 3, 7, 12]),
    (34, [0, 4, 7, 11]),
    (31, [0, 3, 7, 10]),
    (33, [0, 4, 7, 12]),
]
# motif: four notes, three passes, each pass a little different
MOTIF = [0, 3, 7, 10]
PASSES = ((8.5, 74), (20.5, 76), (32.5, 69))


def env(n, attack, release):
    e = np.ones(n, dtype=np.float32)
    a = min(max(1, int(attack * SR)), n)
    r = min(max(1, int(release * SR)), n)
    e[:a] = np.linspace(0.0, 1.0, a, dtype=np.float32)
    e[n - r :] *= np.linspace(1.0, 0.0, r, dtype=np.float32)
    return e


def pad(freqs, dur):
    """A chord of sines, each voice slightly detuned so the stack breathes."""
    n = int(dur * SR)
    t = np.arange(n, dtype=np.float32) / SR
    out = np.zeros(n, dtype=np.float32)
    for i, f in enumerate(freqs):
        det = 1.0 + (i - 1) * 0.0016
        out += (np.sin(2 * np.pi * f * det * t) / (i + 1.7)).astype(np.float32)
    return out


def pluck(freq, dur):
    n = int(dur * SR)
    t = np.arange(n, dtype=np.float32) / SR
    y = (
        np.sin(2 * np.pi * freq * t)
        + 0.34 * np.sin(2 * np.pi * freq * 2.0 * t)
        + 0.12 * np.sin(2 * np.pi * freq * 3.0 * t)
    )
    return (y * np.exp(-t * 5.5)).astype(np.float32)


def place(buf, x, at, gain):
    i = int(at * SR)
    if i < 0:
        x = x[-i:]
        i = 0
    j = min(len(buf), i + len(x))
    if j > i:
        buf[i:j] += x[: j - i] * gain


def delay(x, t, fb, wet, taps=6):
    """Feed-forward multi-tap, so the room is deterministic and cheap."""
    d = int(t * SR)
    y = x.copy()
    for k in range(1, taps + 1):
        off = d * k
        if off >= len(x):
            break
        y[off:] += x[: len(x) - off] * (fb**k) * wet
    return y


def compose():
    n = int(TOTAL * SR)
    mix = np.zeros(n, dtype=np.float32)

    for b in range(int(np.ceil(TOTAL / BAR))):
        root, iv = PROG[b % len(PROG)]
        t0 = b * BAR
        p = pad([midi(root + 12 + i) for i in iv], BAR * 1.15)
        p *= env(len(p), 1.3, 1.7)
        place(mix, p, t0, 0.30)
        # the pulse: root on beats 1 and 3, quiet, like a marking gauge
        for k in (0, 2):
            place(mix, pluck(midi(root), 1.1), t0 + k * BEAT, 0.15)

    for start, base in PASSES:
        for i, s in enumerate(MOTIF):
            place(mix, pluck(midi(base + s), 1.8), start + i * BEAT * 1.5, 0.19)

    mix = delay(mix, BEAT * 1.5, 0.42, 0.5)
    mix = lpf(mix, 5200)
    peak = float(np.max(np.abs(mix))) or 1.0

    f = int(1.5 * SR)
    mix[:f] *= np.linspace(0.0, 1.0, f, dtype=np.float32)
    r = int(3.0 * SR)
    mix[n - r :] *= np.linspace(1.0, 0.0, r, dtype=np.float32)
    return (mix / peak * 0.86).astype(np.float32)


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--out", default="assets/bgm/sheet.wav")
    a = p.parse_args()
    y = compose()
    path = pathlib.Path(a.out)
    path.parent.mkdir(parents=True, exist_ok=True)
    sf.write(str(path), y, SR)
    print(f"{path}  {len(y) / SR:.2f}s  {SR} Hz  {path.stat().st_size // 1024}KB")
