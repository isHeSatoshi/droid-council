#!/usr/bin/env node
// channel/vmtest.mjs — does the cache-timing channel cross a VM boundary?
//
// channel.ts proves two *processes* on one machine can talk through L3 with no shared
// file and no socket. That is the easy case: they share a kernel, a page cache and a
// clock. The published attacks that this is modelled on used two VMs on one host, which
// is a much stronger claim, because everything the operating system could mediate is
// gone.
//
// So: sender on this Windows host, receiver inside a Linux container. The container gets
// --network none and a read-only bind mount of the compiled channel, so it shares no
// file, no socket and no kernel with the sender. The only things crossing the boundary
// are cache contention and a wall-clock start time agreed beforehand.
//
// The two clocks do not agree, and 100 ms slots do not forgive a large offset, so the
// offset is measured first by ping-ponging a live container over stdin: the round trip
// bounds the error, and we keep the tightest sample.
//
//   node channel/vmtest.mjs [bytes] [copies]

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { existsSync } from "node:fs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = join(HERE, "dist");
const IMAGE = process.env.VM_IMAGE ?? "node:22-alpine";
const BYTES = Number(process.argv[2] ?? 4);
const COPIES = Number(process.argv[3] ?? 2);
const LEAD = Number(process.env.VM_LEAD ?? 14000);

if (!existsSync(join(DIST, "channel.js"))) {
  console.error("compile first:  node node_modules/typescript/bin/tsc channel/channel.ts \\");
  console.error("                  --outDir channel/dist --module nodenext --moduleResolution nodenext \\");
  console.error("                  --target es2022 --skipLibCheck --types node");
  process.exit(2);
}

const docker = (args) => spawn("docker", args, { stdio: ["pipe", "pipe", "inherit"] });

/** δ = hostTime − containerTime, bracketed by a stdin round trip against a live container. */
async function measureOffset() {
  const child = docker([
    "run", "-i", "--rm", IMAGE, "node", "-e",
    "process.stdin.on('data',()=>process.stdout.write(Date.now()+'\\n'))",
  ]);
  const rl = createInterface({ input: child.stdout });
  const waiting = [];
  rl.on("line", (line) => waiting.shift()?.(line));

  const ping = () =>
    new Promise((res) => {
      waiting.push(res);
      child.stdin.write("x\n");
    });

  const samples = [];
  for (let i = 0; i < 14; i++) {
    const h0 = Date.now();
    const c = Number(await ping());
    const h1 = Date.now();
    samples.push({ lo: h0 - c, hi: h1 - c, rt: h1 - h0 });
  }
  child.kill();

  // The tightest round trip brackets δ most narrowly. The first sample carries the
  // container's boot time, so it is always the loosest and never wins.
  const best = samples.reduce((a, b) => (b.rt < a.rt ? b : a));
  return { delta: (best.lo + best.hi) / 2, spread: best.hi - best.lo, best, samples };
}

const collect = (p) =>
  new Promise((res) => {
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.on("exit", () => res(out));
  });

const payload = Buffer.from(Array.from({ length: BYTES }, (_, i) => (i * 37 + 11) & 255));
const hex = payload.toString("hex");

console.error(`measuring host/container clock offset ...`);
const { delta, spread, best, samples } = await measureOffset();
console.error(
  `offset   host − container = ${delta.toFixed(1)} ms  ` +
    `(±${(spread / 2).toFixed(1)} ms from the tightest of ${samples.length} pings, ` +
    `best round trip ${best.rt} ms)`,
);

// One frame is 8 length + payload*8 + 8 CRC bits, 4 bits per block, 2 pilots each,
// 5 slots per bit → 24 slots per block. Keep in step with channel.ts's defaults.
const one = Math.ceil((8 + BYTES * 8 + 8) / 4) * 24;
const slots = one * COPIES;
const wire = (slots * 100) / 1000;

const startHost = Date.now() + LEAD;
const startContainer = Math.round(startHost - delta);

console.error(
  `payload  ${hex}  ${BYTES} B -> ${slots} slots -> ${wire.toFixed(1)} s  (${COPIES} copies)`,
);
console.error(`grid     host ${new Date(startHost).toISOString()}  →  container ${new Date(startContainer).toISOString()}`);
console.error(`sender   this Windows host, 8 hammer processes`);
console.error(`receiver linux container, --network none, read-only bind mount, ${IMAGE}`);
console.error(``);

const rx = docker([
  "run", "--rm", "--network", "none",
  "-v", `${DIST}:/app:ro`,
  IMAGE, "node", "/app/channel.js",
  "recv", "--start", String(startContainer), "--bytes", String(BYTES),
  "--frames", String(COPIES), "--json",
]);
const rxDone = collect(rx);

const tx = spawn(
  process.execPath,
  ["--import", "tsx", join(HERE, "channel.ts"), "transmit", "--hex", hex, "--start", String(startHost), "--repeat", String(COPIES)],
  { stdio: ["ignore", "pipe", "inherit"], cwd: resolve(HERE, "..") },
);
const txDone = collect(tx);

const [rxOut] = await Promise.all([rxDone, txDone]);

let r = {};
try {
  r = JSON.parse(rxOut.trim().split("\n").pop() ?? "{}");
} catch {
  console.error(`undecodable receiver output: ${JSON.stringify(rxOut.slice(0, 300))}`);
  process.exit(1);
}

const want = hex;
const ok = r.ok === true && r.hex === want;
console.error(`sent     ${want}`);
console.error(`received ${r.hex ?? "(nothing)"}   ${ok ? `CRC ok on copy ${r.copy}/${COPIES}` : `FAILED (${r.error ?? "crc mismatch"})`}`);
if (r.separation) console.error(`separation ${r.separation}x mean, ${r.worstBlock}x worst block, over ${r.blocks} blocks`);
console.error(
  ok
    ? `\nCROSSED: a Linux container recovered ${BYTES} bytes from a Windows process through cache timing alone.`
    : `\nFAILED to cross the VM boundary on this attempt.`,
);
process.exit(ok ? 0 : 1);
