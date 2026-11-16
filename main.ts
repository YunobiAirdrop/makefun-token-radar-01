// LaunchLens: a token launch radar entry (Node 22, standard library only).
//
// The program reads the sealed snapshot from /input/snapshot.json (or --input <file|dir>), scores every
// rankable pre-token protocol with the model in lib/model.ts, writes the ranked board to
// /output/board.json, writes the dashboard's data to /output/data.js, copies this repository's
// dashboard/ and screenshots/ into /output, and writes /output/dossier.json with buildDossier from
// vendor/makefun-board.ts, the kit's library, byte for byte the scorer's own copy.
//
// Outside the grader's container, MAKEFUN_OUTPUT_DIR stands in for /output:
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../input/snapshot.json
//
// The program is deterministic: the same snapshot always writes the same bytes.

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boardIssue, buildRadar, dataScript, parseSnapshot } from './lib/model.ts';
import { buildDossier } from './vendor/makefun-board.ts';

const here = fileURLToPath(new URL('.', import.meta.url));

/** The scorer's own caps (reference/gate.json): the text cap shapes the bytes, the rest refuse. */
const TEXT_MAX_BYTES = 65_536;
const SCREENSHOT_CAPS = { max: 4, max_bytes: 524_288 };
const DASHBOARD_CAPS = { max_files: 400, max_bytes: 4_194_304 };
const IMAGE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

/** --name <value> (or --name=<value>) out of the arguments, or the fallback. */
function arg(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  if (at >= 0 && at + 1 < process.argv.length) return process.argv[at + 1]!;
  const withEquals = process.argv.find((a) => a.startsWith(`--${name}=`));
  return withEquals === undefined ? fallback : withEquals.slice(name.length + 3);
}

function fail(message: string): never {
  process.stderr.write(`launchlens: ${message}\n`);
  process.exit(1);
}

const inputArg = arg('input', '/input');
const inputFile = inputArg.endsWith('.json') ? inputArg : join(inputArg, 'snapshot.json');
if (!existsSync(inputFile)) {
  process.stderr.write(`launchlens: no snapshot at ${inputFile}: pass --input <snapshot.json|directory> or mount the sealed /input\n`);
  process.exit(2);
}
const out = arg('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

const snapshot = parseSnapshot(readFileSync(inputFile, 'utf8'));
const { board, radar } = buildRadar(snapshot);
const issue = boardIssue(board, snapshot);
if (issue !== null) fail(`the model wrote a board the gate refuses: ${issue}`);

mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'board.json'), `${JSON.stringify({ rows: board })}\n`);
writeFileSync(join(out, 'data.js'), dataScript(radar));

/** Copy a directory tree's regular files into `to`, skipping names that start with a dot. */
function copyTree(from: string, to: string): string[] {
  if (!existsSync(from)) return [];
  mkdirSync(to, { recursive: true });
  const copied: string[] = [];
  for (const name of readdirSync(from)) {
    if (name.startsWith('.')) continue;
    const path = join(from, name);
    const st = statSync(path);
    if (st.isDirectory()) {
      for (const inner of copyTree(path, join(to, name))) copied.push(`${name}/${inner}`);
    } else if (st.isFile()) {
      copyFileSync(path, join(to, name));
      copied.push(name);
    }
  }
  return copied;
}

const dashboardFiles = copyTree(join(here, 'dashboard'), join(out, 'dashboard'));
if (!dashboardFiles.some((f) => f === 'index.html')) fail('dashboard/ holds no index.html');
const shots = copyTree(join(here, 'screenshots'), join(out, 'screenshots'));
if (shots.length < 3) fail(`screenshots/ holds ${shots.length} image${shots.length === 1 ? '' : 's'}: hand in 3, the board, a detail view and a filtered view`);
for (const name of shots) {
  if (!IMAGE_NAME.test(name)) fail(`screenshots/${name}: a name is letters, digits and . _ -, 1 to 128 characters, not starting with . or -`);
}

// The dossier is written last: the scorer rebuilds it from this /output and compares bytes.
const dossier = buildDossier(out, { text_max_bytes: TEXT_MAX_BYTES, screenshots: SCREENSHOT_CAPS, dashboard: DASHBOARD_CAPS });
writeFileSync(join(out, 'dossier.json'), dossier);

// With --verify, prove the hand-in from disk rather than from memory: the board file parses and
// passes the same self-check, and the dossier on disk is byte for byte a fresh buildDossier.
if (process.argv.includes('--verify')) {
  const written = JSON.parse(readFileSync(join(out, 'board.json'), 'utf8')) as { rows?: unknown };
  if (typeof written !== 'object' || written === null || !Array.isArray(written.rows)) fail('verify: board.json on disk is not an object with rows');
  const recheck = boardIssue(written.rows as ReturnType<typeof buildRadar>['board'], snapshot);
  if (recheck !== null) fail(`verify: the board on disk fails its own check: ${recheck}`);
  const rebuilt = buildDossier(out, { text_max_bytes: TEXT_MAX_BYTES, screenshots: SCREENSHOT_CAPS, dashboard: DASHBOARD_CAPS });
  const onDisk = readFileSync(join(out, 'dossier.json'));
  if (!onDisk.equals(Buffer.from(rebuilt))) fail('verify: dossier.json on disk differs from a fresh buildDossier of the output');
  process.stdout.write('launchlens: verify ok: board.json rechecked and dossier.json matches a fresh build\n');
}

process.stdout.write(
  `launchlens: ${snapshot.protocols.length} protocols, ${snapshot.watchlist.length} on the watchlist, ${board.length} rows scored (${radar.early_size} early, ${radar.live_size} live set aside), global multiple ${radar.global_multiple}\n` +
    `launchlens: wrote ${relative(process.cwd(), join(out, 'board.json'))}, data.js, dashboard (${dashboardFiles.length} files), screenshots (${shots.length} images) and dossier.json (${dossier.length} bytes)\n`,
);
