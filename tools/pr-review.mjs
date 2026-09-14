// Review material gathering + a CI gate confirming review happened — split on
// purpose: judgment runs on the machine of whoever is sending the change (a
// model, or a person, reading the briefing this tool builds); CI only checks
// that a review was published FOR THIS EXACT CONTENT. This tool never judges
// anything itself — sending repos/ or workspace/ content to a model in a CI
// runner is exactly what this split avoids.
//
// Usage:
//   node tools/pr-review.mjs                 briefing: commits, files by area, checks, diff
//   node tools/pr-review.mjs --base <ref>     explicit base (default: this branch's upstream)
//   node tools/pr-review.mjs --head <sha>     review someone else's PR without switching branch
//   node tools/pr-review.mjs post [--pr N] [--dry-run] < verdict.json
//                                             publishes {"verdict","findings","checked"} as a
//                                             PR comment, with the signature embedded in it
//   node tools/pr-review.mjs verify --pr N [--head <sha>]
//                                             CI gate: is there a published review for this content?
//
// The review lives IN THE PR, not in a versioned file: findings sit where
// people read them, next to the diff, and the signature travels inside the
// comment as an HTML comment. A fixed-path file would be worse on three
// fronts — every branch would inherit the last merge's record (born red,
// accusing the wrong thing), two concurrent PRs would conflict on it, and
// main would accumulate shipping receipts for content that no longer exists.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

function die(msg) {
  console.error(msg);
  process.exit(1);
}

// The repo this tool reviews is wherever the CALLER is standing, not where
// this script's own file happens to live: an executor working in its own
// git worktree (see the parallel-agents rule in CLAUDE.md) reviews THAT
// worktree's branch, not the main tree's. Resolved once, from cwd, via git
// itself — never tools/root.mjs's INSTALL_ROOT, which is fixed to wherever
// THIS module's own file lives and would silently review the wrong checkout.
function resolveRepoRoot() {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (e) {
    die(`not inside a git repository (${e.stderr?.toString().trim() || e.message}) — run this from the checkout you want reviewed`);
  }
}
const REPO_ROOT = resolveRepoRoot();

function parseArgs(argv, valueFlags, boolFlags = []) {
  const flags = {};
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const name = a.slice(2);
      if (boolFlags.includes(name)) {
        flags[name] = true;
      } else if (valueFlags.includes(name)) {
        if (i + 1 >= argv.length) die(`--${name} requires a value`);
        flags[name] = argv[++i];
      } else {
        die(`unknown flag: --${name} (accepted: ${[...valueFlags, ...boolFlags].map((f) => `--${f}`).join(', ')})`);
      }
    } else {
      pos.push(a);
    }
  }
  return { flags, pos };
}

