"""Compose the 60 s music bed: a tracker-style chiptune, written from scratch.

The film's world is a 1997 desktop, so the right music is the music that machine made:
square leads, triangle bass, noise percussion, short envelopes, one arpeggio. Fully
deterministic, exact length, no model and no account.

    python mkbgm.py --out assets/bgm/track.wav
"""

import argparse
import pathlib

import numpy as np
import soundfile as sf

SR = 44100
BPM = 120.0
BEAT = 60.0 / BPM  # 0.5 s
BAR = BEAT * 4  # 2.0 s
BARS = 31  # 62.0 s
TOTAL = BARS * BAR

# A minor, four-bar loop: Am - F - C - G. Root midi + triad degrees.
PROG = [
    (57, [0, 3, 7]),  # Am
    (53, [0, 4, 7]),  # F
    (48, [0, 4, 7]),  # C
    (55, [0, 4, 7]),  # G
]

# sections: (first bar, last bar exclusive, hats, drums, lead, pad)
SECTIONS = [
    (0, 4, True, False, "none", False),
    (4, 12, True, True, "arp", False),
    (12, 20, True, True, "held", True),
    (20, 28, True, True, "arp", True),
    (28, 31, True, False, "none", False),
]


def midi(m):
    return 440.0 * 2.0 ** ((m - 69) / 12.0)


def env(n, attack, decay, sustain=0.0, release=0.0):
    """Simple ADSR over n samples."""
    e = np.zeros(n, dtype=np.float32)
    a = max(1, int(attack * SR))
    d = max(1, int(decay * SR))
    r = int(release * SR)
    a = min(a, n)
    e[:a] = np.linspace(0, 1, a, dtype=np.float32)
    rest = n - a
    if rest <= 0:
        return e
    d = min(d, rest)
    e[a : a + d] = np.linspace(1, sustain, d, dtype=np.float32)
    if rest - d > 0:
        e[a + d :] = sustain
    if r > 0:
        r = min(r, n)
        e[-r:] *= np.linspace(1, 0, r, dtype=np.float32)
    return e


def square(freq, dur, duty=0.5, detune=0.0):
    n = int(dur * SR)
    t = np.arange(n, dtype=np.float32) / SR
    out = np.sign(np.sin(2 * np.pi * freq * t) - (1 - 2 * duty)).astype(np.float32)
    if detune:
        out = 0.5 * out + 0.5 * np.sign(
            np.sin(2 * np.pi * freq * (1 + detune) * t) - (1 - 2 * duty)
        ).astype(np.float32)
    return out


def triangle(freq, dur):
    n = int(dur * SR)
    t = np.arange(n, dtype=np.float32) / SR
    ph = (freq * t) % 1.0
    return (4.0 * np.abs(ph - 0.5) - 1.0).astype(np.float32)


def noise(dur):
    n = int(dur * SR)
    # deterministic LCG noise: same track every render
    s = np.arange(n, dtype=np.uint32) * np.uint32(1664525) + np.uint32(1013904223)
    return ((s >> 16).astype(np.float32) / 32768.0 - 1.0)


def lpf(x, cutoff):
    """One-pole low pass, applied in the frequency domain via a simple moving average."""
    k = max(1, int(SR / max(cutoff, 60.0)))
    if k <= 1:
        return x
    c = np.cumsum(np.concatenate([[0.0], x.astype(np.float64)]))
    y = (c[k:] - c[:-k]) / k
    return np.pad(y, (len(x) - len(y), 0)).astype(np.float32)


def place(buf, x, at, gain):
    i = int(at * SR)
    j = min(len(buf), i + len(x))
    if i >= len(buf) or j <= i:
        return
    buf[i:j] += x[: j - i] * gain


