// channel/probe2.mjs — the first physical layer failed, so test the alternative properly.
//
// probe.mjs showed the signal only exists while the hog is *sustained*. In a 50 ms slot
// the receiver's own walk re-warms L3 faster than the sender evicts it, so the minimum
// walk time carries no information (measured BER 0.5).
//
// This probes a different quantity, with a sender that is never idle:
//   1  -> the sender streams a buffer far larger than L3   (memory-bound)
//   0  -> the sender spins on a buffer that lives in L1    (compute-bound, no traffic)
// and the receiver measures how much it can stream itself in the same slot.
//
//   node probe2.mjs run --stat throughput
//   node probe2.mjs run --stat walk

import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";

const SELF = fileURLToPath(import.meta.url);
const argc = process.argv.slice(2);
const mode = argc[0] ?? "run";
const flag = (n, d) => {
  const i = argc.indexOf("--" + n);
  if (i < 0) return d;
  const v = argc[i + 1];
  return v === undefined || v.startsWith("--") ? true : v;
};

const SLEEP = new Int32Array(new SharedArrayBuffer(4));
const sleepUntil = (t) => {
  for (let left = t - Date.now(); left > 0; left = t - Date.now()) Atomics.wait(SLEEP, 0, 0, left);
};

const ZERO = String(flag("zero", "idle"));

// ---------------------------------------------------------------- sender

if (mode === "send") {
  const bits = String(flag("bits", ""));
  const start = Number(flag("start"));
  const slot = Number(flag("slot", 50));
  const hogs = Number(flag("hogs", 1));

  const BIG = new Float64Array((64 << 20) / 8);
  for (let i = 0; i < BIG.length; i += 64) BIG[i] = i;
  const SMALL = new Float64Array(1024); // 8 KB, lives in L1, generates no memory traffic
  for (let i = 0; i < SMALL.length; i++) SMALL[i] = i;
  let sink = 0;

  const run = () => {
    for (let b = 0; b < bits.length; b++) {
      const from = start + b * slot;
      const end = from + slot;
      sleepUntil(from);
      if (bits[b] === "1") {
        const n = BIG.length;
        while (Date.now() < end) for (let i = 0; i < n; i += 8) sink += BIG[i];
      } else if (ZERO === "spin") {
        while (Date.now() < end) for (let r = 0; r < 2000; r++) for (let i = 0; i < 1024; i += 8) sink += SMALL[i];
      } else {
        sleepUntil(end);
      }
    }
  };

  if (hogs > 1 && !flag("child", false)) {
    // extra hogs run the same schedule off the same wall clock; they need no channel to sync
    const kids = [];
    for (let i = 1; i < hogs; i++) kids.push(fork(SELF, [...argc, "--child"], { stdio: "ignore" }));
    run();
    for (const k of kids) k.kill();
  } else {
    run();
  }
  process.exit(sink === 12345 ? 1 : 0);
}

// ---------------------------------------------------------------- receiver

const SLOT = Number(flag("slot", 50));
const N = Number(flag("bits", 64));
const STAT = String(flag("stat", "throughput"));

function pattern() {
  let s = 424242;
  const rnd = () => ((s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff) / 0x7fffffff);
  return Array.from({ length: N }, () => (rnd() < 0.5 ? "0" : "1")).join("");
}

/** A buffer that does not fit in L3, streamed sequentially. */
const T = new Float64Array((48 << 20) / 8);
for (let i = 0; i < T.length; i += 64) T[i] = i;

const LINE = 64;
const CHASE_MB = Number(flag("chase", 4));
const CHASE_LINES = (CHASE_MB << 20) / LINE;
function buildChase() {
  const buf = new Uint8Array(CHASE_LINES * LINE);
  const sh = new Int32Array(CHASE_LINES);
  for (let i = 0; i < CHASE_LINES; i++) sh[i] = i;
  let s = 987654321;
  const rnd = () => ((s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let i = CHASE_LINES - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    const t = sh[i];
    sh[i] = sh[j];
    sh[j] = t;
  }
  const perm = new Int32Array(CHASE_LINES);
  for (let i = 0; i < CHASE_LINES; i++) perm[sh[i]] = sh[(i + 1) % CHASE_LINES];
  for (let i = 0; i < CHASE_LINES; i++) buf[i * LINE] = i & 255;
  return { buf, perm, start: sh[0] };
}

let acc = 0;

/** Each slot needs one number. Which number is the whole question. */
function summarise(a) {
  const s = a.slice().sort((x, y) => x - y);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(s.length * p))];
  const half = s.slice(0, Math.max(1, s.length >> 1));
  return {
    n: s.length,
    min: s[0],
    p25: q(0.25),
    lowmean: half.reduce((x, y) => x + y, 0) / half.length,
    med: q(0.5),
    p75: q(0.75),
    mean: s.reduce((x, y) => x + y, 0) / s.length,
  };
}

