# REVIEW — droid council, drafting-sheet cut

48.6 s · 1920×1080 · 30 fps · H.264 + AAC · `renders/droid-council-sheet.mp4` (7.4 MB)

## What it is

The restrained cut. No mascot, no desktop, no jokes: a cyanotype drawing sheet where
the two runs are drawn as measured tracks on one axis, then the same thirteen tasks are
compared as work done rather than wall clock. It exists to make the numbers legible to
someone who will not watch the Loom cut.

Three scenes: `replay` (wall clock, three runs), `work` (the same thirteen tasks),
`line` (the finding).

## Review set

Captured with `npx hyperframes snapshot --review -o _review`.

| file | what it shows |
|---|---|
| `_review/review-beats.jpg` | 6 settled frames — each scene at start + 0.3 s and at its middle |
| `_review/review-seam-01..02.jpg` | 5 frames across each of the two cut points |
| `_review/review-phone.jpg` | the same beats at 360 px wide |

## Read of the beats

| time | scene | reads as |
|---|---|---|
| 0.3 s | replay | title and three empty lanes; the chart has not started |
| 17.8 s | replay | three runs drawn, 261 s / 631 s / 391 s, axis labelled |
| 35.9 s | work | THE SAME THIRTEEN TASKS, rows building |
| 39.6 s | work | throughput 1.0× / 4.6× / 10.4× against real worker seconds |
| 43.9 s | line | "1349 seconds of work in 130 seconds of clock." |
| 46.1 s | line | the finding plus the invocation that produced it |

## Checks

`npx hyperframes check --json` reports every section `ok: true` with **0 errors,
0 warnings and 0 info** across lint, runtime, layout, contrast and motion.

## Music

`mkbgm2.py` writes the bed: 49 s, 52 BPM, four slow chords (Dm – Bbmaj7 – Gm – A) as
detuned sine pads, a quiet root pulse on beats 1 and 3, and one four-note motif that
returns three times. Deterministic, numpy and soundfile only, no model and no account.
Output `assets/bgm/sheet.wav`.

This is deliberately not the chiptune used in the Loom cut. The chiptune belongs to the
1997 desktop; it fights this film's drawing sheet.

## Known

- Contrast, layout, motion and runtime are all clean, so there is nothing outstanding.
  Earlier layout errors in this film were fixed by giving each bar row a single text
  element (a label plus an inline unit span, not two stacked blocks) and by moving the
  band labels into a right-hand column at x 1860.
