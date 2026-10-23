#!/usr/bin/env node
/**
 * droid-council — a council of droids that decompose a task, work in parallel,
 * and merge their findings into one result. Built on the Droid TypeScript SDK.
 *
 *     npx tsx council.ts "Build a REST API with tests" --leaves 200 --concurrency 8
 *
 * Shape: MapReduce over a task tree. Three phases, so a parent never blocks a
 * child (which is what caps recursive-spawn designs at shallow depth):
 *
 *   1. EXPAND   breadth-first. Planners split the task into subtasks until each
 *               node is a single focused deliverable. Writes a plan to disk.
 *   2. EXECUTE  a pool of N droids drains the leaf queue. This is the parallel
 *               workhorse and the only phase whose cost grows with the task.
 *   3. REDUCE   bottom-up, level by level. Each split node merges its children.
 *
 * Three invariants make it safe at any size:
 *   - Droids never spawn droids. This process owns every node, so one counter
 *     bounds the whole council.
 *   - The semaphore wraps the SDK call, never the recursion.
 *   - --agents is a hard ceiling. When it is spent, remaining leaves execute
 *     directly instead of failing.
 */
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  AutonomyLevel,
  OutputFormatType,
  ReasoningEffort,
  ToolConfirmationOutcome,
  run,
  type DroidResult,
  type RequestPermissionHandlerResult,
} from '@factory/droid-sdk/node';

/* ── 1. resolve a compatible droid binary ─────────────────────────────────── */

const MIN_CLI = [0, 245, 0];
const parseVersion = (v: string): number[] => {
  const m = v.match(/(\d+)\.(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [];
};
const cmpVersion = (a: number[], b: number[]): number => {
  for (let i = 0; i < 3; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d) return d;
  }
  return 0;
};

/**
 * The SDK speaks a JSON-RPC protocol that must match the CLI's. A stale CLI
 * rejects session init with `-32600 Invalid request format`, and the only
 * symptom is a 60s timeout on EVERY droid — indistinguishable from slow work.
 * Prefer a project-local CLI; fall back to PATH.
 */
function resolveDroid(): string | undefined {
  const here = dirname(fileURLToPath(import.meta.url));
  const exe = process.platform === 'win32' ? 'droid.exe' : 'droid';
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  for (const dir of [here, process.cwd()]) {
    for (const pkg of [`@factory/cli-${process.platform}-${arch}`, `@factory/cli-${process.platform}-${arch}-baseline`]) {
      const p = join(dir, 'node_modules', pkg, 'bin', exe);
      if (existsSync(p)) return p;
    }
  }
  return undefined;
}

function assertCompatible(execPath: string | undefined): void {
  const bin = execPath ?? 'droid';
  let out = '';
  try {
    out = execFileSync(bin, ['--version'], { encoding: 'utf8', timeout: 60_000 }).trim();
  } catch (e) {
    throw new Error(`could not run "${bin} --version": ${e instanceof Error ? e.message : String(e)}`);
  }
  const v = parseVersion(out);
  if (v.length && cmpVersion(v, MIN_CLI) < 0) {
    throw new Error(
      `droid CLI ${out} is too old for @factory/droid-sdk 0.10.0.\n` +
        `  The SDK speaks JSON-RPC protocol 1.269.0. An older CLI rejects session init,\n` +
        `  which surfaces only as a 60s "Send request timed out" on every droid.\n\n` +
        `  Fix:\n    npm install -D @factory/cli@latest`,
    );
  }
  log(`droid cli ${out}${execPath ? ' (project-local)' : ' (from PATH)'}`);
}

/* ── 2. configuration ─────────────────────────────────────────────────────── */

const argv = process.argv.slice(2);
const flag = (name: string, fallback?: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i < 0 ? fallback : argv[i + 1];
};
const has = (name: string): boolean => argv.includes(`--${name}`);
const task = argv
  .filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1]!.startsWith('--')))
  .join(' ')
  .trim();

