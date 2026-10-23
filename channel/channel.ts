// channel/channel.ts — a covert channel between two isolated processes.
//
// No shared writable file. No socket. No shared memory. The receiver never reads a byte
// the sender wrote, and the sender never reads anything the receiver wrote. What the two
// processes share is the hardware underneath them.
//
//   npx tsx channel/channel.ts send --msg "A7F3"     transmit; spawns its own receiver
//   npx tsx channel/channel.ts recv --start <ms> --slots N
//   npx tsx channel/channel.ts bench --trials 8      end-to-end frame rate on this machine
//
// THE PHYSICAL LAYER, after measuring four candidates (see probe.mjs, probe2.mjs):
//
//   1   the sender streams a buffer far larger than L3, from `hogs` processes at once
//   0   the sender does nothing at all
//
// and the receiver times a dependent-load walk over a 4 MB buffer that would otherwise
// sit in the last-level cache. While the hammers run, that buffer is not there any more
// and the walk slows down. Per slot the receiver keeps one number: the mean of the lower
// half of its walk times, which discards the scheduler's right tail without throwing away
// the distribution the way a minimum does.
//
// Two candidates were measured and rejected on this machine. Raw DRAM throughput
// contention separates by 1.02x — no signal. The per-slot *minimum* latency separates by
// nothing at all (BER 0.50), because the receiver's own walking re-warms L3 faster than a
// 50 ms burst can evict it and the minimum picks out the lucky samples.
//
// THE CODING LAYER, because the baseline drifts. Over a 28 s frame the receiver's own walk
// time climbs as the hammers heat the machine, so a single preamble at the front
// calibrates the first second and nothing after it. Each block therefore carries its own
// pilots: the sender alternates slots at level 1 and level 0, and only then sends four
// data bits, five slots each. The receiver thresholds every block against its own two
// levels, so slow drift never reaches the decoder.
//
// The pilots alternate 1,0,1,0 rather than running 1,1,0,0. The receiver's cache stays
// warm for a moment after the hammers stop, so a run of 0s straight after a run of 1s
// reads high and poisons the level estimate; alternating averages that out.
//
// Because one bad block costs the whole frame, the frame can be sent as K independent
// copies and the CRC decides which one to trust.
//
// Both sides derive slot boundaries from the host wall clock plus a start time agreed
// out of band. That start time is the only thing they share.
//
// Measured on an i7-12700K (25.6 MB L3, 20 threads), Windows 11, Node 22, 8 hammers,
// 100 ms slots, rep 5: per-block level separation ~1.45x, six of eight single frames
// decoded clean, 1.11 bit/s of payload. See README for the full table.

import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";

const SELF = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(SELF), "..");

/** Re-exec this file in a new process. fork() insists on an IPC channel; spawn() does not. */
const spawnSelf = (args: string[], stdio: Stdio) =>
  spawn(process.execPath, ["--import", "tsx", SELF, ...args], { stdio, cwd: ROOT });

type Stdio = "ignore" | "inherit" | Array<"ignore" | "inherit" | "pipe">;

// ---------------------------------------------------------------- knobs

export interface ChannelOptions {
  /** one symbol occupies this many milliseconds of wall clock */
  slotMs: number;
  /** slots per data bit — the repetition that fights the noise floor */
  rep: number;
  /** data bits between two level calibrations */
  blockBits: number;
  /** slots spent on each level per block; the block carries 2x this many pilots */
  pilotSlots: number;
  /** how many processes stream the big buffer at once; more hammers, more separation */
  hogs: number;
  /** the receiver's walk buffer, in MiB. Must fit in last-level cache. */
  chaseMb: number;
  /** the sender's streaming buffer, in MiB. Must not fit in last-level cache. */
  hogMb: number;
}

export const DEFAULTS: ChannelOptions = {
  slotMs: 100,
  rep: 5,
  blockBits: 4,
  pilotSlots: 2,
  hogs: 8,
  chaseMb: 4,
  hogMb: 64,
};

export const perBlock = (o: ChannelOptions) => 2 * o.pilotSlots + o.blockBits * o.rep;

const opt = (a: Partial<ChannelOptions>): ChannelOptions => ({ ...DEFAULTS, ...a });

// ---------------------------------------------------------------- argv

const argv = process.argv.slice(2);
const str = (name: string, fallback: string): string => {
  const i = argv.indexOf("--" + name);
  if (i < 0) return fallback;
  const v = argv[i + 1];
  return v === undefined || v.startsWith("--") ? "true" : v;
};
const int = (name: string, fallback: number): number => {
  const v = str(name, "");
  return v === "" ? fallback : Number(v);
};
const bool = (name: string, fallback = false): boolean => str(name, String(fallback)) !== "false";

