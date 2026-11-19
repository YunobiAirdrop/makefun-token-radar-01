// LaunchLens-3 — a token launch radar (Node 22, standard library only).
//
// Reads the sealed snapshot (--input <file|dir>, default /input/snapshot.json),
// scores every launch candidate with the fitted model in lib/model.ts, and
// writes the hand-in to the output directory (MAKEFUN_OUTPUT_DIR, or /output):
//   board.json    the ranked board (rows sorted by rank)
//   data.js       the same radar, as the dashboard's data file
//   dashboard/    a copy of this repository's static dashboard
//   screenshots/  a copy of this repository's three screenshots
//   dossier.json  buildDossier from vendor/makefun-board.ts, written last
//
// Local run:
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../input/snapshot.json

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boardIssue, buildRadar, dataScript, parseSnapshot } from './lib/model.ts';
import { buildDossier } from './vendor/makefun-board.ts';

const root = fileURLToPath(new URL('.', import.meta.url));
const TEXT_MAX_BYTES = 65_536;
const IMAGE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

function option(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  if (at >= 0 && process.argv[at + 1] !== undefined) return process.argv[at + 1]!;
  const joined = process.argv.find((a) => a.startsWith(`--${name}=`));
  return joined === undefined ? fallback : joined.slice(name.length + 3);
}

const inputArg = option('input', '/input');
const inputPath = inputArg.endsWith('.json') ? inputArg : join(inputArg, 'snapshot.json');
if (!existsSync(inputPath)) {
  process.stderr.write(`launchlens-3: no snapshot at ${inputPath}\n`);
  process.exit(2);
}
const outDir = option('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

const snapshot = parseSnapshot(readFileSync(inputPath, 'utf8'));
const { board, radar } = buildRadar(snapshot);
const issue = boardIssue(board, snapshot);
if (issue !== null) {
  process.stderr.write(`launchlens-3: refusing to write a board the gate rejects: ${issue}\n`);
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'board.json'), `${JSON.stringify({ rows: board })}\n`);
writeFileSync(join(outDir, 'data.js'), dataScript(radar));

function copyPlainFiles(from: string, to: string): string[] {
  if (!existsSync(from)) return [];
  mkdirSync(to, { recursive: true });
  const names: string[] = [];
  for (const name of readdirSync(from)) {
    if (name.startsWith('.')) continue;
    const src = join(from, name);
    if (!statSync(src).isFile()) continue;
    copyFileSync(src, join(to, name));
    names.push(name);
  }
  return names.sort();
}

const dashFiles = copyPlainFiles(join(root, 'dashboard'), join(outDir, 'dashboard'));
const shots = copyPlainFiles(join(root, 'screenshots'), join(outDir, 'screenshots'));
if (shots.length < 3 || shots.length > 4) {
  process.stderr.write(`launchlens-3: screenshots/ holds ${shots.length} files; the gate wants 3 or 4\n`);
  process.exit(1);
}
for (const name of shots) {
  if (!IMAGE_NAME.test(name)) {
    process.stderr.write(`launchlens-3: bad screenshot name ${name}\n`);
    process.exit(1);
  }
}

const dossier = buildDossier(outDir, {
  text_max_bytes: TEXT_MAX_BYTES,
  screenshots: { max: 4, max_bytes: 524_288 },
  dashboard: { max_files: 400, max_bytes: 4_194_304 },
});
writeFileSync(join(outDir, 'dossier.json'), dossier);

process.stdout.write(
  `launchlens-3: ${snapshot.protocols.length} protocols, watchlist ${snapshot.watchlist.length} covered, ` +
    `${board.length} pre-token rows ranked, ${radar.live.length} already-trading set aside\n` +
    `launchlens-3: dashboard ${dashFiles.length} files, screenshots ${shots.length}, dossier ${dossier.length} bytes -> ${outDir}\n`,
);