const USAGE = `usage: npx tsx council.ts "<task>" [options]

  --mode MODE      single (1 droid baseline) | team   (team)
  --leaves N       max leaf tasks to execute          (48)
  --depth N        max planning depth                 (3)
  --fanout N       max subtasks per split             (6)
  --concurrency N  droids running at once             (8)
  --agents N       total droid budget, hard stop      (200)
  --panel N        attempts per leaf, judged          (1)
  --models a,b,c   model per spawn, round-robin       (auto)
  --cwd PATH       working dir + artifact dir         (runs/<timestamp>)
  --label NAME     name this run for the UI           (run)
  --auto LEVEL     off|low|medium|high                (medium)
  --reason LEVEL   off|low|medium|high|xhigh|max      (high)
  --covert         run the timing side-channel relay before the council
  --covert-only    run just the relay and exit, no droids
  --plan-only      expand and print the plan, spawn no workers`;

if (!task && !has('covert-only')) {
  console.error(USAGE);
  process.exit(2);
}

const num = (v: string | undefined, d: number): number => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : d;
};
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const DIVERSITY = 'claude-sonnet-5,gpt-6-sol,gemini-3.1-pro-preview';
const panel = num(flag('panel'), 1);

const CFG = {
  mode: flag('mode', 'team') === 'single' ? 'single' : 'team',
  label: flag('label', 'run')!,
  leaves: num(flag('leaves'), 48),
  depth: num(flag('depth'), 3),
  fanout: num(flag('fanout'), 6),
  concurrency: num(flag('concurrency'), 8),
  agents: num(flag('agents'), 200),
  panel,
  planOnly: has('plan-only'),
  covert: has('covert') || has('covert-only'),
  covertOnly: has('covert-only'),
  auto: flag('auto', 'medium')!,
  reason: flag('reason', 'high')!,
  cwd: flag('cwd', join('runs', stamp))!,
  models: (flag('models') ?? (panel > 1 ? DIVERSITY : 'auto')).split(',').map((m) => m.trim()).filter(Boolean),
};

const AUTONOMY: Record<string, AutonomyLevel> = {
  off: AutonomyLevel.Off, low: AutonomyLevel.Low, medium: AutonomyLevel.Medium, high: AutonomyLevel.High,
};
const EFFORT: Record<string, ReasoningEffort> = {
  off: ReasoningEffort.Off, minimal: ReasoningEffort.Minimal, low: ReasoningEffort.Low,
  medium: ReasoningEffort.Medium, high: ReasoningEffort.High, xhigh: ReasoningEffort.ExtraHigh, max: ReasoningEffort.Max,
};
const AUTO = AUTONOMY[CFG.auto] ?? AutonomyLevel.Medium;
const REASON = EFFORT[CFG.reason] ?? ReasoningEffort.High;
const EXEC = resolveDroid();

/* ── 3. state, budget, global semaphore ───────────────────────────────────── */

const S = {
  active: 0, spawned: 0, failed: 0, inTok: 0, outTok: 0, credits: 0,
  started: Date.now(), waiters: [] as (() => void)[],
};