/** Read the knob set off the command line, so a child worker inherits the parent's choices. */
const optionsFromArgv = (): ChannelOptions =>
  opt({
    slotMs: int("slot", DEFAULTS.slotMs),
    rep: int("rep", DEFAULTS.rep),
    blockBits: int("block", DEFAULTS.blockBits),
    pilotSlots: int("pilot", DEFAULTS.pilotSlots),
    hogs: int("hogs", DEFAULTS.hogs),
    chaseMb: int("chase", DEFAULTS.chaseMb),
    hogMb: int("hog", DEFAULTS.hogMb),
  });

// ---------------------------------------------------------------- clock

const SLEEP = new Int32Array(new SharedArrayBuffer(4));

/** Busy-free wait until a wall-clock millisecond. Atomics.wait sleeps the thread properly. */
export function sleepUntil(t: number): void {
  for (let left = t - Date.now(); left > 0; left = t - Date.now()) Atomics.wait(SLEEP, 0, 0, left);
}

// ---------------------------------------------------------------- the receiver's probe

const LINE = 64;

interface Chase {
  buf: Uint8Array;
  perm: Int32Array;
  start: number;
  lines: number;
}

/**
 * One cache line per hop, in a single cycle through every line, so the walk cannot be
 * elided or prefetched into a straight line. The permutation is seeded, so both sides
 * could rebuild it, though only the receiver ever needs it.
 */
