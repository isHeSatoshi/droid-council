#!/usr/bin/env node
/**
 * Tiny zero-dependency server for the council UI.
 *
 *   /                → ui.html
 *   /api/runs        → every run under runs/ with its report.json
 *   /api/events      → one run's events.jsonl, parsed (poll this while live)
 *   /api/board       → one run's blackboard
 *   /api/artifacts   → files a run produced
 */
import { createServer } from 'node:http';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const ROOT = resolve(process.cwd());
const RUNS = join(ROOT, 'runs');
const PORT = Number(process.env.PORT ?? 8787);
const SAFE = /^[\w.-]+$/;

const json = (res: import('node:http').ServerResponse, code: number, body: unknown): void => {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};

const read = (p: string): Promise<string> => readFile(p, 'utf8').catch(() => '');

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
  const run = url.searchParams.get('run') ?? '';
  try {
    if (url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(await read(join(ROOT, 'ui.html')));
    }

    if (url.pathname === '/api/runs') {
      const dirs = await readdir(RUNS, { withFileTypes: true }).catch(() => []);
      const out = [];
      for (const d of dirs) {
        if (!d.isDirectory()) continue;
        const evPath = join(RUNS, d.name, 'events.jsonl');
        const info = await stat(evPath).catch(() => null);
        if (!info) continue;
        const report = await read(join(RUNS, d.name, 'report.json')).then((t) => JSON.parse(t)).catch(() => null);
        out.push({ id: d.name, mtime: info.mtimeMs, bytes: info.size, report });
      }
      return json(res, 200, out.sort((a, b) => b.mtime - a.mtime));
    }

    if (url.pathname === '/api/events') {
      if (!SAFE.test(run)) return json(res, 400, { error: 'bad run' });
      const events = (await read(join(RUNS, run, 'events.jsonl')))
        .split('\n')
        .filter(Boolean)
        .map((l) => {
          try {
            return JSON.parse(l);
          } catch {
            return null;
          }
        })
        .filter(Boolean);
      return json(res, 200, events);
    }

    if (url.pathname === '/api/board') {
      if (!SAFE.test(run)) return json(res, 400, { error: 'bad run' });
      return json(res, 200, { text: await read(join(RUNS, run, 'board.md')) });
    }

    if (url.pathname === '/api/artifacts') {
      if (!SAFE.test(run)) return json(res, 400, { error: 'bad run' });
      const found = [];
      const walk = async (dir: string, prefix = ''): Promise<void> => {
        for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
          if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
          const full = join(dir, e.name);
          if (e.isDirectory()) await walk(full, `${prefix}${e.name}/`);
          else {
            const s = await stat(full).catch(() => null);
            found.push({ name: `${prefix}${e.name}`, bytes: s?.size ?? 0 });
          }
        }
      };
      await walk(join(RUNS, run));
      return json(res, 200, found);
    }

    res.writeHead(404);
    res.end('not found');
  } catch (e) {
    json(res, 500, { error: e instanceof Error ? e.message : String(e) });
  }
}).listen(PORT, () => console.log(`council UI → http://localhost:${PORT}`));