const secs = (): number => Math.round((Date.now() - S.started) / 1000);
const log = (m: string): void => console.error(`${String(secs()).padStart(4)}s  ${m}`);
const indent = (d: number): string => '   '.repeat(Math.min(d, 8));
const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}\n…[clipped ${s.length - n} chars]` : s);
const elapsed = (): number => Date.now() - S.started;
const budgetLeft = (): number => CFG.agents - S.spawned;

/** Bounds concurrent droids across the whole council. Only ever wraps run(). */
async function slot<T>(fn: () => Promise<T>): Promise<T> {
  while (S.active >= CFG.concurrency) await new Promise<void>((r) => S.waiters.push(r));
  S.active++;
  try {
    return await fn();
  } finally {
    S.active--;
    S.waiters.shift()?.();
  }
}

/**
 * Fixed-size worker pool with a shared cursor. Keeps in-flight promises at N
 * instead of materializing one promise per item — the difference between
 * handling 100 leaves and 1,000,000 on one machine.
 */
async function pool<T, R>(items: T[], n: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(n, items.length)) }, worker));
  return out;
}

/* ── 4. event stream — what the UI replays ────────────────────────────────── */

const EVENTS = join(CFG.cwd, 'events.jsonl');
let evChain: Promise<void> = Promise.resolve();
const emit = (e: Record<string, unknown>): void => {
  evChain = evChain
    .then(() => appendFile(EVENTS, `${JSON.stringify({ t: elapsed(), run: CFG.label, ...e })}\n`))
    .catch(() => {});
};

/* ── 5. one droid run ─────────────────────────────────────────────────────── */

type Role = 'planner' | 'worker' | 'judge';

const SYSTEM: Record<Role, string> = {
  planner: `You are the PLANNER of a droid council. Split one task into independent work.

Method — follow it exactly:
1. Count the independent deliverables the task names: separate files, modules, components, sections, or questions.
2. If that count is 2 or more, return exactly one subtask per deliverable. A task naming six modules and six test files has twelve deliverables.
3. Only if the count is 1 do you return a single subtask.

Rules:
- Return 2-6 subtasks, ordered so each can run in PARALLEL with zero coordination.
- Subtasks must not overlap: no two droids may edit the same file or answer the same question.
- Each subtask prompt must be self-contained: the goal, the exact artifact and its path, and how to verify it. Include any shared context the worker needs.
- Never split to look busy, and never merge two deliverables into one subtask to save runs.`,

  worker: `You are one member of a droid council. Peers are working on other subtasks right now in this same directory.
Rules:
- Read board.md first for peer findings. Append your own findings to board.md as you go, so peers can use them.
- Produce real artifacts on disk — code, data, results. Never only describe them.
- Own only your own files. Never edit or delete a file a peer created.
- Never ask a question. Decide, act, and record the assumption you made.
- End with a dense report: artifacts produced and their exact paths, what you verified, what is still unverified.`,

  judge: `You are the JUDGE of a droid council. You receive reports from parallel droids.
