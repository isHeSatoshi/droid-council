// channel/probe.mjs — first-principles check, before building anything on top.
//
// The claim to test: two processes on one host, with no shared writable file and no
// network socket, can still signal each other, because they share the last-level
// cache and the memory bus. One process hogs memory bandwidth; the other times its
// own dependent-load walk. If the separation is not there, there is no channel.
//
//   node probe.mjs run          parent measures while a child hogs
//   node probe.mjs hog <secs>   the child: saturate memory bandwidth
//
// Prints the idle and contended distributions and the ratio between them.

import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";

const SELF = fileURLToPath(import.meta.url);
const LINE = 64;
const CHASE_BYTES = 4 << 20; // fits in L3, exceeds L2 on most desktops
const HOG_BYTES = 256 << 20; // far larger than any L3

if (process.argv[2] === "hog") {
  const secs = Number(process.argv[3] ?? 8);
  const buf = new Float64Array(HOG_BYTES / 8);
  for (let i = 0; i < buf.length; i += 64) buf[i] = i;
  let acc = 0;
  const stop = Date.now() + secs * 1000;
  while (Date.now() < stop) {
    for (let i = 0; i < buf.length; i += 8) acc += buf[i];
  }
  process.exit(acc === 12345 ? 1 : 0);
}

const LINES = CHASE_BYTES / LINE;

/** A dependent-load chain over one line per hop, as a single cycle of length LINES. */
function buildChase() {
  const buf = new Uint8Array(LINES * LINE);
  const sh = new Int32Array(LINES);
  for (let i = 0; i < LINES; i++) sh[i] = i;

  let s = 987654321;
  const rnd = () => ((s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let i = LINES - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    const t = sh[i];
    sh[i] = sh[j];
    sh[j] = t;
  }

  const perm = new Int32Array(LINES);
  for (let i = 0; i < LINES; i++) perm[sh[i]] = sh[(i + 1) % LINES];
  for (let i = 0; i < LINES; i++) buf[i * LINE] = i & 255;
  return { buf, perm, start: sh[0] };
}

let sink = 0;

function sample(c) {
  const t0 = process.hrtime.bigint();
  let idx = c.start;
  let acc = 0;
  for (let i = 0; i < LINES; i++) {
    idx = c.perm[idx];
    acc += c.buf[idx * LINE];
  }
  const t1 = process.hrtime.bigint();
  sink += acc;
  return Number(t1 - t0) / 1e6;
}

const c = buildChase();
sample(c);
sample(c);
sample(c);

const WINDOW = 9000;
const TOTAL = WINDOW * 3;
const series = [];
let hog = null;
let spawned = false;
const t0 = Date.now();

while (Date.now() - t0 < TOTAL) {
  const el = Date.now() - t0;
  if (!spawned && el >= WINDOW) {
    spawned = true;
    hog = fork(SELF, ["hog", String(WINDOW / 1000)], { stdio: "ignore" });
  }
  series.push({ t: el, ms: sample(c) });
}
if (hog) hog.kill();

const q = (a, p) => a[Math.min(a.length - 1, Math.floor(a.length * p))];
function stats(label, rows) {
  const v = rows.map((r) => r.ms).sort((x, y) => x - y);
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  return {
    label,
    n: v.length,
    mean: +mean.toFixed(3),
    p10: +q(v, 0.1).toFixed(3),
    p50: +q(v, 0.5).toFixed(3),
    p90: +q(v, 0.9).toFixed(3),
    min: +v[0].toFixed(3),
    max: +v[v.length - 1].toFixed(3),
  };
}

const idle1 = series.filter((r) => r.t < WINDOW);
const load = series.filter((r) => r.t >= WINDOW + 600 && r.t < WINDOW * 2);
const idle2 = series.filter((r) => r.t >= WINDOW * 2 + 600);

const a = stats("idle (before)", idle1);
const b = stats("hog running", load);
const d = stats("idle (after)", idle2);

console.log(`chase ${CHASE_BYTES / 1048576} MB, random dependent walk of ${LINES} hops`);
console.log(`hog   ${HOG_BYTES / 1048576} MB, streaming reads in a separate process\n`);
for (const s of [a, b, d]) {
  console.log(
    `${s.label.padEnd(14)} n=${String(s.n).padStart(4)}  mean ${String(s.mean).padStart(8)}  ` +
      `p10 ${String(s.p10).padStart(7)}  p50 ${String(s.p50).padStart(7)}  p90 ${String(s.p90).padStart(8)}`,
  );
}
const sep = b.p50 / ((a.p50 + d.p50) / 2);
console.log(`\nmedian ratio contended/idle: ${sep.toFixed(2)}x   (sink ${sink})`);
console.log(sep < 1.2 ? "VERDICT: no usable signal at this sizing." : "VERDICT: signal present.");