function git(args) {
  try {
    return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (e) {
    throw new Error(`git ${args.join(' ')} failed: ${e.stderr?.toString().trim() || e.message}`);
  }
}
function gitOrNull(args) {
  try {
    return git(args);
  } catch {
    return null;
  }
}
function ghJson(args) {
  const out = execFileSync('gh', args, { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return JSON.parse(out);
}

// The base is never guessed as "origin/<default>": in a clone with more than
// one remote that's exactly how the gate silently invalidates — the review
// gets signed against one changeset and CI computes against another.
function resolveBase(explicitBase) {
  if (explicitBase) return explicitBase;
  if (process.env.GITHUB_BASE_REF) {
    const ref = `origin/${process.env.GITHUB_BASE_REF}`;
    if (gitOrNull(['rev-parse', '--verify', ref])) return ref;
  }
  const upstream = gitOrNull(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  if (upstream) return upstream;
  die(
    'cannot resolve a base: this branch has no upstream tracking branch, GITHUB_BASE_REF is not set, and --base was not given.\n' +
      'Pass it explicitly (e.g. --base origin/main) — guessing here is exactly how the gate silently invalidates in a clone with more than one remote.'
  );
}

function resolveHead(explicitHead) {
  return explicitHead || git(['rev-parse', 'HEAD']);
}

function isMergeCommit(sha) {
  const parents = git(['rev-list', '--parents', '-n', '1', sha]).split(/\s+/);
  return parents.length > 2; // [sha, parent1, parent2, ...]
}

// Short hash of the changed-file list AND the diff content against base —
// this IS the changeset a review was published for. Recomputed identically
// on the author's machine (post) and in CI (verify); never trust anything
// that doesn't match it.
function computeSignature(base, head) {
  const range = `${base}...${head}`;
  const files = git(['diff', '--name-only', range]).split('\n').filter(Boolean).sort();
  const diff = git(['diff', range]);
  const hash = crypto.createHash('sha256').update(files.join('\n')).update('\u0000').update(diff).digest('hex').slice(0, 16);
  return { hash, files, diff, base, head };
}

const AREA_RULES = [
  [/^tools\//, 'tools'],
  [/^viewer\//, 'panel'],
  [/^\.claude\//, 'agents and harness config'],
  [/^\.github\//, 'agents and harness config'],
  [/^guardrails\//, 'guardrails'],
  [/\.md$/, 'docs'],
];
function areaFor(file) {
  for (const [re, area] of AREA_RULES) if (re.test(file)) return area;
  return 'other';
}
function groupByArea(files) {
  const groups = {};
  for (const f of files) (groups[areaFor(f)] ??= []).push(f);
  return groups;
}

// --- deterministic checks (no model — same ones CI runs) ---
function checkSyntax() {
  const mjsFiles = git(['ls-files', '*.mjs']).split('\n').filter(Boolean);
  const files = [...mjsFiles, 'viewer/public/app.js']; // the one script *.mjs doesn't catch
  const problems = [];
  for (const f of files) {
    try {
      execFileSync('node', ['--check', f], { cwd: REPO_ROOT, stdio: 'pipe' });
    } catch (e) {
      problems.push(`${f}: ${e.stderr?.toString().trim() || e.message}`);
    }
  }
  return { id: 'syntax', ok: !problems.length, label: `syntax (${files.length} files)`, output: problems.join('\n') || 'ok' };
}

function checkTests() {
  const dir = path.join(REPO_ROOT, 'tools');
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.test.mjs')).sort() : [];
  if (!files.length) {
    return { id: 'tests', ok: false, label: 'tests', output: 'no test files found — tools/*.test.mjs expanded to nothing (this must fail, not pass silently)' };
  }
  try {
    const out = execFileSync('node', ['--test', ...files.map((f) => path.join('tools', f))], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { id: 'tests', ok: true, label: `tests (${files.length} files)`, output: tail(out, 12) };
  } catch (e) {
    return { id: 'tests', ok: false, label: `tests (${files.length} files)`, output: tail((e.stdout?.toString() || '') + (e.stderr?.toString() || ''), 30) };
  }
}

function checkLint() {
  try {
    const out = execFileSync('node', ['tools/check.mjs', '--lint'], { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { id: 'lint', ok: true, label: 'lint', output: out.trim() };
  } catch (e) {
    // check.mjs exits 1 only on an actual "fail" finding — a declared vacuum (no
    // repos in a clean clone) exits 0 and lands in the `try` branch above, never here.
    return { id: 'lint', ok: false, label: 'lint', output: tail((e.stdout?.toString() || '') + (e.stderr?.toString() || ''), 30) };
  }
}

function tail(s, n) {
  const lines = s.split('\n');
  return lines.length <= n ? s : `… (${lines.length - n} more lines)\n` + lines.slice(-n).join('\n');
}

function runChecks() {
  return [checkSyntax(), checkTests(), checkLint()];
}

// --- briefing (default mode) ---
const DIFF_CAP = 4000; // lines — a briefing this long stops being read; the full diff is one `git diff` away

function printBriefing(base, head) {
  const commits = gitOrNull(['log', '--oneline', `${base}..${head}`]) || '';
  const sig = computeSignature(base, head);
  const groups = groupByArea(sig.files);

  console.log('=== PR review briefing ===');
  console.log(`base: ${base}`);
  console.log(`head: ${head}`);
  console.log('');
  console.log(`## Commits (${commits ? commits.split('\n').length : 0})`);
  console.log(commits || '(no commits between base and head)');
  console.log('');
  console.log(`## Files changed (${sig.files.length})`);
  if (!sig.files.length) console.log('(no files changed)');
  for (const [area, files] of Object.entries(groups)) {
    console.log(`### ${area} (${files.length})`);
    for (const f of files) console.log(`  - ${f}`);
  }
  console.log('');
  console.log('## Deterministic checks');
  for (const c of runChecks()) {
    console.log(`[${c.ok ? 'ok' : 'FAIL'}] ${c.label}`);
    if (!c.ok || c.output !== 'ok') console.log(indent(c.output));
  }
  console.log('');
  const diffLines = sig.diff.split('\n');
  console.log(`## Diff${diffLines.length > DIFF_CAP ? ` (first ${DIFF_CAP} of ${diffLines.length} lines — full diff: git diff ${base}...${head})` : ''}`);
  console.log(diffLines.slice(0, DIFF_CAP).join('\n'));
  console.log('');
  console.log('---');
  console.log(`signature: ${sig.hash}`);
}
function indent(s) {
  return s.split('\n').map((l) => `    ${l}`).join('\n');
}

// --- post: publish {"verdict","findings","checked"} as a PR comment ---
const SIGNATURE_MARKER = 'wfa-pr-review';

function renderComment(review, sig) {
  const findings = Array.isArray(review.findings) ? review.findings : [];
  const checked = Array.isArray(review.checked) ? review.checked : [];
  const lines = [];
  lines.push(`**Verdict**: ${review.verdict}`);
  lines.push('');
  lines.push(checked.length ? `Checked: ${checked.join(', ')}` : 'Checked: (nothing listed)');
  lines.push('');
  if (findings.length) {
    lines.push('**Findings**');
    for (const f of findings) lines.push(`- ${typeof f === 'string' ? f : JSON.stringify(f)}`);
  } else {
    lines.push('No findings.');
  }
  lines.push('');
  lines.push(`<!-- ${SIGNATURE_MARKER}: ${JSON.stringify({ hash: sig.hash, base: sig.base, head: sig.head })} -->`);
  return lines.join('\n');
}

function readStdinJson() {
  let raw;
  try {
    raw = fs.readFileSync(0, 'utf8');
  } catch {
    die('could not read stdin');
  }
  if (!raw.trim()) die('stdin is empty — pipe {"verdict","findings","checked"} in');
  let review;
  try {
    review = JSON.parse(raw);
  } catch (e) {
    die(`stdin is not valid JSON: ${e.message}`);
  }
  if (typeof review.verdict !== 'string' || !review.verdict.trim()) die('the review JSON needs a non-empty "verdict" string');
  if (review.findings !== undefined && !Array.isArray(review.findings)) die('"findings" must be an array when present');
  if (review.checked !== undefined && !Array.isArray(review.checked)) die('"checked" must be an array when present');
  return review;
}

function resolvePrNumber(explicitPr) {
  if (explicitPr) {
    const n = Number(explicitPr);
    if (!Number.isInteger(n) || n <= 0) die(`--pr must be a positive integer, got "${explicitPr}"`);
    return n;
  }
  let out;
  try {
    out = execFileSync('gh', ['pr', 'view', '--json', 'number'], { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    die(`could not auto-detect the PR for this branch (${e.stderr?.toString().trim() || e.message}) — pass --pr N explicitly`);
  }
  return JSON.parse(out).number;
}

function cmdPost(rest) {
  const { flags } = parseArgs(rest, ['pr', 'base', 'head'], ['dry-run']);
  const review = readStdinJson();
  const base = resolveBase(flags.base);
  const head = resolveHead(flags.head);
  const sig = computeSignature(base, head);
  const body = renderComment(review, sig);

  if (flags['dry-run']) {
    console.log('(dry-run — nothing published)');
    console.log(`base: ${base}`);
    console.log(`head: ${head}`);
    console.log(`signature: ${sig.hash}`);
    console.log('');
    console.log(body);
    return;
  }

  const pr = resolvePrNumber(flags.pr);
  try {
    execFileSync('gh', ['pr', 'comment', String(pr), '--body-file', '-'], { cwd: REPO_ROOT, input: body, stdio: ['pipe', 'inherit', 'inherit'] });
  } catch (e) {
    die(`gh pr comment failed: ${e.message}`);
  }
  console.log(`review published on PR #${pr} (signature ${sig.hash})`);
}

// --- verify: CI gate — is there a published review for THIS content? ---
function cmdVerify(rest) {
  const { flags } = parseArgs(rest, ['pr', 'base', 'head']);
  if (!flags.pr) die('usage: node tools/pr-review.mjs verify --pr N [--base <ref>] [--head <sha>]');
  const pr = Number(flags.pr);
  if (!Number.isInteger(pr) || pr <= 0) die(`--pr must be a positive integer, got "${flags.pr}"`);

  const base = resolveBase(flags.base);
  let head = flags.head;
  if (!head) {
    const current = git(['rev-parse', 'HEAD']);
    // pull_request CI checks out the synthetic merge commit (refs/pull/N/merge):
    // signing against it changes on every base advance, with no commit on the PR.
    if (isMergeCommit(current)) {
      die(
        `HEAD (${current.slice(0, 12)}) is a merge commit — in pull_request CI that is the synthetic refs/pull/${pr}/merge, ` +
          'not the PR content anyone reviewed. Pass --head <sha> with the PR head sha (the same content the author signed).'
      );
    }
    head = current;
  }

  const sig = computeSignature(base, head);
  let comments;
  try {
    comments = ghJson(['pr', 'view', String(pr), '--json', 'comments']).comments ?? [];
  } catch (e) {
    die(`could not read PR #${pr}'s comments: ${e.message}`);
  }
  const marker = new RegExp(`<!--\\s*${SIGNATURE_MARKER}:\\s*(\\{[^}]*\\})\\s*-->`);
  for (const c of comments) {
    const m = marker.exec(c.body || '');
    if (!m) continue;
    let parsed;
    try {
      parsed = JSON.parse(m[1]);
    } catch {
      continue;
    }
    if (parsed.hash === sig.hash) {
      console.log(`ok: review found for this content (signature ${sig.hash})`);
      return;
    }
  }
  die(
    `no published review matches this content (signature ${sig.hash}, base ${base}, head ${head}).\n` +
      `Run: node tools/pr-review.mjs post --pr ${pr} [--base ${base}] [--head ${head}] < verdict.json`
  );
}

// --- entrypoint ---
// Guard: only run the CLI when this module is the entrypoint (allows
// importing areaFor/groupByArea/computeSignature/etc. from tests without
// side effects — the same pattern dag.mjs uses for check.mjs).
const isEntrypoint = process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname;
if (isEntrypoint) {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === 'post') {
    cmdPost(rest);
  } else if (cmd === 'verify') {
    cmdVerify(rest);
  } else if (cmd === undefined || cmd.startsWith('--')) {
    const { flags } = parseArgs(process.argv.slice(2), ['base', 'head']);
    printBriefing(resolveBase(flags.base), resolveHead(flags.head));
  } else {
    die('usage: node tools/pr-review.mjs [--base <ref>] [--head <sha>] | post [--pr N] [--dry-run] < verdict.json | verify --pr N [--head <sha>]');
  }
}

export { areaFor, groupByArea, computeSignature, resolveBase, resolveHead, isMergeCommit, resolveRepoRoot };