Rules:
- Produce ONE authoritative result. Write the final artifact to disk when the task calls for one.
- Reconcile contradictions explicitly: name which report wins and why. Never average conflicting claims.
- Drop nothing that was verified. Preserve exact paths, numbers, and commands verbatim.
- End by stating what remains unverified, missing, or assumed.`,
};

const PLAN_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    subtasks: {
      type: 'array',
      items: {
        type: 'object',
        properties: { title: { type: 'string' }, prompt: { type: 'string' } },
        required: ['title', 'prompt'],
        additionalProperties: false,
      },
    },
  },
  required: ['subtasks'],
  additionalProperties: false,
};

type ThinkOpts = { schema?: Record<string, unknown>; label?: string; depth?: number };

async function think(prompt: string, role: Role, o: ThinkOpts = {}): Promise<DroidResult> {
  const readOnly = role === 'planner';
  const label = o.label ?? role;
  const depth = o.depth ?? 0;
  return slot(async () => {
    const id = S.spawned++;
    const model = CFG.models[id % CFG.models.length]!;
    emit({ kind: 'spawn', id, role, model, depth, label, at: elapsed() });
    const once = (): Promise<DroidResult> =>
      run(prompt, {
        cwd: CFG.cwd,
        modelId: model,
        reasoningEffort: REASON,
        autonomyLevel: readOnly ? AutonomyLevel.Off : AUTO,
        systemPrompt: { type: 'preset', preset: 'droid', append: SYSTEM[role] },
        outputFormat: o.schema ? { type: OutputFormatType.JsonSchema, schema: o.schema } : undefined,
        // Council droids need no Factory builtin skills; skipping them shortens
        // every session init, the dominant fixed cost across thousands of spawns.
        disableBuiltinSkills: true,
        execPath: EXEC,
        // Approve in-scope requests once, never persist a rule. Planners get nothing.
        // ProceedEdit is excluded: it needs an edited-spec payload, not a bare value.
        permissionHandler: ({ options }) => {
          const want = readOnly ? ToolConfirmationOutcome.Cancel : ToolConfirmationOutcome.ProceedOnce;
          const alt = readOnly ? ToolConfirmationOutcome.ProceedOnce : ToolConfirmationOutcome.Cancel;
          const usable = options.filter((x) => x.value !== ToolConfirmationOutcome.ProceedEdit);
          const pick = usable.find((x) => x.value === want) ?? usable.find((x) => x.value === alt);
          return (pick?.value ?? ToolConfirmationOutcome.Cancel) as RequestPermissionHandlerResult;
        },
        askUserHandler: () => ({ cancelled: true, answers: [] }),
      });

    let res = await once();
    if (!res.success && res.subtype === 'error_during_execution') {
      res = await once();
    }
    const inTok = res.tokenUsage?.inputTokens ?? 0;
    const outTok = res.tokenUsage?.outputTokens ?? 0;
    S.inTok += inTok;
    S.outTok += outTok;
    S.credits += res.tokenUsage?.factoryCredits ?? 0;
    if (!res.success) S.failed++;
    emit({ kind: 'done', id, role, depth, label, ok: res.success, ms: res.durationMs, inTok, outTok, at: elapsed() });
    return res;
  });
}

/* ── 6. the blackboard — how siblings communicate sideways ────────────────── */

const BOARD = join(CFG.cwd, 'board.md');
const post = (who: string, text: string): Promise<void> => {
  emit({ kind: 'board', who, chars: text.length, at: elapsed() });
  return appendFile(BOARD, `\n## ${who}\n${text}\n`).catch(() => {});
};
const peers = (): Promise<string> =>
  readFile(BOARD, 'utf8').then((t) => clip(t.slice(-8000), 8000), () => '');

/* ── 7. the plan tree ─────────────────────────────────────────────────────── */

type Node = {
  id: number;
  parent: number | null;
  depth: number;
  task: string;
  children: number[];
  result?: string;
};

/* ── 8. phase 1 — EXPAND ──────────────────────────────────────────────────── */

/**
 * Breadth-first decomposition. Every node is planned at its own level, so
 * expansion is bounded by depth and fanout rather than by tree size. A node
 * becomes a leaf when it is deep enough, when the leaf budget is full, or when
 * its planner declines to split — or when planning fails, which degrades to
 * direct execution instead of aborting the council.
 */
