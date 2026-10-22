# SPEC — "The Sheet"

GOAL:    The viewer understands that the council's win is throughput, not wall clock — and can
         say why: the council pays 166 s of session init before it builds anything.
OUTPUT:  HyperFrames, 1920x1080, 30 fps
TIME:    48.6 s x 30 fps = 1458 frames. No music beat grid: the clock is the run log, at a
         declared uniform scale of x20 (1 s of video = 20 s of run time). Every bar position and
         length is `run_seconds / 20`, taken from `../runs/*/events.jsonl`. Nothing is retimed.

LOOK:    Medium: a cyanotype drafting sheet — one ink on one ground, plus a marking pencil.
         - ground: `#0A2740` flat, plus a drafting grid: 1 px `#E9F2F8` @ 4.5% every 32 px and
           @ 7.5% every 160 px. Grain 4% (fixed-seed SVG fractal noise, 200x200 tile). No vignette.
         - ink: `#E9F2F8` full for bars, structural rules and read text; `#6E93AD` for gridlines,
           row tracks and secondary rules.
         - accent: `#E8544A` (red marking pencil). Permitted only on: the three wall-clock
           numbers, their vertical rules, the three speedup ratios, and one critical-path tick.
           Never a fill on more than 8% of the frame.
         - display: Archivo Black, uppercase, tracking 0.04em. Title 34 px, band labels 28 px,
           hero number 150 px.
         - measurement: IBM Plex Mono 400. Tick labels 18 px, row notes 19 px, body 28 px,
           command line 30 px. Tabular figures everywhere a number changes.
         - geometry: hairlines 1.5 px; structural rules 3 px; bars square-cornered, no radius.
           Dimension lines use 45 deg tick terminators, never arrowheads.
         - light/depth: none. Flat print. No shadows, no blur, no glow.
         - hero: the chart spans x 300-1860 (81% of frame width) and y 104-900 (74% of height).

OBJECTS: - the sheet (ground + drafting grid)
         - the time axis: a 3 px rule at y 950, ticks every 60 s, labels every 120 s, 0 to 640 s
         - three bands, each a label block at x 64-290 and a track at x 300-1860:
             ONE DROID (1 row) / COUNCIL x 6 (13 rows) / COUNCIL x 16 (13 rows)
         - the dead zone: a 45 deg hatch, 1 px `#E9F2F8` @ 30% every 7 px, spanning the full
           band height over the run's planning span and its reduce span
         - work bars: solid `#E9F2F8`, 20 px tall, 6 px gap
         - the wall rule: 2 px `#E8544A` vertical, spanning its band, with the wall number in
           Archivo Black 44 px at its top

MOTION:  eases by role —
         - data (bar and hatch growth): `none`. Constant rate is the point; a bar's length is
           time, so an eased bar would lie. Driven from one `onUpdate` over the whole scene.
         - structure (sheet rules, axis sweep, band labels): `power3.out`, 0.45 s
         - stamps (wall numbers, ratios): `power4.out`, 0.3 s, scale 0.72 -> 1
         - camera (the push in shot 2): `power2.inOut`, 3.2 s
         - callouts: `power2.out`, 0.35 s in, 0.25 s out
         Nothing moves while it is read. Titles land and hold.

SHOTS:   1. 0.0-35.6 (1068 f) THE SHEET — one continuous take, no cut.
            local 0.0-2.2 (66 f) sheet rules sweep in, axis + ticks snap, three band labels land.
            local 2.2 = run 0. The replay: run = (local - 2.2) x 20, to run 626 at local 33.5.
            Callouts fill the dead zone: run 6 "one droid starts"; run 40 "46 sessions
            initialising"; run 130 "still nothing built"; run 165.9 "13 workers, one frame";
            run 199.8 "cap 6: six at a time". Red wall numbers stamp at run 261 / 391 / 631.
            local 33.5-35.6 hold on the finished sheet.
        2. 35.6-43.6 (240 f) THE WORK — push in to a second chart at x 1.156 px per work-second
            (1560 px = 1349 s). Three pairs, wall over work: SINGLE 222/222 (1.0x),
            x 6 228/1044 (4.6x), x 16 130/1349 (10.4x). Ratios stamp in red.
        3. 43.6-48.6 (150 f) THE LINE — three statements land in order and hold.
BANNED:  the framework defaults (dark void with small centred elements; glow, bloom, particles;
         gradients and glass; cream paper with serif and numbered 01/02 labels; three cards in a
         row; KPI grid; docked corner logo; everything fading and sliding up) plus, for this
         film: any bar whose length is not `run / 20`; any eased data growth; a legend; a
         gridline that is not a real 60 s multiple; more than one red element per band.
QA:      f 66 (sheet ruled, nothing drawn yet) - axis and three band labels, no bars
         f 250 (run 44)   - single bar running, both council bands hatched and empty
         f 560 (run 165)  - dead zone at its widest; no white in the council bands
         f 700 (run 203)  - x16 block solid, x6 shows six bars only, its staircase begun
         f 1050 (run 626) - all three red wall numbers present
         f 1180 (shot 2)  - three wall/work pairs, ratios 1.0x / 4.6x / 10.4x
         f 1450 (shot 3)  - the closing three lines, nothing else
