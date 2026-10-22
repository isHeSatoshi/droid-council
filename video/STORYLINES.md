# Three storylines

The brief: show a single Droid against a 40-plus-agent council on the same task, and compare
speed and teamwork. The data is real and already measured — three runs of one task (a six-module
Python `textstat` package, each module with its own pytest file) in `../runs/`.

The honest shape of that data, before any pictures: the lone droid finished the whole job in
**261 s**. The council at concurrency 16 took **391 s**, and at concurrency 6 it took **631 s**.
The council's *execute* phase was far faster (13 workers, 1349 s of work inside 130 s of clock)
but its *planning* phase ate 166 s before a single line was written. So the film cannot be a
victory lap. It is a measurement.

---

## 1. THE SHEET — a drafting sheet, one continuous take (recommended)

**Device:** the object is the explanation. The film is a scheduling chart, and the chart's own
geometry is the argument — nothing else is on screen.
**Form:** one continuous take. The camera never cuts; the sheet is ruled, the replay runs, then
the camera pushes into one band.

A cyanotype drafting sheet: prussian-blue ground, white hairline rules, dimension lines with
engineering tick terminators. One red marking pencil for the numbers that matter. Three bands
stacked on one shared time axis — ONE DROID, COUNCIL × 6, COUNCIL × 16 — every bar drawn from
the real `events.jsonl`, every bar growing in real time at a single declared scale of ×20. The
viewer watches the two council bands sit in a hatched dead zone for eight and ten seconds while
the lone droid's bar has already been running for six. The picture is the finding: the councils
did not lose on the work, they lost before it. Then the camera pushes into the execute band and
re-measures the same thirteen bars as *work* instead of *wall clock*: 1349 s inside 130 s.

- **First two seconds:** frame 0 is already a ruled sheet. The time axis sweeps left to right and
  the tick marks snap down onto it. No logo, no black, no fade from nothing.
- **Beats:** sheet ruled → three bands named → replay at ×20 → the dead zone (hatched planning)
  named as the cost → 261 / 391 / 631 stamped in red as each run's clock stops → push into the
  execute band → 1349 s of work against 130 s of clock → the honest line.
- **Look:** cyanotype. Ground `#0A2740`, ink `#E9F2F8`, rules `#6E93AD`, accent `#E8544A`
  (red marking pencil). Display Archivo Black; all measurement text IBM Plex Mono.
- **Sound:** drafting pencil scratches as bars draw, a stamp thud on each red number, a low
  room tone; sparse percussive bed, no melody.

**Why this one:** the chart is the finding, so the viewer cannot be told the wrong thing by a
picture that outran the data. It survives being paused at any frame (a data beat's job), it needs
no characters I would have to invent, and the ×20 scale means the film's own length is the
measurement rather than a claim about it.

---

## 2. THIRTEEN DESKS — an office floor, cut on the beat

**Device:** life before and after. One desk with a stack of six folders; then thirteen desks.
**Form:** cut on the beat — hard cuts between the two states, each cut a step in the process.

**First two seconds:** a hand drops six folders onto one desk, and the desk lamp is the only light.
**Beats:** one desk → thirteen desks appear → everyone waits for the manager to finish reading the
brief → the brief lands and thirteen hands move at once → the folders come back and are stacked
into one.
**Look:** warm office, manila folders, sticky notes, a paper-flat overhead camera; the old side
churns while the new side moves calmly.
**Sound:** office ambience, chair scrapes, a keyboard swell on the reveal.

**Why not:** it has to invent people and a workplace the source never showed, and it hides every
number — 261, 391, 1349, 130 — behind a metaphor. The one thing this comparison needs is the
numbers.

---

## 3. FORTY-SIX — one number lands, endless zoom

**Device:** a number lands, then is made physical: 46 droids, each one a bar that cannot start
until its own session is up.
**Form:** an endless zoom — the camera dives into a detail that turns out to be the next world.

**First two seconds:** the numeral 46 assembles out of 46 ticking cursor blocks.
**Beats:** 46 blocks → each costs 40-60 s before it can think → the blocks stack into a wall →
the zoom pulls back and the 130 s of actual building is a sliver beside it → 10.4×.
**Look:** two-colour, pure type and grid, no chart furniture at all.
**Sound:** a rising tick bed, one thud as the wall completes.

**Why not:** it is the second act of storyline 1 stretched to a whole film, and it opens on the
device with no situation around it — which is a diagram, not an explainer.

---

**Picked: 1, THE SHEET.** The user asked for the comparison and left the rest to me.