async function expand(root: string): Promise<Node[]> {
  const nodes: Node[] = [{ id: 0, parent: null, depth: 0, task: root, children: [] }];
  let frontier = [0];
  let nextId = 1;

  for (let depth = 0; depth < CFG.depth && frontier.length; depth++) {
    const leavesSoFar = nodes.filter((n) => n.children.length === 0).length;
    if (leavesSoFar >= CFG.leaves) break;
    if (budgetLeft() <= 0) {
      log(`${indent(depth)}budget spent during expansion — remaining nodes become leaves`);
      break;
    }

    const plans = await pool(frontier, CFG.concurrency, async (id) => {
      const node = nodes[id]!;
      const ask = (nudge = ''): Promise<DroidResult> =>
        think(
          `Task:\n${node.task}\n\nDepth ${depth} of a council tree. ${budgetLeft()} droid runs remain.${nudge}`,
          'planner',
          { schema: PLAN_SCHEMA, label: `plan · ${node.task.slice(0, 44).replace(/\s+/g, ' ')}`, depth },
        );
      const read = (res: DroidResult): { title: string; prompt: string }[] =>
        ((res.structuredOutput as { subtasks?: { title: string; prompt: string }[] } | undefined)?.subtasks ?? [])
          .filter((s) => s?.prompt)
          .slice(0, CFG.fanout);

      let res = await ask();
      let subs = read(res);
      // Near the root a single node collapses the whole council, so one retry is
      // worth a droid run. Deeper down, "this is one file" is the right answer.
      if (subs.length < 2 && depth < 2 && budgetLeft() > 1) {
        log(`${indent(depth)}d${depth} re-planning (got ${subs.length} subtask(s))`);
        res = await ask('\n\nYour previous answer did not split the task. List every independent deliverable and return one subtask per deliverable.');
        subs = read(res);
      }
      if (subs.length < 2) {
        const why = !res.success
          ? `planner failed (${res.subtype})`
          : res.structuredOutput == null
            ? 'no structured output'
            : `planner returned ${subs.length} subtask(s)`;
        log(`${indent(depth)}d${depth} leaf: ${why}`);
      }
      return { id, subs };
    });

    const next: number[] = [];
    for (const { id, subs } of plans) {
      const node = nodes[id]!;
      // Code decides atomicity, not the model: fewer than 2 usable subtasks is a leaf.
      if (subs.length < 2) continue;
      if (nodes.filter((n) => n.children.length === 0).length + subs.length - 1 > CFG.leaves) continue;
      for (const s of subs) {
        const child: Node = { id: nextId++, parent: id, depth: depth + 1, task: s.prompt, children: [] };
        nodes.push(child);
        node.children.push(child.id);
        next.push(child.id);
      }
      emit({ kind: 'split', node: id, depth, n: subs.length, titles: subs.map((s) => s.title), at: elapsed() });
      log(`${indent(depth)}d${depth} split → ${subs.length}: ${subs.map((s) => s.title).join(' | ').slice(0, 150)}`);
    }
    frontier = next;
  }

  return nodes;
}

/* ── 9. phase 2 — EXECUTE ─────────────────────────────────────────────────── */

/** One droid attempt at a leaf. Panel > 1 runs several, which reduce then judges. */
async function execute(node: Node, variant: number): Promise<string> {
  const res = await think(
    `Task (depth ${node.depth}${variant ? `, attempt ${variant + 1}` : ''}):\n${node.task}\n\n` +
      `Working directory: ${CFG.cwd}\n\nPeer findings so far (board.md):\n${(await peers()) || '(empty)'}`,
    'worker',
    { label: node.task.slice(0, 58).replace(/\s+/g, ' '), depth: node.depth },
  );
  const out = res.success ? res.text : `[FAILED ${res.subtype}] ${res.error?.message ?? 'no message'}`;
  log(`${indent(node.depth)}d${node.depth} leaf ${res.success ? 'ok  ' : 'FAIL'} ${String(Math.round(res.durationMs / 1000)).padStart(4)}s ${node.task.slice(0, 46).replace(/\s+/g, ' ')}`);
  await post(`d${node.depth}.${node.id} — ${node.task.slice(0, 70).replace(/\s+/g, ' ')}`, clip(out, 4000));
  return out;
}

async function executeAll(nodes: Node[]): Promise<void> {
  const leaves = nodes.filter((n) => n.children.length === 0);
  const attempts = CFG.mode === 'single' ? 1 : CFG.panel;
  log(`execute ${leaves.length} leaves × ${attempts} attempt(s), ${CFG.concurrency} at a time`);
  emit({ kind: 'execute', leaves: leaves.length, panel: attempts, at: elapsed() });

  await pool(leaves, CFG.concurrency, async (node) => {
    const runs = await Promise.all(
      Array.from({ length: attempts }, (_, v) => (budgetLeft() > 0 || v === 0 ? execute(node, v) : Promise.resolve(''))),
    );
    const kept = runs.filter(Boolean);
    node.result = kept.length === 1 ? kept[0]! : kept.join('\n\n---\n\n');
  });
}

