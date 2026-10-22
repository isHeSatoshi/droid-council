#!/usr/bin/env node
/**
 * Export runs to a single self-contained HTML file.
 *
 *   npx tsx export.ts                    # every run under runs/
 *   npx tsx export.ts team team-fast     # only these runs
 *
 * Embeds events, blackboards, reports, and answers directly in the file, so the
 * result opens from disk, over email, or on a static host with no server and no
 * network access. This is the shareable form of a council run.
 */
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const RUNS = resolve(process.cwd(), 'runs');
const OUT = resolve(process.cwd(), 'council-report.html');
const read = (p: string): Promise<string> => readFile(p, 'utf8').catch(() => '');
const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));

const dirs = (await readdir(RUNS, { withFileTypes: true }).catch(() => []))
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .filter((n) => (only.length ? only.includes(n) : true));

const runs = [];
for (const id of dirs) {
  const events = (await read(join(RUNS, id, 'events.jsonl')))
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
  if (!events.length) continue;
  const report = await read(join(RUNS, id, 'report.json')).then((t) => {
    try {
      return JSON.parse(t);
    } catch {
      return null;
    }
  });
  runs.push({
    id,
    events,
    report,
    board: (await read(join(RUNS, id, 'board.md'))).slice(-20000),
    answer: (await read(join(RUNS, id, 'answer.md'))).slice(0, 20000),
    files: await readdir(join(RUNS, id)).catch(() => []),
  });
}

// Newest first, so the default view is the most recent run.
runs.sort((a, b) => (b.report?.seconds ?? 0) - (a.report?.seconds ?? 0));

const shell = await read(join(process.cwd(), 'ui.html'));
const data = JSON.stringify({ runs });

// Reuse the live UI's markup and styles; swap its fetches for embedded data.
const html = shell
  .replace(/<title>[\s\S]*?<\/title>/, '<title>droid-council — run report</title>')
  .replace(
    /<script>[\s\S]*?<\/script>/,
    `<script>
const DATA = ${data};
const $ = (id) => document.getElementById(id);
const runs = DATA.runs;

const fmt = (n) => n >= 1000 ? (n/1000).toFixed(1).replace(/\\.0$/,'') + 'k' : String(n);
const dur = (ms) => ms < 1000 ? ms + 'ms' : (ms/1000).toFixed(1) + 's';
const esc = (s) => String(s).replace(/[<>&"]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c]));

$('run').innerHTML = runs.map((r,i) => {
  const rep = r.report || {};
  return '<option value="'+i+'">'+r.id+(rep.droids ? ' — '+rep.droids+' droids, '+rep.seconds+'s, '+fmt(Math.round(rep.credits||0))+' cr' : '')+'</option>';
}).join('') || '<option>no runs found</option>';

function show(i) {
  const r = runs[i]; if (!r) return;
  const evs = r.events, report = r.report || {};
  const end = evs.filter(e => e.kind === 'end').pop();
  const spawns = evs.filter(e => e.kind === 'spawn');
  const dones = new Map(evs.filter(e => e.kind === 'done').map(e => [e.id, e]));
  const splits = evs.filter(e => e.kind === 'split');
  const merges = evs.filter(e => e.kind === 'merge');
  const total = Math.max(1000, end ? end.at : Math.max(...spawns.map(s => s.at), 1));

  const cards = [
    ['droids', report.droids ?? spawns.length],
    ['wall clock', (report.seconds ?? Math.round(total/1000)) + 's'],
    ['leaves', report.leaves ?? '—'],
    ['nodes', report.nodes ?? '—'],
    ['credits', fmt(Math.round(report.credits || 0))],
    ['tokens out', fmt(report.outputTokens || 0)],
    ['failed', report.failed ?? 0],
    ['concurrency', report.concurrency ?? '—'],
  ];
  $('stats').innerHTML = cards.map(([k,v]) =>
    '<div class="card"><div class="k">'+k+'</div><div class="v">'+v+'</div></div>').join('');

  $('span').textContent = '— ' + spawns.length + ' droids, ' + splits.length + ' splits, ' + merges.length + ' merges';
  $('mid').textContent = dur(Math.round(total/2));
  $('end').textContent = dur(total);

  $('gantt').innerHTML = spawns.map(s => {
    const d = dones.get(s.id);
    const start = s.at / total * 100;
    const w = d ? Math.max((d.ms / total) * 100, 0.4) : Math.max(100 - start, 0.4);
    const role = !d ? 'work' : (d.ok === false ? 'fail' : s.role);
    const label = esc((s.label || s.role));
    return '<div class="row"><div class="name" title="'+label+'"><b>'+s.role[0].toUpperCase()+'</b> '+label+'</div>'
      + '<div class="track"><div class="bar '+role+'" style="left:'+start+'%;width:'+w+'%"></div></div>'
      + '<div class="ms">'+(d ? dur(d.ms) : '…')+'</div></div>';
  }).join('') || '<div class="empty">no droids in this run</div>';

  $('board').textContent = r.board || '—';
  $('answer').textContent = r.answer || '—';
  $('hint').textContent = r.files.length + ' artifact files';
}

$('run').addEventListener('change', () => show(+$('run').value));
$('reload').addEventListener('click', () => show(+$('run').value));
show(0);
</script>`,
  );

await writeFile(OUT, html);
console.log(`wrote ${OUT}`);
console.log(`  ${runs.length} run(s): ${runs.map((r) => r.id).join(', ')}`);
console.log(`  ${(Buffer.byteLength(html) / 1024).toFixed(0)} KB, self-contained`);
