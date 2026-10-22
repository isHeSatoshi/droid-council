# REVIEW — droid council, Loom cut

60.0 s · 1920×1080 · 30 fps · H.264 + AAC · `renders/droid-council-loom.mp4` (15.7 MB)

## What it is

A Loom-style screen recording of one task run twice by droid council. There is no
webcam and no talking head. The presenter is Clippy, a wire paperclip who owns a
reserved bottom strip and swaps his card fourteen times, once per narration line. The
recording chrome (`REC` plus a running clock) sits top-right, where a screen recorder
leaves it. The world is a 1997 Windows desktop, because a terminal recording is what
this is.

## Review set

Captured with `npx hyperframes snapshot --review -o _review`.

| file | what it shows |
|---|---|
| `_review/review-beats.jpg` | 14 settled frames — each scene at start + 0.3 s and at its middle |
| `_review/review-seam-01..06.jpg` | 5 frames across each of the six cut points |
| `_review/review-phone.jpg` | the same beats at 360 px wide |

## Read of the beats

| time | scene | reads as |
|---|---|---|
| 0.3 s | s1 | the MS-DOS window growing out of its own title bar, terminal still blank |
| 3.96 s | s1 | `dir /b` typed, the real repo listing, cursor blinking at the real 0.53 s rate |
| 8.22 s | s2 | `task.md` open in Notepad, six modules highlighted |
| 10.47 s | s2 | the DELIVERED column, six checkmarks deep |
| 13.32 s | s3 | RUN A vs RUN B, with the real command lines |
| 17.28 s | s3 | EXPAND → EXECUTE → REDUCE, `26 + 13 + 7 = 46`, then the real signatures |
| 21.84 s | s4 | glitch cut-in to WHO OWNS THE TREE? |
| 26.47 s | s4 | the invariant plus the 0–420 s run strip |
| 31.7 s | s5 | THE EXECUTE PHASE, thirteen bars |
| 37.155 s | s5 | WALL CLOCK vs WORK DONE, then the 10.4× stamp |
| 43.21 s | s6 | END TO END, three runs |
| 48.02 s | s6 | the credit line, 10,311 / 96,094 / 82,550 |
| 53.43 s | s7 | the closing dialog, first line landing word by word |
| 56.565 s | s7 | both lines, the command, the OK button |

## Checks

`npx hyperframes check --json` reports every section `ok: true` with **0 errors,
0 warnings and 0 info** across lint, runtime, layout, contrast and motion.

## What review caught that the check did not

- **The terminal's leading was tripled.** `white-space: pre` sat on the container, so it
  preserved the newlines *between* the child divs and inflated every line to three rows.
  The layout checker only saw this as `canvas_overflow` on the last few lines; the
  frame zoom showed it plainly. `pre` now lives on `.term > div`, never on the container.
- **The presenter covered the content.** The balloon was a 500 px box at y 430 and sat
  across the s2 sidebar. Clippy and the balloon now own a reserved bottom strip — scene
  content stops at 890 px — the balloon is sized to its line, and the clip is larger.
- **A caption had escaped its container.** `#s3-total` was `top: 578` *inside*
  `#s3-pipe`, which put it at y 980, floating alone near the balloon. Now y 682, under
  the pipeline.
- **A command broke mid-word.** RUN B's line broke inside "concurrency". It now breaks
  at the flag boundary.
- **A glyph failed contrast.** The ✗ in s4 was red on teal, 1.28:1. It is now a white
  disc with a red ✗ at 6.5:1.
- **A caption slid into the presenter strip.** s4's closing caption now clears out 0.2 s
  before the push-in handoff.

## Known

- The thirteen worker bars use the real per-worker durations read out of
  `runs/team-fast/events.jsonl`, not estimates.
- Their one-frame stagger matches the real spread — all thirteen workers started within
  about 100 ms of each other.
- The `REC` clock counts the film; it reads `00:59` on the end card. A real Loom clock
  would be wall time.