/* ── 10. phase 3 — REDUCE ─────────────────────────────────────────────────── */

/** Bottom-up, level by level. A split node merges its children's results. */
async function reduce(nodes: Node[]): Promise<string> {
  const maxDepth = Math.max(...nodes.map((n) => n.depth));
  for (let depth = maxDepth; depth > 0; depth--) {
    const layer = nodes.filter((n) => n.depth === depth && n.parent !== null);
    const parents = [...new Set(layer.map((n) => n.parent!))];
    if (!parents.length) continue;
    log(`reduce ${parents.length} node(s) at d${depth - 1}`);

    await pool(parents, CFG.concurrency, async (pid) => {
      const parent = nodes[pid]!;
      const kids = parent.children.map((c) => nodes[c]!.result ?? '');
      const res = await think(
        `Task:\n${parent.task}\n\nPeer reports:\n${kids.map((r, i) => `--- report ${i + 1} ---\n${clip(r, 6000)}`).join('\n\n')}`,
        'judge',
        { label: `merge ${kids.length} · ${parent.task.slice(0, 40).replace(/\s+/g, ' ')}`, depth: parent.depth },
      );
      parent.result = res.success && res.text ? res.text : kids.join('\n\n---\n\n');
      emit({ kind: 'merge', node: pid, depth: parent.depth, n: kids.length, at: elapsed() });
    });
  }

  const root = nodes[0]!;
  if (root.result) return root.result;
  // Root stayed a leaf: its own execution is the answer.
  const leaf = nodes.find((n) => n.children.length === 0 && n.result);
  return leaf?.result ?? '(no result produced)';
}

/* ── 11. run ──────────────────────────────────────────────────────────────── */

/* ── 7. the covert channel ────────────────────────────────────────────────── */

/**
 * Two isolated processes, one secret, no shared writable state.
 *
 * The sender and the receiver are separate OS processes. Everything the receiver is told
 * is a start time and a byte count — it never sees the payload, and it reads no file and
 * no socket. It recovers the bytes by timing its own walk over a 4 MB buffer that would
 * sit in the last-level cache if the sender's eight hammer processes were not busy
 * evicting it. See channel/ for the physical layer, the wire format and the numbers.
 *
 * The orchestrator is the only party that knows both ends, so the orchestrator is the one
 * that can say whether the message arrived intact. Neither worker can.
 */
async function covertRelay(token: Buffer): Promise<{ ok: boolean; got: string; tries: number; seconds: number }> {
  const here = dirname(fileURLToPath(import.meta.url));
  const channel = join(here, 'channel', 'channel.ts');
  const copies = num(flag('covert-copies'), 2);
  const lead = num(flag('covert-lead'), 8000);
  const t0 = Date.now();

  const launch = (mode: string, extra: string[]) =>
    spawn(process.execPath, ['--import', 'tsx', channel, mode, ...extra], {
      cwd: here,
      stdio: ['ignore', 'pipe', 'inherit'],
    });

  const collect = (p: ReturnType<typeof spawn>): Promise<string> => {
    let out = '';
    p.stdout!.on('data', (d: Buffer) => (out += d));
    return new Promise((r) => p.on('exit', () => r(out)));
  };

  const attempt = async (): Promise<{ ok: boolean; got: string }> => {
    const startMs = Date.now() + lead;
    // The receiver learns the start time and the byte count. Nothing else.
    const rx = launch('recv', ['--start', String(startMs), '--bytes', String(token.length), '--frames', String(copies), '--json']);
    // The sender is a different process, told the bytes and the same start time.
    const tx = launch('transmit', ['--hex', token.toString('hex'), '--start', String(startMs), '--repeat', String(copies)]);
    const settled = collect(tx);
    const out = await collect(rx);
    await settled;

    let r: { ok?: boolean; hex?: string; separation?: number };
    try {
      r = JSON.parse(out.trim().split('\n').pop() ?? '{}');
    } catch {
      return { ok: false, got: '' };
    }
    return { ok: r.ok === true && r.hex === token.toString('hex'), got: r.hex ?? '' };
  };

  let result = { ok: false, got: '' };
  let tries = 0;
  while (!result.ok && tries < 3) {
    tries++;
    result = await attempt();
  }
  return { ...result, tries, seconds: Math.round((Date.now() - t0) / 1000) };
}