def compose():
    lead = np.zeros(int(TOTAL * SR), dtype=np.float32)
    bass = np.zeros(int(TOTAL * SR), dtype=np.float32)
    pad = np.zeros(int(TOTAL * SR), dtype=np.float32)
    kick = np.zeros(int(TOTAL * SR), dtype=np.float32)
    snare = np.zeros(int(TOTAL * SR), dtype=np.float32)
    hat = np.zeros(int(TOTAL * SR), dtype=np.float32)

    for first, last, hats, drums, leadmode, usepad in SECTIONS:
        for bar in range(first, last):
            t0 = bar * BAR
            root, triad = PROG[bar % 4]

            # bass: root on 1 and 3, octave push on the "and" of 4
            place(bass, triangle(midi(root - 12), BEAT * 0.9) * env(int(BEAT * 0.9 * SR), 0.005, 0.25, 0.25), t0, 0.30)
            place(bass, triangle(midi(root - 12), BEAT * 0.9) * env(int(BEAT * 0.9 * SR), 0.005, 0.25, 0.25), t0 + 2 * BEAT, 0.30)
            place(bass, triangle(midi(root), BEAT * 0.4) * env(int(BEAT * 0.4 * SR), 0.004, 0.18, 0.2), t0 + 3.5 * BEAT, 0.22)

            # pad: soft triad, low in the mix, under the voice
            if usepad:
                for d in triad:
                    v = square(midi(root + d), BAR * 0.95, duty=0.5, detune=0.006)
                    v = lpf(v, 900)
                    place(pad, v * env(int(BAR * 0.95 * SR), 0.08, 0.8, 0.55, 0.5), t0, 0.055)

            if leadmode == "arp":
                # eighth-note arpeggio, up two octaves, bouncing back down
                steps = [0, 1, 2, 1, 0, 1, 2, 1]
                for i, s in enumerate(steps):
                    m = root + 12 + triad[s % 3] + (12 if i in (2, 6) else 0)
                    d = BEAT * 0.46
                    v = square(midi(m), d, duty=0.5, detune=0.004) * env(
                        int(d * SR), 0.003, 0.16, 0.22
                    )
                    place(lead, v, t0 + i * BEAT * 0.5, 0.085)
                # a little answer at the top of the bar
                m = root + 12 + triad[2] + 12
                d = BEAT * 0.3
                place(
                    lead,
                    square(midi(m), d, duty=0.25) * env(int(d * SR), 0.003, 0.2, 0.1),
                    t0 + 3.5 * BEAT,
                    0.05,
                )
            elif leadmode == "held":
                # long tones instead of the arp: the section breathes
                for i, s in enumerate([0, 2]):
                    m = root + 12 + triad[s]
                    d = BEAT * 1.9
                    v = square(midi(m), d, duty=0.5, detune=0.005) * env(
                        int(d * SR), 0.05, 0.9, 0.5, 0.4
                    )
                    place(lead, lpf(v, 3200), t0 + i * 2 * BEAT, 0.075)

            if hats:
                for i in range(8):
                    d = 0.035 if i % 2 == 0 else 0.02
                    place(hat, noise(d) * env(int(d * SR), 0.001, d * 0.9, 0.0), t0 + i * BEAT * 0.5, 0.045 if i % 2 == 0 else 0.026)

            if drums:
                for b in (0, 2):
                    d = 0.16
                    n = int(d * SR)
                    t = np.arange(n, dtype=np.float32) / SR
                    k = np.sin(2 * np.pi * (110 * np.exp(-t * 22) + 42) * t).astype(np.float32)
                    place(kick, k * env(n, 0.001, 0.13, 0.0), t0 + b * BEAT, 0.5)
                for b in (1, 3):
                    d = 0.14
                    n = int(d * SR)
                    v = (0.72 * noise(d) + 0.28 * np.sin(2 * np.pi * 190 * np.arange(n) / SR)).astype(np.float32)
                    place(snare, v * env(n, 0.001, 0.11, 0.0), t0 + b * BEAT, 0.20)

    mix = lead * 0.9 + bass * 0.95 + pad + kick * 0.8 + snare * 0.7 + hat * 0.6
    # keep the 300-3k band open for the voice; the bed is deliberately light there
    mix = lpf(mix, 9000)
    peak = float(np.max(np.abs(mix))) or 1.0

    # top and tail
    e = int(1.2 * SR)
    mix[:e] *= np.linspace(0, 1, e, dtype=np.float32)
    mix[-int(2.0 * SR):] *= np.linspace(1, 0, int(2.0 * SR), dtype=np.float32)
    return (mix / peak * 0.89).astype(np.float32)


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--out", default="assets/bgm/track.wav")
    a = p.parse_args()
    y = compose()
    path = pathlib.Path(a.out)
    path.parent.mkdir(parents=True, exist_ok=True)
    sf.write(str(path), y, SR)
    print(f"{path}  {len(y) / SR:.2f}s  {SR} Hz  {path.stat().st_size // 1024}KB")