function measure(start, bits) {
  const out = new Array(bits.length).fill(null);

  if (STAT === "walk") {
    const c = buildChase();
    const one = () => {
      let idx = c.start;
      const t0 = process.hrtime.bigint();
      for (let i = 0; i < CHASE_LINES; i++) {
        idx = c.perm[idx];
        acc += c.buf[idx * LINE];
      }
      return Number(process.hrtime.bigint() - t0) / 1000;
    };
    one();
    one();
    let cur = -1;
    let best = Infinity;
    let all = [];
    for (;;) {
      const idx = Math.floor((Date.now() - start) / SLOT);
      if (idx < 0) {
        sleepUntil(start);
        continue;
      }
      if (idx >= bits.length) break;
      if (idx !== cur) {
        if (cur >= 0 && all.length) out[cur] = summarise(all);
        cur = idx;
        best = Infinity;
        all = [];
      }
      const t = one();
      if (t < best) best = t;
      all.push(t);
    }
    if (cur >= 0 && all.length) out[cur] = summarise(all);
    return out;
  }

  // throughput: how many elements can the receiver stream inside one slot
  let cur = -1;
  let elems = 0;
  let from = 0;
  for (;;) {
    const now = Date.now();
    const idx = Math.floor((now - start) / SLOT);
    if (idx < 0) {
      sleepUntil(start);
      continue;
    }
    if (idx >= bits.length) break;
    if (idx !== cur) {
      if (cur >= 0) out[cur] = elems / (now - from);
      cur = idx;
      elems = 0;
      from = now;
    }
    const n = T.length;
    for (let i = 0; i < n; i += 8) acc += T[i];
    elems += n / 8;
  }
  if (cur >= 0) out[cur] = elems / (Date.now() - from);
  return out;
}

// ---------------------------------------------------------------- driver

const bits = pattern();
const start = Date.now() + 1500;
const HOGS = String(flag("hogs", 1));
const child = fork(
  SELF,
  ["send", "--bits", bits, "--start", String(start), "--slot", String(SLOT), "--hogs", HOGS, "--zero", ZERO],
  { stdio: "ignore" },
);
const out = measure(start, bits);
await new Promise((r) => child.on("exit", r));

const zeros0 = out.filter((v, i) => v !== null && bits[i] === "0");
const ones0 = out.filter((v, i) => v !== null && bits[i] === "1");

const choose = (n, k) => {
  let r = 1;
  for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i;
  return r;
};
const med = (a) => a.slice().sort((x, y) => x - y)[a.length >> 1];
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;

console.log(`stat=${STAT}  zero=${ZERO}  slot=${SLOT} ms  chase=${CHASE_MB} MB  hogs=${HOGS}  n0=${zeros0.length} n1=${ones0.length}`);
console.log(`  ${"statistic".padEnd(9)} ${"0 slots".padStart(9)} ${"1 slots".padStart(9)} ${"sep".padStart(6)} ${"BER".padStart(7)} ${"rep3".padStart(8)} ${"rep5".padStart(8)} ${"rep7".padStart(8)}`);
const best = [];
for (const key of ["min", "p25", "lowmean", "med", "p75", "mean"]) {
  const z = zeros0.map((v) => v[key]);
  const o = ones0.map((v) => v[key]);
  const m0 = mean(z);
  const m1 = mean(o);
  const thr = (m0 + m1) / 2;
  const p = (z.filter((x) => x > thr).length + o.filter((x) => x <= thr).length) / (z.length + o.length);
  const majority = (R) => {
    let s = 0;
    for (let k = (R >> 1) + 1; k <= R; k++) s += choose(R, k) * p ** k * (1 - p) ** (R - k);
    return s;
  };
  best.push([key, p]);
  console.log(
    `  ${key.padEnd(9)} ${m0.toFixed(1).padStart(9)} ${m1.toFixed(1).padStart(9)} ${(m1 / m0).toFixed(2).padStart(6)} ${p.toFixed(3).padStart(7)} ${majority(3).toFixed(4).padStart(8)} ${majority(5).toFixed(4).padStart(8)} ${majority(7).toFixed(4).padStart(8)}`,
  );
}
const usable = SLOT / 1000;
console.log(`\n  best per-slot statistic: ${best.sort((a, b) => a[1] - b[1])[0].join(" BER ")}`);
console.log(`  payload rate at rep7: ${(1 / (7 * usable)).toFixed(2)} bit/s   rep5: ${(1 / (5 * usable)).toFixed(2)} bit/s`);
console.log(`  samples per slot: ${zeros0[0].n}`);
console.log(`  (sink ${acc})`);