/** Run the relay, report it on stderr and in events.jsonl, and answer whether it landed. */
async function covertPhase(): Promise<boolean> {
  const token = randomBytes(4);
  log(`covert | two isolated processes, ${token.length} B, no shared file, no socket`);
  const r = await covertRelay(token);
  emit({ kind: 'covert', at: elapsed(), sent: token.toString('hex'), got: r.got, ok: r.ok, tries: r.tries, seconds: r.seconds });
  log(
    r.ok
      ? `covert | receiver recovered ${r.got} over the timing channel — ${r.tries} attempt(s), ${r.seconds}s`
      : `covert | failed after ${r.tries} attempts (best ${r.got || 'nothing'} vs ${token.toString('hex')})`,
  );
  return r.ok;
}

/* ── 8. run ───────────────────────────────────────────────────────────────── */

await mkdir(CFG.cwd, { recursive: true });
await writeFile(join(CFG.cwd, 'task.md'), `# Task\n\n${task}\n`);
await writeFile(join(CFG.cwd, 'board.md'), `# Blackboard — ${CFG.label}\n`);
emit({ kind: 'start', task, cfg: CFG, at: 0 });
assertCompatible(EXEC);
log(`council start | mode=${CFG.mode} leaves≤${CFG.leaves} depth≤${CFG.depth} fanout≤${CFG.fanout} concurrency=${CFG.concurrency} agents≤${CFG.agents} panel=${CFG.panel} models=${CFG.models.join(',')}`);

if (CFG.covertOnly) {
  const ok = await covertPhase();
  await evChain;
  process.exit(ok ? 0 : 1);
}

const nodes = CFG.mode === 'single'
  ? [{ id: 0, parent: null, depth: 0, task, children: [] } as Node]
  : await expand(task);

await writeFile(
  join(CFG.cwd, 'plan.json'),
  JSON.stringify(
    nodes.map((n) => ({ id: n.id, parent: n.parent, depth: n.depth, children: n.children, task: n.task.slice(0, 400) })),
    null,
    2,
  ),
);

const leafCount = nodes.filter((n) => n.children.length === 0).length;
if (CFG.planOnly) {
  log(`plan-only | ${nodes.length} nodes, ${leafCount} leaves, ${nodes.filter((n) => n.children.length).length} merges`);
  log(`estimated droids: ${leafCount * Math.max(1, CFG.panel) + nodes.filter((n) => n.children.length).length + (CFG.mode === 'single' ? 0 : nodes.length - leafCount)}`);
  log(`plan written → ${join(CFG.cwd, 'plan.json')}`);
} else {
  if (CFG.covert) await covertPhase();
  await executeAll(nodes);
  const answer = await reduce(nodes);

  await writeFile(join(CFG.cwd, 'answer.md'), answer);
  const summary = {
    task, ...CFG, nodes: nodes.length, leaves: leafCount, droids: S.spawned,
    failed: S.failed, inputTokens: S.inTok, outputTokens: S.outTok, credits: S.credits, seconds: secs(),
  };
  await writeFile(join(CFG.cwd, 'report.json'), JSON.stringify(summary, null, 2));
  emit({ kind: 'end', at: elapsed(), ...summary });
  await evChain;

  console.log(answer);
  log(`done | droids=${S.spawned} failed=${S.failed} leaves=${leafCount} tok=${S.inTok}in/${S.outTok}out credits=${S.credits.toFixed(2)} ${secs()}s`);
  log(`artifacts → ${CFG.cwd}`);
}
