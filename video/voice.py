"""Generate the Clippy narration for the 60 s Loom-style film.

One wav per line in assets/voice/, plus voice.json with each measured duration so
the composition can be timed to the real audio. Re-run after editing a line.

    python voice.py
"""

import json
import pathlib
import sys

from tts import speak

OUT = pathlib.Path("assets/voice")

# Clippy's script. Kept as lines so one can be rewritten without touching the rest.
LINES = [
    ("l01", "Hi! It looks like you're trying to build a droid council."),
    ("l02", "I'm Clippy. Here's what happened when forty-six droids tried to do one job."),
    ("l03", "One task. A six-file Python package, each file with its own tests."),
    ("l04", "Run A, one droid. Run B, a council of forty-six."),
    ("l05", "The council splits the task into thirteen leaves, then runs a fixed worker pool over them."),
    ("l06", "No droid ever spawns a droid. The orchestrator owns every node. That's the trick."),
    ("l07", "Now watch the clock. For the first one hundred and sixty-six seconds, the council builds nothing."),
    ("l08", "It's opening sessions. The lone droid has been writing code since second six."),
    ("l09", "But look at the execute phase. Thirteen workers. Thirteen hundred and forty-nine seconds of work, inside one hundred and thirty seconds of clock."),
    ("l10", "Ten point four times the throughput."),
    ("l11", "So who wins end to end? The single droid. Two hundred and sixty-one seconds against three hundred and ninety-one."),
    ("l12", "And ten thousand credits against eighty-two thousand."),
    ("l13", "A council pays off when the work is bigger than one context window."),
    ("l14", "Below that, you're just paying for session startup."),
]

SPEAKER = "shubh_enhi_ads"
PACE = 1.08

if __name__ == "__main__":
    manifest = []
    total = 0.0
    for lid, text in LINES:
        path = OUT / f"{lid}.wav"
        secs = speak(text, path, SPEAKER, pace=PACE)
        manifest.append({"id": lid, "text": text, "file": f"assets/voice/{lid}.wav", "seconds": round(secs, 3)})
        total += secs
    (OUT / "voice.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    print(f"\n{len(LINES)} lines, {total:.1f}s of speech")
    for m in manifest:
        print(f"  {m['id']}  {m['seconds']:6.2f}s  {m['text'][:60]}")