function buildChase(mb: number): Chase {
  const lines = ((mb << 20) / LINE) | 0;
  const buf = new Uint8Array(lines * LINE);
  const sh = new Int32Array(lines);
  for (let i = 0; i < lines; i++) sh[i] = i;

  let s = 987654321;
  const rnd = () => ((s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let i = lines - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    const t = sh[i];
    sh[i] = sh[j];
    sh[j] = t;
  }

  const perm = new Int32Array(lines);
  for (let i = 0; i < lines; i++) perm[sh[i]] = sh[(i + 1) % lines];
  for (let i = 0; i < lines; i++) buf[i * LINE] = i & 255;
  return { buf, perm, start: sh[0], lines };
}

let sink = 0;

/** Returns microseconds for one full lap of the cycle. */
function walk(c: Chase): number {
  const t0 = process.hrtime.bigint();
  let idx = c.start;
  let acc = 0;
  for (let i = 0; i < c.lines; i++) {
    idx = c.perm[idx];
    acc += c.buf[idx * LINE];
  }
  sink += acc;
  return Number(process.hrtime.bigint() - t0) / 1000;
}

/** One slot becomes one number. The lower-half mean drops the scheduler's tail. */
export function lowerHalfMean(a: number[]): number {
  const s = a.slice().sort((x, y) => x - y);
  const n = Math.max(1, s.length >> 1);
  let t = 0;
  for (let i = 0; i < n; i++) t += s[i];
  return t / n;
}

/**
 * Walk continuously, cut the series at wall-clock slot boundaries, and return one number
 * per slot. Blocking. This is what the receiving process spends its time doing.
 */
export function listen(startMs: number, slots: number, o: ChannelOptions): number[] {
  const c = buildChase(o.chaseMb);
  walk(c);
  walk(c);

  const out: number[] = [];
  let cur = -1;
  let acc: number[] = [];

  for (;;) {
    const now = Date.now();
    const idx = Math.floor((now - startMs) / o.slotMs);
    if (idx < 0) {
      sleepUntil(startMs);
      continue;
    }
    if (idx >= slots) break;
    if (idx !== cur) {
      if (cur >= 0 && acc.length) out.push(lowerHalfMean(acc));
      cur = idx;
      acc = [];
    }
    acc.push(walk(c));
  }
  if (cur >= 0 && acc.length) out.push(lowerHalfMean(acc));
  return out;
}

// ---------------------------------------------------------------- the sender's hammer

/**
 * Stream a buffer that does not fit in L3, for exactly the slots that carry a 1, and sit
 * still for the slots that carry a 0. Wall-clock aligned, so N of these stay in lockstep
 * without ever talking to each other.
 */
export function hammer(bits: string, startMs: number, o: ChannelOptions): void {
  const big = new Float64Array((o.hogMb << 20) / 8);
  for (let i = 0; i < big.length; i += 64) big[i] = i;
  const n = big.length;
  let s = 0;

  for (let b = 0; b < bits.length; b++) {
    const from = startMs + b * o.slotMs;
    const end = from + o.slotMs;
    sleepUntil(from);
    if (bits[b] === "1") {
      while (Date.now() < end) for (let i = 0; i < n; i += 8) s += big[i];
    } else {
      sleepUntil(end);
    }
  }
  process.exit(s === 12345 ? 1 : 0);
}

/** Run the hammers as separate processes. Separate processes are the whole point. */
export async function transmit(schedule: number[], startMs: number, o: ChannelOptions): Promise<void> {
  const bits = schedule.join("");
  const kids = [];
  for (let i = 0; i < o.hogs; i++) {
    kids.push(
      spawnSelf(
        ["hammer", "--bits", bits, "--start", String(startMs), "--slot", String(o.slotMs), "--hog", String(o.hogMb)],
        "ignore",
      ),
    );
  }
  await new Promise<void>((done) => {
    let left = kids.length;
    if (!left) return done();
    for (const k of kids) k.on("exit", () => (--left ? undefined : done()));
  });
}

// ---------------------------------------------------------------- wire format

export function crc8(bytes: Uint8Array | number[]): number {
  let c = 0;
  for (const b of bytes) {
    c ^= b;
    for (let i = 0; i < 8; i++) c = c & 0x80 ? ((c << 1) ^ 0x07) & 0xff : (c << 1) & 0xff;
  }
  return c;
}

/**
 * 8 bits of length | length*8 payload bits | 8 CRC bits, MSB first.
 * No preamble: every block carries its own pilots instead.
 */
export function frameBits(bytes: Uint8Array): number[] {
  if (bytes.length > 255) throw new Error("message must be <= 255 bytes");
  const bits: number[] = [];
  const push = (v: number) => bits.push(v & 1);
  for (let i = 7; i >= 0; i--) push(bytes.length >> i);
  for (const b of bytes) for (let i = 7; i >= 0; i--) push(b >> i);
  const c = crc8(bytes);
  for (let i = 7; i >= 0; i--) push(c >> i);
  return bits;
}

/** Expand a bit string to one entry per slot, pilots and repetition included. */
export function toSchedule(bits: number[], o: ChannelOptions): number[] {
  const sched: number[] = [];
  for (let i = 0; i < bits.length; i += o.blockBits) {
    for (let p = 0; p < 2 * o.pilotSlots; p++) sched.push(p % 2 === 0 ? 1 : 0);
    for (let k = 0; k < o.blockBits; k++) {
      const v = bits[i + k] ?? 0;
      for (let r = 0; r < o.rep; r++) sched.push(v);
    }
  }
  return sched;
}

/** K independent copies of the same frame, back to back. */
export function scheduleFor(bytes: Uint8Array, copies: number, o: ChannelOptions): number[] {
  const one = toSchedule(frameBits(bytes), o);
  const out: number[] = [];
  for (let i = 0; i < copies; i++) out.push(...one);
  return out;
}

export const frameSlots = (nbytes: number, o: ChannelOptions) =>
  Math.ceil((8 + nbytes * 8 + 8) / o.blockBits) * perBlock(o);

export interface Decoded {
  ok: boolean;
  error?: string;
  text?: string;
  /** the same payload as hex, which survives payloads that are not valid UTF-8 */
  hex?: string;
  crc?: number;
  want?: number;
  blocks?: number;
  /** mean of the per-block level separations, as a ratio */
  separation?: number;
  worstBlock?: number;
  seps?: number[];
  /** which copy carried the frame that passed its CRC */
  copy?: number;
}

/** Threshold every block against its own two levels, so drift never reaches the decoder. */
export function decode(series: number[], o: ChannelOptions): Decoded {
  const pb = perBlock(o);
  const blocks = Math.floor(series.length / pb);
  if (blocks < 2) return { ok: false, error: "too few slots" };

  const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  const bits: number[] = [];
  const seps: number[] = [];

  for (let b = 0; b < blocks; b++) {
    const base = b * pb;
    const hiSlots: number[] = [];
    const loSlots: number[] = [];
    for (let p = 0; p < 2 * o.pilotSlots; p++) (p % 2 === 0 ? hiSlots : loSlots).push(series[base + p]);
    const hi = mean(hiSlots);
    const lo = mean(loSlots);
    seps.push(hi / (lo || 1));
    const thr = (hi + lo) / 2;
    for (let k = 0; k < o.blockBits; k++) {
      const g = series.slice(base + 2 * o.pilotSlots + k * o.rep, base + 2 * o.pilotSlots + (k + 1) * o.rep);
      bits.push(g.filter((v) => v > thr).length * 2 > o.rep ? 1 : 0);
    }
  }

  const take = (n: number) => bits.slice(n, n + 8).reduce((a, b) => a * 2 + b, 0);
  const len = take(0);
  if (len === 0 || bits.length < 8 + len * 8 + 8) return { ok: false, error: "no frame", blocks };

  const bytes: number[] = [];
  for (let k = 0; k < len; k++) bytes.push(take(8 + k * 8));
  const got = take(8 + len * 8);
  const want = crc8(bytes);

  return {
    ok: got === want,
    text: Buffer.from(bytes).toString("utf8"),
    hex: Buffer.from(bytes).toString("hex"),
    crc: got,
    want,
    blocks,
    separation: +(mean(seps) || 0).toFixed(2),
    worstBlock: +Math.min(...seps).toFixed(2),
    seps: seps.map((s) => +s.toFixed(2)),
  };
}

/** Try each repeated copy in turn; return the first whose CRC passes. */
export function decodeCopies(series: number[], slots: number, copies: number, o: ChannelOptions): Decoded {
  let last: Decoded = { ok: false, error: "no copies" };
  for (let i = 0; i < copies; i++) {
    const r = decode(series.slice(i * slots, (i + 1) * slots), o);
    r.copy = i + 1;
    if (r.ok) return r;
    if (i === 0) last = r;
    if (r.error === "no frame") break;
  }
  return last;
}

// ---------------------------------------------------------------- the two public verbs

/**
 * Send bytes over the side channel. Spawns the hammers, and waits for the grid to finish.
 * The return value is the schedule, not a delivered message — nothing here confirms
 * delivery, because confirmation is exactly the shared writable state we are avoiding.
 */
export async function sendMessage(
  bytes: Uint8Array,
  opts: { copies?: number; leadMs?: number; channel?: Partial<ChannelOptions> } = {},
): Promise<{ startMs: number; slots: number; seconds: number }> {
  const o = opt(opts.channel ?? {});
  const schedule = scheduleFor(bytes, opts.copies ?? 1, o);
  const startMs = Date.now() + (opts.leadMs ?? 6000);
  await transmit(schedule, startMs, o);
  return { startMs, slots: schedule.length, seconds: (schedule.length * o.slotMs) / 1000 };
}

/** Receive one frame. Blocking; call it from the process that should do the listening. */
export function receiveMessage(
  startMs: number,
  nbytes: number,
  opts: { copies?: number; channel?: Partial<ChannelOptions>; overshoot?: number } = {},
): { series: number[]; frame: Decoded } {
  const o = opt(opts.channel ?? {});
  const copies = opts.copies ?? 1;
  const slots = frameSlots(nbytes, o) * copies;
  const series = listen(startMs, slots + (opts.overshoot ?? 4), o);
  return { series, frame: decodeCopies(series, frameSlots(nbytes, o), copies, o) };
}

// ---------------------------------------------------------------- bench

async function bench(): Promise<void> {
  const trials = int("trials", 8);
  const nbytes = int("bytes", 4);
  const copies = int("repeat", 1);
  const lead = int("lead", 6000);
  const o = optionsFromArgv();
  const one = frameSlots(nbytes, o);

  let s = 7654321;
  const rnd = () => ((s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff) / 0x7fffffff);

  let good = 0;
  const used: number[] = [];

  for (let t = 0; t < trials; t++) {
    const payload = Uint8Array.from({ length: nbytes }, () => Math.floor(rnd() * 256));
    const schedule = scheduleFor(payload, copies, o);
    const startMs = Date.now() + lead;

    let out = "";
    const child = spawnSelf(
      [
        "recv", "--start", String(startMs), "--slots", String(schedule.length + 4),
        "--bytes", String(nbytes), "--frames", String(copies), "--json",
      ],
      ["ignore", "pipe", "inherit"],
    );
    child.stdout!.on("data", (d: Buffer) => (out += d));

    await transmit(schedule, startMs, o);
    await new Promise((r) => child.on("exit", r));

    let r: Decoded;
    try {
      r = JSON.parse(out.trim().split("\n").pop() ?? "{}");
    } catch {
      process.stdout.write(`trial ${t + 1}  undecodable child output: ${JSON.stringify(out.slice(0, 160))}\n`);
      continue;
    }
    if (r.ok) {
      good++;
      used.push(r.copy ?? 1);
    }
    const sent = Array.from(payload, (b) => b.toString(16).padStart(2, "0")).join(" ");
    process.stdout.write(
      `trial ${t + 1}  sent ${sent}  ${r.ok ? `ok on copy ${r.copy}/${copies}` : `FAILED (${r.error ?? "crc"})`}  ` +
        `sep ${r.separation ?? "-"}x worst ${r.worstBlock ?? "-"}x\n`,
    );
  }

  const bits = nbytes * 8;
  const wire = (copies * one * o.slotMs) / 1000;
  process.stdout.write(
    `\n${good}/${trials} frames decoded clean.  (${((100 * good) / trials).toFixed(0)}% per frame, ${copies} copy/copies)\n` +
      `payload ${(bits / wire).toFixed(2)} bit/s  —  ${bits} payload bits inside ${wire.toFixed(1)} s.\n` +
      `the other ${(100 * (1 - bits / (copies * one))).toFixed(0)}% of the wire goes to pilots, repetition and CRC.\n` +
      (used.length ? `copies actually needed: ${used.join(", ")} of ${copies}\n` : ""),
  );
}

// ---------------------------------------------------------------- cli

async function main(): Promise<void> {
  const mode = argv[0] ?? "bench";
  const o = optionsFromArgv();

  if (mode === "hammer") {
    hammer(str("bits", ""), int("start", 0), o);
    return;
  }

  if (mode === "transmit") {
    // Sender only. Pair it with a separate `recv` process that was told the same --start
    // and nothing else — no payload, no length. That is the whole claim of this channel.
    const hex = str("hex", "");
    const bytes = Uint8Array.from(hex.match(/../g) ?? [], (h) => parseInt(h, 16));
    const copies = int("repeat", 1);
    const startMs = int("start", Date.now() + 6000);
    const schedule = scheduleFor(bytes, copies, o);
    await transmit(schedule, startMs, o);
    process.stdout.write(`transmitted ${bytes.length} B over ${schedule.length} slots\n`);
    return;
  }

  if (mode === "send") {
    const msg = str("msg", "");
    const copies = int("repeat", 1);
    const bytes = new TextEncoder().encode(msg);
    const one = frameSlots(bytes.length, o);
    const schedule = scheduleFor(bytes, copies, o);
    const startMs = Date.now() + int("lead", 6000);

    process.stdout.write(
      `message    "${msg}"  ${bytes.length} B -> ${schedule.length} slots -> ` +
        `${((schedule.length * o.slotMs) / 1000).toFixed(1)} s  (${copies} copy/copies)\n` +
        `slot grid  ${new Date(startMs).toISOString()}  slot ${o.slotMs} ms  rep ${o.rep}  ` +
        `block ${o.blockBits}  pilot ${o.pilotSlots}  hammers ${o.hogs}\n`,
    );

    let out = "";
    const child = spawnSelf(
      [
        "recv", "--start", String(startMs), "--slots", String(schedule.length + 4),
        "--bytes", String(bytes.length), "--frames", String(copies),
      ],
      ["ignore", "pipe", "inherit"],
    );
    child.stdout!.on("data", (d: Buffer) => (out += d));

    await transmit(schedule, startMs, o);
    await new Promise((r) => child.on("exit", r));
    process.stdout.write(out);
    void one;
    return;
  }

  if (mode === "recv") {
    const startMs = int("start", Date.now());
    const nbytes = int("bytes", 4);
    const copies = int("frames", 1);
    const slots = int("slots", frameSlots(nbytes, o) * copies + 4);
    const series = listen(startMs, slots, o);
    const frame = decodeCopies(series, frameSlots(nbytes, o), copies, o);

    if (bool("json", false)) {
      process.stdout.write(JSON.stringify({ ...frame, observed: series.length }) + "\n");
    } else if (frame.error) {
      process.stdout.write(`no frame: ${frame.error} after ${copies} copies (${series.length} slots)\n`);
    } else {
      process.stdout.write(
        `decoded    "${frame.text}"  ${frame.ok ? `CRC ok on copy ${frame.copy}/${copies}` : `CRC FAIL (got ${frame.crc}, want ${frame.want})`}\n` +
          `separation ${frame.separation}x mean, ${frame.worstBlock}x worst block, over ${frame.blocks} blocks\n` +
          `slots      ${series.length} (${((series.length * o.slotMs) / 1000).toFixed(1)} s)\n`,
      );
    }
    return;
  }

  await bench();
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
