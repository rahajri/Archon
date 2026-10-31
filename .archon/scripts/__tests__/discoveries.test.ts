import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { trackTempRoots } from './temp-roots';
import type { ArchonTask } from '../../workflows/sdlc/.shared/archon-tracker';
import {
  AGENT_OUTCOMES,
  type AgentDecision,
  checkDecisions,
  FILING_TRACKERS,
  filedDiscoveries,
  parseFilingTarget,
  parseRunDocument,
} from '../../workflows/sdlc/.shared/discoveries';
import { latestVerdictOf, relayedDiscoveries } from '../../workflows/sdlc/.shared/report';
import { type GhIssue, gitCheckout, hostCli, PACK, packScriptRunner, PR, type ScriptRun } from './deliver-checks-harness';

const { runPackScript } = packScriptRunner();
const track = trackTempRoots();

const FAKE_ARCHON = resolve(import.meta.dir, 'fixtures/fake-archon-runs.ts');
const REPO = PR.repo;
const RUN = 'aaaaaaaa-0000-4000-8000-000000000001';

function record(title: string): Record<string, unknown> {
  return { title, claim: `${title}, claimed`, evidence: ['a.ts:1'], relation: 'unrelated', source_nodes: ['implement'] };
}

/** A run's artifact directory: an optional review verdict, then raw records. */
function runArtifacts(
  root: string,
  id: string,
  shape: { verdict?: Record<string, unknown>[]; before?: Record<string, unknown>[]; after?: Record<string, unknown>[] }
): string {
  const dir = join(root, 'artifacts', 'runs', id);
  mkdirSync(join(dir, 'discoveries'), { recursive: true });
  const old = new Date('2026-10-14T00:00:00Z');
  const verdictAt = new Date('2026-10-14T01:00:00Z');
  const late = new Date('2026-10-14T02:00:00Z');
  if (shape.before !== undefined) {
    writeFileSync(join(dir, 'discoveries/implement.json'), JSON.stringify(shape.before));
    utimesSync(join(dir, 'discoveries/implement.json'), old, old);
  }
  if (shape.verdict !== undefined) {
    mkdirSync(join(dir, 'nodes'));
    // An earlier verdict that the later one supersedes.
    writeFileSync(join(dir, 'nodes/first.md'), JSON.stringify({ discoveries: [record('superseded')] }));
    writeFileSync(
      join(dir, 'nodes/first.meta.json'),
      JSON.stringify({ nodeId: 'review', outputType: 'review-report', path: 'nodes/first.md', runId: id, producedAt: old.toISOString(), size: 1 })
    );
    writeFileSync(join(dir, 'nodes/review.md'), JSON.stringify({ ready: true, discoveries: shape.verdict }));
    utimesSync(join(dir, 'nodes/review.md'), verdictAt, verdictAt);
    writeFileSync(
      join(dir, 'nodes/review.meta.json'),
      JSON.stringify({ nodeId: 'review', outputType: 'review-report', path: 'nodes/review.md', runId: id, producedAt: verdictAt.toISOString(), size: 1 })
    );
    writeFileSync(
      join(dir, 'nodes/plan.meta.json'),
      JSON.stringify({ nodeId: 'plan', outputType: 'plan', path: 'nodes/plan.md', runId: id, producedAt: late.toISOString(), size: 1 })
    );
  }
  if (shape.after !== undefined) {
    writeFileSync(join(dir, 'discoveries/structure.json'), JSON.stringify(shape.after));
    utimesSync(join(dir, 'discoveries/structure.json'), late, late);
  }
  return dir;
}

describe("a run's discoveries", () => {
  test('the latest verdict, plus raw records written after it; a record it judged is not raised again', () => {
    const root = track(mkdtempSync(join(tmpdir(), 'archon-discoveries-')));
    const dir = runArtifacts(root, RUN, {
      before: [record('judged by review')],
      verdict: [record('certified')],
      after: [record('written after review')],
    });
    const relayed = relayedDiscoveries(dir, latestVerdictOf(dir));
    expect(relayed.problems).toEqual([]);
    expect(relayed.records.map(entry => [entry.ref, entry.title, entry.reviewed])).toEqual([
      ['review#0', 'certified', true],
      ['discoveries/structure.json#0', 'written after review', false],
    ]);
  });

  test('without a review, every raw record; an unreadable file is a named problem', () => {
    const root = track(mkdtempSync(join(tmpdir(), 'archon-discoveries-')));
    const dir = runArtifacts(root, RUN, { before: [record('one'), record('two')] });
    writeFileSync(join(dir, 'discoveries/broken.json'), '{');
    expect(latestVerdictOf(dir)).toBeUndefined();
    const relayed = relayedDiscoveries(dir, undefined);
    expect(relayed.records.map(entry => entry.ref)).toEqual(['discoveries/implement.json#0', 'discoveries/implement.json#1']);
    expect(relayed.problems).toEqual([expect.stringContaining('broken.json')]);
  });
});

// --- the run document and the pre-write check ---------------------------------------

const ISSUE = { repo: REPO, number: 7 };

function workflowNode(node: 'facts' | 'decide' | 'outcome'): { output_format?: Record<string, unknown>; with?: Record<string, unknown> } {
  const workflow = Bun.YAML.parse(readFileSync(join(PACK, 'discoveries/archon-discoveries.yaml'), 'utf8')) as {
    nodes: { id: string; output_format?: Record<string, unknown>; with?: Record<string, unknown> }[];
  };
  return workflow.nodes.find(entry => entry.id === node) ?? {};
}

function outputSchema(node: 'facts' | 'decide'): Record<string, unknown> {
  return workflowNode(node).output_format ?? {};
}

/** The facts output fields the outcome binds, by the input name it reads them under. */
function outcomeBindsFromFacts(): Map<string, string> {
  const bound = new Map<string, string>();
  for (const [input, value] of Object.entries(workflowNode('outcome').with ?? {})) {
    const field = typeof value === 'string' ? /^\$facts\.output\.(\w+)$/.exec(value)?.[1] : undefined;
    if (field !== undefined) bound.set(input, field);
  }
  return bound;
}

const GITHUB_FIELDS = { tracker: 'github', archon_project_id: '', tracker_base_url: '' };
const ARCHON_FIELDS = { tracker: 'archon', archon_project_id: 'project', tracker_base_url: 'http://127.0.0.1:8181/' };

describe("a drained run's document", () => {
  test('round-trips through its parser, and one that does not parse refuses, naming the document', () => {
    const name = `discoveries/runs/${RUN}`;
    const value = {
      version: 1 as const,
      claim: null,
      decided: [`${RUN}:review#0`],
      questions: [{ keys: ['k-one'], refs: [`${RUN}:review#1`], text: 'q', recommendation: 'r', answer: { text: 'a', at: 'now' } }],
    };
    expect(parseRunDocument(name, JSON.parse(JSON.stringify(value)))).toEqual(value);
    expect(parseRunDocument(name, { version: 1, claim: null })).toEqual({ version: 1, claim: null });
    for (const bad of [{ version: 2, claim: null }, { version: 1, claim: null, decided: 'x' }, { version: 1, claim: null, questions: [{ text: 'q' }] }]) {
      expect(() => parseRunDocument(name, bad)).toThrow(name);
    }
  });

  test('every queued ref is decided exactly once', () => {
    const drop = (key: string, refs: string[]): AgentDecision => ({ outcome: 'drop', key, refs, title: 't', reason: 'r' });
    const queued = ['run:review#0', 'run:review#1'];
    expect(checkDecisions(queued, [drop('first-key', queued)])).toEqual([]);
    expect(checkDecisions(queued, [drop('first-key', ['run:review#0'])])).toEqual(['run:review#1 has no decision']);
    expect(checkDecisions(queued, [drop('first-key', queued), drop('second-key', ['run:review#1', 'run:other#0'])])).toEqual([
      'run:review#1 is decided under both first-key and second-key',
      'run:other#0 (key second-key) is not a queued ref',
    ]);
  });

  test("the decide node's output schema names exactly the agent's outcomes", () => {
    const schema = outputSchema('decide');
    const items = (schema.properties as { decisions: { items: { anyOf: { properties: { outcome: { enum: string[] } } }[] } } })
      .decisions.items.anyOf;
    expect(items.map(branch => branch.properties.outcome.enum).flat().sort()).toEqual([...AGENT_OUTCOMES].sort());
  });

  test("the facts node's tracker enum names exactly the trackers a filing target accepts", () => {
    const declared = (outputSchema('facts').properties as { tracker: { enum: string[] } }).tracker.enum;
    expect([...declared].sort()).toEqual([...FILING_TRACKERS].sort());
    for (const tracker of declared) {
      expect(parseFilingTarget(tracker === 'github' ? GITHUB_FIELDS : { ...ARCHON_FIELDS, tracker })).toMatchObject({ tracker });
    }
    expect(() => parseFilingTarget({ ...ARCHON_FIELDS, tracker: 'jira' })).toThrow('is not a filing target');
  });

  test('facts declares and requires every field of a filing target, and the outcome binds each under its own name', () => {
    const facts = outputSchema('facts') as { properties: Record<string, unknown>; required: string[] };
    const bound = outcomeBindsFromFacts();
    for (const target of [parseFilingTarget(GITHUB_FIELDS), parseFilingTarget(ARCHON_FIELDS)]) {
      for (const field of Object.keys(target)) {
        expect(facts.properties).toHaveProperty(field);
        expect(facts.required).toContain(field);
        expect(bound.get(field)).toBe(field);
      }
    }
  });

  test.each([
    ['an Archon target with no tracker base URL', { ...ARCHON_FIELDS, tracker_base_url: '' }],
    ['an Archon target whose base URL is not normalized', { ...ARCHON_FIELDS, tracker_base_url: 'http://127.0.0.1:8181' }],
    ['an Archon target whose base URL carries credentials', { ...ARCHON_FIELDS, tracker_base_url: 'http://user:S3CRET@127.0.0.1:8181/' }],
    ['an Archon target whose base URL carries a query', { ...ARCHON_FIELDS, tracker_base_url: 'http://127.0.0.1:8181/?token=S3CRET' }],
    ['an Archon target whose base URL ends in an empty query', { ...ARCHON_FIELDS, tracker_base_url: 'http://127.0.0.1:8181/?' }],
    ['an Archon target whose base URL ends in an empty fragment', { ...ARCHON_FIELDS, tracker_base_url: 'http://127.0.0.1:8181/#' }],
    ['a GitHub target that names a tracker base URL', { ...GITHUB_FIELDS, tracker_base_url: 'http://127.0.0.1:8181/' }],
  ])('refuses %s, without quoting the URL', (_case, fields) => {
    expect(() => parseFilingTarget(fields)).toThrow('is not a filing target');
    try {
      parseFilingTarget(fields);
    } catch (error) {
      expect(String(error)).not.toContain('S3CRET');
      expect(String(error)).not.toContain('127.0.0.1');
    }
  });
});

describe('the tasks a pass filed', () => {
  const task = (description: string | null, id = 'task-7'): ArchonTask => ({
    id,
    project_id: 'p',
    title: 'A defect',
    description,
    status: 'todo',
    archived: false,
  });
  const MARKER = '<!-- archon-discovery earlier-key -->';
  const REFS = `<!-- archon-discovery-refs ["${RUN}:review#0"] -->`;

  test('reads a canonical filing, a marker-only one from before tasks recorded refs, and skips tasks with no metadata', () => {
    const tasks = [
      task([MARKER, REFS, 'The brief.'].join('\n'), 'task-1'),
      task([MARKER, REFS, 'The brief.'].join('\r\n'), 'task-2'),
      task([MARKER, 'The brief.'].join('\n'), 'task-3'),
      task(MARKER, 'task-4'),
      task('A task a person wrote about the archon-discoveries workflow.', 'task-5'),
      task(null, 'task-6'),
    ];
    expect(filedDiscoveries(tasks).map(({ key, refs, task: { id } }) => ({ id, key, refs }))).toEqual([
      { id: 'task-1', key: 'earlier-key', refs: [`${RUN}:review#0`] },
      { id: 'task-2', key: 'earlier-key', refs: [`${RUN}:review#0`] },
      { id: 'task-3', key: 'earlier-key', refs: [] },
      { id: 'task-4', key: 'earlier-key', refs: [] },
    ]);
  });

  test.each([
    ['a leading space before the marker', [` ${MARKER}`, REFS], 'marker line is not canonical'],
    ['a marker without its space', ['<!--archon-discovery earlier-key -->', REFS], 'marker line is not canonical'],
    ['a marker in another case', ['<!-- Archon-Discovery earlier-key -->'], 'marker line is not canonical'],
    ['a blank line before the marker', ['', MARKER, REFS], 'marker line is not canonical'],
    ['prose before the marker', ['Filed by hand.', MARKER], 'marker line is not canonical'],
    ['a marker that does not close', ['<!-- archon-discovery earlier-key'], 'marker line is not canonical'],
    ['a refs line where the marker belongs', [REFS], 'marker line is not canonical'],
    ['a key that is not a decision key', ['<!-- archon-discovery Earlier_Key -->', REFS], 'marker does not carry a decision key'],
    ['a key with trailing space', ['<!-- archon-discovery earlier-key  -->'], 'marker does not carry a decision key'],
    ['a blank line before the refs line', [MARKER, '', REFS], 'metadata after its header'],
    ['a refs line with a leading space', [MARKER, ` ${REFS}`], 'refs line is not canonical'],
    ['a refs line that does not close', [MARKER, `<!-- archon-discovery-refs ["${RUN}:review#0"]`], 'refs line is not canonical'],
    ['a refs line that is not JSON', [MARKER, `<!-- archon-discovery-refs [${RUN}:review#0 -->`], 'not a list of qualified refs'],
    ['a refs line that is not a list', [MARKER, '<!-- archon-discovery-refs {"ref":1} -->'], 'not a list of qualified refs'],
    ['a refs line that lists no refs', [MARKER, '<!-- archon-discovery-refs [] -->'], 'not a list of qualified refs'],
    ['a refs line with a ref that is not qualified', [MARKER, '<!-- archon-discovery-refs ["review#0"] -->'], 'not a list of qualified refs'],
    ['a refs line with a ref that is not a string', [MARKER, `<!-- archon-discovery-refs ["${RUN}:review#0", 7] -->`], 'not a list of qualified refs'],
    ['a second marker in the brief', [MARKER, REFS, 'The brief.', '<!-- archon-discovery other-key -->'], 'metadata after its header'],
  ])('refuses %s rather than reading the task as no filing', (_case, lines, why) => {
    expect(() => filedDiscoveries([task([...lines, 'The brief.'].join('\n'))])).toThrow(
      new RegExp(`^task task-7 carries corrupt archon-discovery metadata: .*${why}`)
    );
  });
});

// --- the scripts, run as the engine runs them ----------------------------------------

interface Install {
  readonly checkout: string;
  readonly outputRoot: string;
  readonly env: Record<string, string>;
}

function install(): Install {
  const checkout = gitCheckout({}, track);
  const home = track(mkdtempSync(join(tmpdir(), 'archon-discoveries-home-')));
  const outputRoot = track(mkdtempSync(join(tmpdir(), 'archon-discoveries-runs-')));
  return {
    checkout,
    outputRoot,
    env: { ARCHON_HOME: home, HOME: home, DATABASE_URL: '', ARCHON_TELEMETRY_DISABLED: '1', INTAKE_STATE_CWD: checkout, INTAKE_HOST_CLI: JSON.stringify(hostCli()) },
  };
}

function listing(at: Install, ids: string[]): string {
  return JSON.stringify(
    ids.map((id, index) => ({
      id,
      workflow_name: 'archon-ship',
      status: 'completed',
      completed_at: new Date(Date.parse('2026-10-14T03:00:00Z') + index * 60_000).toISOString(),
      output_root: at.outputRoot,
    }))
  );
}

interface Pass {
  readonly runId: string;
  readonly runs: string[];
  readonly statuses?: Record<string, string>;
  readonly issues?: GhIssue[];
  readonly subject?: { state: 'open' | 'closed' };
  readonly env?: Record<string, string>;
  readonly preload?: string;
}

type Script = 'facts' | 'outcome' | 'answer';

function script(at: Install, name: Script, pass: Pass, inputs: Record<string, string> = {}, artifacts: Record<string, string> = {}): ScriptRun {
  return runPackScript(`discoveries/scripts/${name}`, {
    cwd: at.checkout,
    forge: { kind: 'command', argv: [process.execPath, FAKE_ARCHON] },
    gh: { issue: { number: 7, state: pass.subject?.state ?? 'open' }, issues: pass.issues ?? [] },
    preload: pass.preload,
    artifacts,
    inputs: {
      ...at.env,
      WORKFLOW_ID: pass.runId,
      INTAKE_RUN_STATUSES: JSON.stringify(pass.statuses ?? {}),
      RUN_LISTING: listing(at, pass.runs),
      INPUTS_REPO_HOST: REPO.host,
      INPUTS_REPO_PATH: REPO.path,
      INPUTS_SINCE: '',
      INPUTS_UNTIL: '',
      INPUTS_LIMIT: '20',
      ...pass.env,
      ...inputs,
    },
  });
}

/** A script that succeeded. `scripts/sdlc-output-conformance.test.ts` validates its output schema. */
function ok(result: ScriptRun): Record<string, unknown> {
  expect({ code: result.code, stderr: result.stderr }).toEqual({ code: 0, stderr: '' });
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

/** The refs a facts run queued. */
function queued(facts: ScriptRun): string[] {
  const queue = JSON.parse(readFileSync(join(facts.artifacts, 'drain/queue.json'), 'utf8')) as {
    runs: { records: { ref: string }[] }[];
  };
  return queue.runs.flatMap(run => run.records.map(entry => entry.ref));
}

/** The inputs the outcome binds from a facts run's output, as the workflow binds them. */
function fromFacts(facts: ScriptRun): Record<string, string> {
  const output = ok(facts);
  return Object.fromEntries(
    [...outcomeBindsFromFacts()].map(([input, field]) => [`INPUTS_${input.toUpperCase()}`, String(output[field])])
  );
}

/** Run the outcome over a facts run's queue with these decisions. */
function outcomeAfter(at: Install, pass: Pass, facts: ScriptRun, decisions: (refs: string[]) => AgentDecision[]): ScriptRun {
  return script(
    at,
    'outcome',
    pass,
    { ...fromFacts(facts), INPUTS_DECISIONS: JSON.stringify(decisions(queued(facts))), INPUTS_SUMMARY: 'summary' },
    { 'drain/queue.json': readFileSync(join(facts.artifacts, 'drain/queue.json'), 'utf8') }
  );
}

/** Run facts, then the outcome over its queue with these decisions. */
function decide(at: Install, pass: Pass, decisions: (refs: string[]) => AgentDecision[]): { facts: ScriptRun; outcome: ScriptRun } {
  const facts = script(at, 'facts', pass);
  return { facts, outcome: outcomeAfter(at, pass, facts, decisions) };
}

function cli(at: Install, args: string[], input?: string): { status: number | null; value: Record<string, unknown> } {
  const [command, ...prefix] = hostCli();
  const result = spawnSync(command, [...prefix, ...args], {
    cwd: at.checkout,
    env: { ...process.env, ...at.env, WORKFLOW_ID: '', ARCHON_NODE_EXECUTION: '' },
    input: input ?? '',
    encoding: 'utf8',
  });
  return { status: result.status, value: JSON.parse(result.stdout) as Record<string, unknown> };
}

function state(at: Install, name: string): unknown {
  return cli(at, ['state', 'get', name]).value.value ?? null;
}

function seed(at: Install, name: string, value: unknown): void {
  expect(cli(at, ['state', 'put', name, '--if-revision', '0'], JSON.stringify(value)).status).toBe(0);
}

function documents(at: Install, prefix = 'discoveries/'): unknown[] {
  return (cli(at, ['state', 'list', '--prefix', prefix]).value.documents as unknown[]) ?? [];
}

const fileIt = (key: string) => (refs: string[]): AgentDecision[] => [
  { outcome: 'file', key, refs, title: 'A new defect', body: 'The brief.', reason: 'real at the base' },
];

describe('the discoveries scripts', () => {
  test('a live pass files the issue with its marker, records the decided refs on the run, and a second pass finds nothing to do', () => {
    const at = install();
    const writer = track(mkdtempSync(join(tmpdir(), 'archon-discoveries-writer-')));
    const git = (cwd: string, ...args: string[]): string => {
      const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
      if (result.status !== 0) throw new Error(result.stderr);
      return result.stdout.trim();
    };
    git(writer, 'clone', '-q', git(at.checkout, 'remote', 'get-url', 'upstream'), '.');
    git(writer, 'config', 'user.email', 'test@example.com');
    git(writer, 'config', 'user.name', 'Test');
    git(writer, 'commit', '-q', '--allow-empty', '-m', 'remote advanced');
    git(writer, 'push', '-q', 'origin', 'dev');
    const fresh = git(writer, 'rev-parse', 'HEAD');
    expect(git(at.checkout, 'rev-parse', 'HEAD')).not.toBe(fresh);
    expect(git(at.checkout, 'rev-parse', 'refs/remotes/upstream/dev')).not.toBe(fresh);
    runArtifacts(at.outputRoot, RUN, { verdict: [record('new'), record('covered'), record('fixed')] });
    const { facts, outcome } = decide(at, { runId: 'pass-1', runs: [RUN] }, refs => [
      { outcome: 'file', key: 'new-defect', refs: [refs[0] as string], title: 'A new defect', body: 'The brief.', reason: 'real' },
      { outcome: 'track', key: 'covered-defect', refs: [refs[1] as string], title: 'Covered', issue: ISSUE, comment: 'A new reproduction.', reason: 'issue 7 covers it' },
      { outcome: 'drop', key: 'fixed-defect', refs: [refs[2] as string], title: 'Fixed', reason: 'fixed at the base' },
    ]);
    expect(queued(facts)).toEqual([`${RUN}:review#0`, `${RUN}:review#1`, `${RUN}:review#2`]);
    expect(ok(facts).base).toEqual({ branch: 'dev', sha: fresh });
    const queue = JSON.parse(readFileSync(join(facts.artifacts, 'drain/queue.json'), 'utf8'));
    expect(queue.base).toEqual({ branch: 'dev', sha: fresh });
    const applied = ok(outcome);
    expect(outcome.createdIssues).toEqual([
      expect.objectContaining({ title: 'A new defect', body: expect.stringMatching(/^<!-- archon-discovery new-defect -->\nThe brief\./) }),
    ]);
    expect(outcome.createdIssues[0]?.body).toContain(`verified at ${fresh} by the archon-discoveries workflow`);
    expect(outcome.comments).toEqual([{ issue: 7, body: '<!-- archon-discovery covered-defect -->\nA new reproduction.' }]);
    expect(applied.dropped).toEqual([{ key: 'fixed-defect', reason: 'fixed at the base' }]);
    expect(state(at, `discoveries/runs/${RUN}`)).toEqual({
      version: 1,
      claim: null,
      decided: [`${RUN}:review#0`, `${RUN}:review#1`, `${RUN}:review#2`],
      questions: [],
    });
    expect(ok(script(at, 'facts', { runId: 'pass-2', runs: [RUN] }))).toMatchObject({ path: 'idle' });
  }, 60_000);

  test('filing a key whose issue already exists recovers it by its marker, so nothing is filed twice', () => {
    const at = install();
    runArtifacts(at.outputRoot, RUN, { verdict: [record('new')] });
    const existing: GhIssue = { number: 50, title: 'A defect', body: '<!-- archon-discovery new-defect -->\nThe brief.', state: 'OPEN' };
    const { outcome } = decide(at, { runId: 'pass-2', runs: [RUN], issues: [existing] }, fileIt('new-defect'));
    expect(ok(outcome).written).toEqual([{ key: 'new-defect', outcome: 'file', url: 'https://ghe.example.com/example/repo/issues/50' }]);
    expect(outcome.createdIssues).toEqual([]);
  }, 60_000);

  test('a run drained before runs kept their own memory counts as decided', () => {
    const at = install();
    runArtifacts(at.outputRoot, RUN, { verdict: [record('old')] });
    seed(at, `discoveries/runs/${RUN}`, { version: 1, claim: null });
    expect(ok(script(at, 'facts', { runId: 'pass-1', runs: [RUN] }))).toMatchObject({ path: 'idle' });
  }, 60_000);

  test('facts reads every run document in one state call, not one per run', () => {
    const at = install();
    const ids = Array.from({ length: 4 }, (_, index) => `aaaaaaaa-0000-4000-8000-00000000001${String(index)}`);
    for (const id of ids) {
      runArtifacts(at.outputRoot, id, { verdict: [record('one')] });
      seed(at, `discoveries/runs/${id}`, { version: 1, claim: null, decided: [`${id}:review#0`] });
    }
    const log = join(track(mkdtempSync(join(tmpdir(), 'archon-discoveries-calls-'))), 'calls.jsonl');
    const facts = script(at, 'facts', { runId: 'pass-2', runs: ids }, { ARCHON_CALL_LOG: log });
    expect(ok(facts)).toMatchObject({ path: 'idle' });
    const calls = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line) as string[]);
    expect(calls.filter(argv => argv[0] === 'state')).toEqual([['state', 'list', '--prefix', 'discoveries/runs/', '--values']]);
  }, 60_000);

  test('a refused pass writes nothing: a closed tracking issue, a missing ref', () => {
    const at = install();
    runArtifacts(at.outputRoot, RUN, { verdict: [record('one'), record('two')] });
    const cases: [Pass, (refs: string[]) => AgentDecision[], string][] = [
      [
        { runId: 'pass-1', runs: [RUN], subject: { state: 'closed' } },
        refs => [{ outcome: 'track', key: 'new-key', refs, title: 't', issue: ISSUE, comment: null, reason: 'r' }],
        'which is not open',
      ],
      [
        { runId: 'pass-2', runs: [RUN], statuses: { 'pass-1': 'failed' } },
        refs => [{ outcome: 'drop', key: 'new-key', refs: refs.slice(1), title: 't', reason: 'r' }],
        'has no decision',
      ],
    ];
    for (const [pass, decisions, why] of cases) {
      const { outcome } = decide(at, pass, decisions);
      expect(outcome.code).toBe(1);
      expect(outcome.stderr).toContain(why);
      expect([outcome.createdIssues, outcome.comments]).toEqual([[], []]);
      expect(state(at, `discoveries/runs/${RUN}`)).not.toHaveProperty('decided');
    }
  }, 120_000);

  test('a claim is kept while its run may still finish, and released once it ended', () => {
    const at = install();
    runArtifacts(at.outputRoot, RUN, { verdict: [record('one')] });
    expect(ok(script(at, 'facts', { runId: 'pass-1', runs: [RUN] }))).toMatchObject({ path: 'decide' });
    for (const status of ['paused', 'running']) {
      expect(ok(script(at, 'facts', { runId: 'pass-2', runs: [RUN], statuses: { 'pass-1': status } }))).toMatchObject({ path: 'idle' });
    }
    const released = script(at, 'facts', { runId: 'pass-2', runs: [RUN], statuses: { 'pass-1': 'cancelled' } });
    expect(queued(released)).toEqual([`${RUN}:review#0`]);
    expect(state(at, `discoveries/runs/${RUN}`)).toMatchObject({ claim: { run_id: 'pass-2' } });
  }, 60_000);

  test('limit caps the runs one pass claims, oldest first', () => {
    const at = install();
    const ids = [RUN, 'aaaaaaaa-0000-4000-8000-000000000002'];
    for (const id of ids) runArtifacts(at.outputRoot, id, { verdict: [record('one')] });
    const facts = script(at, 'facts', { runId: 'pass-1', runs: ids }, { INPUTS_LIMIT: '1' });
    expect(queued(facts)).toEqual([`${RUN}:review#0`]);
    expect(state(at, `discoveries/runs/${ids[1]}`)).toBeNull();
  }, 60_000);

  test('an asked record keeps its run claimed by the asking run, and the answer reaches the next pass', () => {
    const at = install();
    runArtifacts(at.outputRoot, RUN, { verdict: [record('unclear'), record('clear')] });
    const { facts, outcome } = decide(at, { runId: 'pass-1', runs: [RUN] }, refs => [
      { outcome: 'ask', key: 'unclear-scope', refs: [refs[0] as string], title: 'Unclear', question: 'In scope?', recommendation: 'Drop it.' },
      { outcome: 'drop', key: 'clear-drop', refs: [refs[1] as string], title: 'Clear', reason: 'fixed' },
    ]);
    expect(ok(outcome)).toMatchObject({ asked: ['unclear-scope'], question: expect.stringContaining('1. unclear-scope: In scope?') });
    expect(state(at, `discoveries/runs/${RUN}`)).toMatchObject({ claim: { run_id: 'pass-1' }, decided: [`${RUN}:review#1`] });
    // While the asking run waits, no pass takes the run and asks again.
    expect(ok(script(at, 'facts', { runId: 'pass-2', runs: [RUN], statuses: { 'pass-1': 'paused' } }))).toMatchObject({ path: 'idle' });

    const queue = { 'drain/queue.json': readFileSync(join(facts.artifacts, 'drain/queue.json'), 'utf8') };
    ok(script(at, 'answer', { runId: 'pass-1', runs: [] }, { INPUTS_KEYS: '["unclear-scope"]', INPUTS_TEXT: 'Out of scope.' }, queue));
    expect(state(at, `discoveries/runs/${RUN}`)).toMatchObject({
      questions: [{ keys: ['unclear-scope'], text: 'In scope?', answer: { text: 'Out of scope.' } }],
    });
    // Once the asking run ended, the next pass decides only the asked record, with the answer beside it.
    const next = script(at, 'facts', { runId: 'pass-3', runs: [RUN], statuses: { 'pass-1': 'completed' } });
    expect(queued(next)).toEqual([`${RUN}:review#0`]);
    expect(readFileSync(join(next.artifacts, 'drain/queue.json'), 'utf8')).toContain('Out of scope.');
  }, 60_000);

  test('an input outside its vocabulary refuses before anything is read', () => {
    const at = install();
    const refused: Record<string, string>[] = [{ INPUTS_SINCE: 'yesterday' }, { INPUTS_LIMIT: '0' }];
    for (const inputs of refused) {
      const result = script(at, 'facts', { runId: 'pass-1', runs: [] }, inputs);
      expect(result.code).toBe(1);
      expect(result.gh).toEqual([]);
    }
    expect(documents(at)).toEqual([]);
  }, 60_000);
});

// --- filing into the Archon tracker a project declares -------------------------------

const BAREA_PROJECT = 'd9f7bb82-5fbc-43d1-aec5-b30006e98182';
const TRACKER = 'http://127.0.0.1:8181';
/** The harness repository, as the remote URL a project file may name it by. */
const REPO_URL = `https://${REPO.host}/${REPO.path}.git`;

function projectFile(at: Install, primary: 'archon' | 'github', githubRepo = REPO_URL): void {
  mkdirSync(join(at.checkout, '.factory'), { recursive: true });
  writeFileSync(
    join(at.checkout, '.factory/project.yaml'),
    `project:\n  name: BAREA\n  archon_project_id: ${BAREA_PROJECT}\n  github_repo: ${githubRepo}\n` +
      `tracker:\n  primary: ${primary}\n  create_github_issue_on_ready: true\n`
  );
}

interface TrackerState {
  readonly tasks: Record<string, unknown>[];
  readonly requests: { method: string; url: string; body: unknown }[];
  readonly down?: boolean;
}

/**
 * A fake tracker behind the script's fetch, holding its tasks and every request in one
 * file. Like the tracker, it lists archived tasks only when asked to, and reads one task
 * back by its id.
 */
function fakeTracker(
  tasks: Record<string, unknown>[] = [],
  down = false,
  /** JavaScript for how the tracker stores a created task; it answers the create with the task as sent. */
  stores = 'task => task'
): { path: string; preload: string; read: () => TrackerState } {
  const path = join(track(mkdtempSync(join(tmpdir(), 'archon-discoveries-tracker-'))), 'tracker.json');
  writeFileSync(path, JSON.stringify({ tasks, requests: [], down }));
  const preload = `
{
  const fs = require('node:fs');
  globalThis.fetch = async (input, init = {}) => {
    const state = JSON.parse(fs.readFileSync(${JSON.stringify(path)}, 'utf8'));
    const url = new URL(String(input));
    const method = init.method ?? 'GET';
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    state.requests.push({ method, url: url.href, body });
    let response;
    if (state.down) {
      response = new Response('tracker unavailable', { status: 503 });
    } else if (method === 'GET' && url.pathname.startsWith('/api/projects/')) {
      const archived = url.searchParams.get('include_archived') === 'true';
      response = Response.json(
        state.tasks.filter(task => url.pathname === '/api/projects/' + task.project_id + '/tasks' && (archived || !task.archived))
      );
    } else if (method === 'POST' && url.pathname === '/api/tasks') {
      const task = { id: 'task-' + String(state.tasks.length + 1), status: 'todo', description: null, archived: false, ...body };
      state.tasks.push((${stores})({ ...task }));
      response = Response.json({ message: 'Task created successfully', task });
    } else if (method === 'GET' && url.pathname.startsWith('/api/tasks/')) {
      const task = state.tasks.find(task => url.pathname === '/api/tasks/' + task.id);
      response = task === undefined ? new Response('{"detail":"Task not found"}', { status: 404 }) : Response.json(task);
    } else {
      response = new Response('not found', { status: 404 });
    }
    fs.writeFileSync(${JSON.stringify(path)}, JSON.stringify(state));
    return response;
  };
}
`;
  return { path, preload, read: () => JSON.parse(readFileSync(path, 'utf8')) as TrackerState };
}

/** A task an earlier pass filed: its marker, then the refs it was filed for when it records them. */
function filedTask(id: string, key: string, refs: string[] | null, archived = false): Record<string, unknown> {
  const lines = [`<!-- archon-discovery ${key} -->`, ...(refs === null ? [] : [`<!-- archon-discovery-refs ${JSON.stringify(refs)} -->`]), 'The brief.'];
  return { id, project_id: BAREA_PROJECT, title: 'A defect', description: lines.join('\n'), status: 'doing', archived };
}

/** gh calls that create an issue: the only issue write a filing makes. */
const issueCreates = (run: ScriptRun): string[] => run.gh.filter(argv => argv.includes('--method POST') && /\/issues( |$)/.test(argv));

const LIST = `GET ${TRACKER}/api/projects/${BAREA_PROJECT}/tasks?include_archived=true`;

// chmod does not deny root, and Windows ignores the mode.
const permissionsApply = process.platform !== 'win32' && process.getuid?.() !== 0;

describe('filing discoveries into the Archon tracker', () => {
  const pass = (runId: string, tracker: { preload: string }, base = TRACKER): Pass => ({
    runId,
    runs: [RUN],
    preload: tracker.preload,
    env: { ARCHON_TRACKER_BASE_URL: base },
  });
  /** The outcome of a pass over the one queued record, run without facts. */
  const outcomeOf = (at: Install, runId: string, tracker: { preload: string }, base = TRACKER): ScriptRun =>
    script(
      at,
      'outcome',
      pass(runId, tracker, base),
      {
        INPUTS_PATH: 'decide',
        INPUTS_TRACKER: 'archon',
        INPUTS_ARCHON_PROJECT_ID: BAREA_PROJECT,
        INPUTS_TRACKER_BASE_URL: `${TRACKER}/`,
        INPUTS_DECISIONS: JSON.stringify(fileIt('new-defect')([`${RUN}:review#0`])),
        INPUTS_SUMMARY: 's',
      },
      { 'drain/queue.json': JSON.stringify({ base: { branch: 'dev', sha: 'abc' }, runs: [] }) }
    );

  test("files each discovery as a todo task in the project's Archon project, and opens no issue", () => {
    const at = install();
    projectFile(at, 'archon');
    const tracker = fakeTracker();
    runArtifacts(at.outputRoot, RUN, { verdict: [record('new')] });
    const { facts, outcome } = decide(at, pass('pass-1', tracker), fileIt('new-defect'));

    expect(ok(facts)).toMatchObject({ path: 'decide', tracker: 'archon', tracker_base_url: `${TRACKER}/` });
    expect(JSON.parse(readFileSync(join(facts.artifacts, 'drain/tasks.json'), 'utf8'))).toEqual([]);
    expect(ok(outcome).written).toEqual([{ key: 'new-defect', outcome: 'file', url: `${TRACKER}/api/tasks/task-1` }]);
    const { requests } = tracker.read();
    expect(requests.map(request => `${request.method} ${request.url}`)).toEqual([
      LIST,
      LIST,
      `POST ${TRACKER}/api/tasks`,
      `GET ${TRACKER}/api/tasks/task-1`,
    ]);
    expect(requests[2]?.body).toEqual({
      title: 'A new defect',
      description: expect.stringMatching(
        new RegExp(`^<!-- archon-discovery new-defect -->\\n<!-- archon-discovery-refs \\["${RUN}:review#0"\\] -->\\nThe brief\\.\\n\\n---\\nFound by Archon run `)
      ),
      status: 'todo',
      project_id: BAREA_PROJECT,
    });
    expect([outcome.createdIssues, issueCreates(outcome)]).toEqual([[], []]);
    expect(state(at, `discoveries/runs/${RUN}`)).toMatchObject({ claim: null, decided: [`${RUN}:review#0`] });
  }, 60_000);

  test('facts hands the agent every task an earlier pass filed, archived ones included', () => {
    const at = install();
    projectFile(at, 'archon');
    const tracker = fakeTracker([
      filedTask('task-7', 'old-defect', ['other-run:review#0'], true),
      { ...filedTask('task-8', 'x-y-z', null), description: 'a task a person wrote' },
    ]);
    runArtifacts(at.outputRoot, RUN, { verdict: [record('new')] });
    const facts = script(at, 'facts', pass('pass-1', tracker));

    expect(ok(facts)).toMatchObject({ tracker: 'archon' });
    expect(JSON.parse(readFileSync(join(facts.artifacts, 'drain/tasks.json'), 'utf8'))).toEqual([
      {
        key: 'old-defect',
        refs: ['other-run:review#0'],
        url: `${TRACKER}/api/tasks/task-7`,
        title: 'A defect',
        status: 'doing',
        archived: true,
        description: expect.stringContaining('The brief.'),
      },
    ]);
  }, 60_000);

  test.each([
    ['carries the same key', 'new-defect', false, false],
    ['carries the same key and is archived', 'new-defect', false, true],
    ['was filed for the same ref under the key an earlier pass chose', 'earlier-key', true, false],
    ['was filed for the same ref and is archived', 'earlier-key', true, true],
  ])('a filing whose task %s recovers that task, so a rerun creates nothing', (_case, key, byRef, archived) => {
    const at = install();
    projectFile(at, 'archon');
    const existing = filedTask('task-7', key, byRef ? [`${RUN}:review#0`] : null, archived);
    const tracker = fakeTracker([existing]);
    runArtifacts(at.outputRoot, RUN, { verdict: [record('new')] });
    const { outcome } = decide(at, pass('pass-2', tracker), fileIt('new-defect'));

    expect(ok(outcome).written).toEqual([{ key: 'new-defect', outcome: 'file', url: `${TRACKER}/api/tasks/task-7` }]);
    expect(tracker.read().requests.map(request => request.method)).toEqual(['GET', 'GET']);
    expect(tracker.read().tasks).toEqual([existing]);
    expect([outcome.createdIssues, issueCreates(outcome)]).toEqual([[], []]);
  }, 60_000);

  test('a pass that stopped after creating a task, run again with a new key for the same record, creates no second task', () => {
    const at = install();
    projectFile(at, 'archon');
    const tracker = fakeTracker();
    runArtifacts(at.outputRoot, RUN, { verdict: [record('new')] });
    // The first pass files the task, then stops before its state write: here its outcome
    // runs under another id than the one holding the claim.
    const facts = script(at, 'facts', pass('pass-1', tracker));
    const first = outcomeAfter(at, pass('pass-0', tracker), facts, fileIt('first-key'));
    expect(first.stderr).toContain('is no longer claimed by this run');
    expect(tracker.read().tasks.map(task => task.id)).toEqual(['task-1']);
    const rerun = decide(at, { ...pass('pass-2', tracker), statuses: { 'pass-1': 'failed' } }, fileIt('second-key'));

    expect(queued(rerun.facts)).toEqual([`${RUN}:review#0`]);
    expect(ok(rerun.outcome).written).toEqual([{ key: 'second-key', outcome: 'file', url: `${TRACKER}/api/tasks/task-1` }]);
    expect(tracker.read().tasks.map(task => task.id)).toEqual(['task-1']);
  }, 60_000);

  const REFS = `<!-- archon-discovery-refs ["${RUN}:review#0"] -->`;
  test.each([
    ['the marker has a leading space', [' <!-- archon-discovery earlier-key -->', REFS]],
    ['the marker lacks its space', ['<!--archon-discovery earlier-key -->', REFS]],
    ['a blank line precedes the metadata', ['', '<!-- archon-discovery earlier-key -->', REFS]],
    ['the marker line does not close', ['<!-- archon-discovery earlier-key']],
    ['the key is not a decision key', ['<!-- archon-discovery Earlier_Key -->', REFS]],
    ['the refs line does not close', ['<!-- archon-discovery earlier-key -->', `<!-- archon-discovery-refs ["${RUN}:review#0"]`]],
    ['the refs line is not JSON', ['<!-- archon-discovery earlier-key -->', `<!-- archon-discovery-refs [${RUN}:review#0 -->`]],
    ['a ref is not qualified', ['<!-- archon-discovery earlier-key -->', '<!-- archon-discovery-refs ["review#0"] -->']],
    ['a ref is not a string', ['<!-- archon-discovery earlier-key -->', '<!-- archon-discovery-refs [7] -->']],
    ['the refs line lists no refs', ['<!-- archon-discovery earlier-key -->', '<!-- archon-discovery-refs [] -->']],
  ])('a filed task whose metadata is corrupt (%s) refuses the pass, and no second task is created', (_case, lines) => {
    const at = install();
    projectFile(at, 'archon');
    const corrupt = { ...filedTask('task-7', 'earlier-key', null), description: [...lines, 'The brief.'].join('\n') };
    const tracker = fakeTracker([corrupt]);
    runArtifacts(at.outputRoot, RUN, { verdict: [record('new')] });
    const facts = script(at, 'facts', pass('pass-1', tracker));
    const outcome = outcomeOf(at, 'pass-1', tracker);

    for (const run of [facts, outcome]) {
      expect(run.code).toBe(1);
      expect(run.stderr).toContain('task task-7 carries corrupt archon-discovery metadata');
      expect([run.createdIssues, issueCreates(run)]).toEqual([[], []]);
    }
    expect(tracker.read().requests.map(request => request.method)).toEqual(['GET', 'GET']);
    expect(tracker.read().tasks).toEqual([corrupt]);
    expect(state(at, `discoveries/runs/${RUN}`)).toBeNull();
  }, 60_000);

  test.each([
    ['strips HTML comments', "task => ({ ...task, description: task.description.replace(/<!--[^]*?-->\\n?/g, '') })", 'description', false],
    ['truncates the description', 'task => ({ ...task, description: task.description.slice(0, 30) })', 'description', false],
    ['alters the title', "task => ({ ...task, title: task.title + ' (imported)' })", 'title', true],
    ['alters the status', "task => ({ ...task, status: 'backlog' })", 'status', true],
  ])('a tracker that %s on create fails the filing instead of reporting it', (_case, stores, field, recoverable) => {
    const at = install();
    projectFile(at, 'archon');
    const tracker = fakeTracker([], false, stores);
    runArtifacts(at.outputRoot, RUN, { verdict: [record('new')] });
    const { facts, outcome } = decide(at, pass('pass-1', tracker), fileIt('new-defect'));

    expect(outcome.code).toBe(1);
    expect(outcome.stderr).toContain(
      `the tracker created task task-1 but reads back a different ${field} than was sent, so it is not reported as filed`
    );
    expect(outcome.stdout).toBe('');
    expect(tracker.read().requests.map(request => request.method)).toEqual(['GET', 'GET', 'POST', 'GET']);
    expect([outcome.createdIssues, issueCreates(outcome)]).toEqual([[], []]);
    expect(state(at, `discoveries/runs/${RUN}`)).toMatchObject({ claim: { run_id: 'pass-1' } });

    // As the refusal says: a task whose header survived is recovered as filed by the next try.
    const again = outcomeAfter(at, pass('pass-1', tracker), facts, fileIt('new-defect'));
    expect(again.code === 0).toBe(recoverable);
    if (recoverable) {
      expect(ok(again).written).toEqual([{ key: 'new-defect', outcome: 'file', url: `${TRACKER}/api/tasks/task-1` }]);
      expect(tracker.read().requests.filter(request => request.method === 'POST')).toHaveLength(1);
    }
  }, 60_000);

  test.each([
    ['discovery metadata, which would leave its task unreadable to the next pass', 'Quotes <!--archon-discovery old -->.', 'archon-discovery'],
    ["project intake's marker, which would stop every later intake of the project", 'Quotes <!-- archon-project-intake part-lot-link -->.', 'archon-project-intake'],
  ])('refuses before any write a brief holding %s', (_case, body, family) => {
    const at = install();
    projectFile(at, 'archon');
    const tracker = fakeTracker();
    runArtifacts(at.outputRoot, RUN, { verdict: [record('new')] });
    const { outcome } = decide(at, pass('pass-1', tracker), refs => [
      { outcome: 'file', key: 'new-defect', refs, title: 'A defect', body, reason: 'real' },
    ]);

    expect(outcome.code).toBe(1);
    expect(outcome.stderr).toContain(`key new-defect's body holds ${family} metadata`);
    expect(tracker.read().requests.map(request => request.method)).toEqual(['GET', 'GET']);
    expect(tracker.read().tasks).toEqual([]);
  }, 60_000);

  const OTHER_PROJECT = '0b5c5f5e-8f63-4c55-9a43-3a3c1f0b9e21';
  test.each([
    ['now keeps its work on GitHub', (at: Install) => projectFile(at, 'github'), 'GitHub issues'],
    ['no longer has a project file', (at: Install) => rmSync(join(at.checkout, '.factory'), { recursive: true }), 'GitHub issues'],
    [
      'now names another tracker project',
      (at: Install) => {
        const file = join(at.checkout, '.factory/project.yaml');
        writeFileSync(file, readFileSync(file, 'utf8').replace(BAREA_PROJECT, OTHER_PROJECT));
      },
      `Archon tracker project ${OTHER_PROJECT} at ${TRACKER}/`,
    ],
  ])('an outcome resumed after the project %s refuses rather than filing elsewhere', (_case, change, now) => {
    const at = install();
    projectFile(at, 'archon');
    const tracker = fakeTracker();
    runArtifacts(at.outputRoot, RUN, { verdict: [record('new')] });
    const facts = script(at, 'facts', pass('pass-1', tracker));
    expect(ok(facts)).toMatchObject({ tracker: 'archon', archon_project_id: BAREA_PROJECT });
    change(at);
    const outcome = outcomeAfter(at, pass('pass-1', tracker), facts, fileIt('new-defect'));

    expect(outcome.code).toBe(1);
    expect(outcome.stderr).toContain(
      `facts chose Archon tracker project ${BAREA_PROJECT} at ${TRACKER}/ for this pass, but the checkout now files into ${now}`
    );
    expect([outcome.createdIssues, issueCreates(outcome)]).toEqual([[], []]);
    expect(tracker.read().requests.map(request => request.method)).toEqual(['GET']);
    expect(state(at, `discoveries/runs/${RUN}`)).toMatchObject({ claim: { run_id: 'pass-1' } });
  }, 60_000);

  const OTHER_TRACKER = 'http://tracker-b.example:9191';
  test('an outcome resumed after ARCHON_TRACKER_BASE_URL moved to another tracker refuses before reading or writing it', () => {
    const at = install();
    projectFile(at, 'archon');
    const tracker = fakeTracker();
    runArtifacts(at.outputRoot, RUN, { verdict: [record('new')] });
    const facts = script(at, 'facts', pass('pass-1', tracker));
    expect(ok(facts)).toMatchObject({ tracker: 'archon', archon_project_id: BAREA_PROJECT, tracker_base_url: `${TRACKER}/` });
    const outcome = outcomeAfter(at, pass('pass-1', tracker, OTHER_TRACKER), facts, fileIt('new-defect'));

    expect(outcome.code).toBe(1);
    expect(outcome.stderr).toContain(
      `facts chose Archon tracker project ${BAREA_PROJECT} at ${TRACKER}/ for this pass, but the checkout now files into Archon tracker project ${BAREA_PROJECT} at ${OTHER_TRACKER}/`
    );
    expect(tracker.read().requests.map(request => `${request.method} ${request.url}`)).toEqual([LIST]);
    expect([outcome.createdIssues, issueCreates(outcome)]).toEqual([[], []]);
    expect(state(at, `discoveries/runs/${RUN}`)).toMatchObject({ claim: { run_id: 'pass-1' } });
  }, 60_000);

  test('an outcome resumed with ARCHON_TRACKER_BASE_URL spelled differently for the same tracker files there', () => {
    const at = install();
    projectFile(at, 'archon');
    const tracker = fakeTracker();
    runArtifacts(at.outputRoot, RUN, { verdict: [record('new')] });
    const facts = script(at, 'facts', pass('pass-1', tracker));
    const outcome = outcomeAfter(at, pass('pass-1', tracker, ` ${TRACKER}/ `), facts, fileIt('new-defect'));

    expect(ok(outcome).written).toEqual([{ key: 'new-defect', outcome: 'file', url: `${TRACKER}/api/tasks/task-1` }]);
    expect(tracker.read().requests.every(request => request.url.startsWith(`${TRACKER}/`))).toBe(true);
  }, 60_000);

  test('an outcome resumed after the project moved to the Archon tracker refuses rather than filing a task the agent never searched for', () => {
    const at = install();
    const tracker = fakeTracker();
    runArtifacts(at.outputRoot, RUN, { verdict: [record('new')] });
    const facts = script(at, 'facts', pass('pass-1', tracker));
    expect(ok(facts)).toMatchObject({ tracker: 'github', archon_project_id: '' });
    projectFile(at, 'archon');
    const outcome = outcomeAfter(at, pass('pass-1', tracker), facts, fileIt('new-defect'));

    expect(outcome.code).toBe(1);
    expect(outcome.stderr).toContain(
      `facts chose GitHub issues for this pass, but the checkout now files into Archon tracker project ${BAREA_PROJECT} at ${TRACKER}/`
    );
    expect([outcome.createdIssues, issueCreates(outcome)]).toEqual([[], []]);
    expect(tracker.read().requests).toEqual([]);
  }, 60_000);

  test.each([
    ['archon', '', `${TRACKER}/`],
    ['archon', BAREA_PROJECT, ''],
    ['archon', BAREA_PROJECT, 'http://user:S3CRET@127.0.0.1:8181/'],
    ['github', BAREA_PROJECT, ''],
    ['github', '', `${TRACKER}/`],
    ['', '', ''],
  ])('an outcome bound to tracker "%s", project "%s" and base URL "%s" refuses before reading anything', (trackerInput, projectInput, baseInput) => {
    const at = install();
    projectFile(at, 'archon');
    const tracker = fakeTracker();
    const outcome = script(
      at,
      'outcome',
      pass('pass-1', tracker),
      {
        INPUTS_PATH: 'decide',
        INPUTS_TRACKER: trackerInput,
        INPUTS_ARCHON_PROJECT_ID: projectInput,
        INPUTS_TRACKER_BASE_URL: baseInput,
        INPUTS_DECISIONS: JSON.stringify(fileIt('new-defect')([`${RUN}:review#0`])),
        INPUTS_SUMMARY: 's',
      },
      { 'drain/queue.json': JSON.stringify({ base: { branch: 'dev', sha: 'abc' }, runs: [] }) }
    );
    expect(outcome.code).toBe(1);
    expect(outcome.stderr).toContain('is not a filing target');
    expect(`${outcome.stdout}${outcome.stderr}`).not.toContain('S3CRET');
    expect([outcome.createdIssues, issueCreates(outcome)]).toEqual([[], []]);
    expect(tracker.read().requests).toEqual([]);
  }, 60_000);

  test('refuses before any write: a filing two tasks match, and a track on GitHub', () => {
    const at = install();
    projectFile(at, 'archon');
    const tracker = fakeTracker([filedTask('task-7', 'new-defect', null), filedTask('task-8', 'other-key', ['x:y', `${RUN}:review#0`])]);
    runArtifacts(at.outputRoot, RUN, { verdict: [record('one'), record('two')] });
    const { outcome } = decide(at, pass('pass-1', tracker), refs => [
      { outcome: 'file', key: 'new-defect', refs: [refs[0] as string], title: 'A defect', body: 'The brief.', reason: 'real' },
      { outcome: 'track', key: 'covered-defect', refs: [refs[1] as string], title: 'Covered', issue: ISSUE, comment: 'More.', reason: 'covers it' },
    ]);

    expect(outcome.code).toBe(1);
    expect(outcome.stderr).toContain('key new-defect and its refs match more than one tracker task (task-7, task-8)');
    expect(outcome.stderr).toContain('key covered-defect is tracked on a GitHub issue, but this project files discoveries into the Archon tracker');
    expect(tracker.read().requests.map(request => request.method)).toEqual(['GET', 'GET']);
    expect([outcome.createdIssues, outcome.comments, issueCreates(outcome)]).toEqual([[], [], []]);
  }, 60_000);

  test.each([
    ['the tracker fails', TRACKER, true, /503: tracker unavailable/],
    ['ARCHON_TRACKER_BASE_URL is unset', '', false, /ARCHON_TRACKER_BASE_URL is not set/],
    ['ARCHON_TRACKER_BASE_URL is malformed and carries a secret', 'htps://user:S3CRET@tracker', false, /must be an http or https URL/],
    ['ARCHON_TRACKER_BASE_URL does not parse and carries a secret', 'http://user:S3CRET@[tracker', false, /is not a URL/],
    ['ARCHON_TRACKER_BASE_URL carries credentials', 'http://user:S3CRET@127.0.0.1:8181', false, /must not carry credentials/],
  ])('when %s, facts stops before claiming anything and the outcome opens no issue in its place', (_case, base, down, why) => {
    const at = install();
    projectFile(at, 'archon');
    const tracker = fakeTracker([], down);
    runArtifacts(at.outputRoot, RUN, { verdict: [record('new')] });
    const facts = script(at, 'facts', pass('pass-1', tracker, base));
    expect(facts.code).toBe(1);
    expect(facts.stderr).toMatch(why);
    expect(state(at, `discoveries/runs/${RUN}`)).toBeNull();

    const outcome = outcomeOf(at, 'pass-1', tracker, base);
    expect(outcome.code).toBe(1);
    expect(outcome.stderr).toMatch(why);
    for (const run of [facts, outcome]) expect(`${run.stdout}${run.stderr}`).not.toContain('S3CRET');
    expect([outcome.createdIssues, issueCreates(outcome)]).toEqual([[], []]);
    expect(tracker.read().tasks).toEqual([]);
  }, 60_000);

  test.skipIf(!permissionsApply).each([
    ['an unreadable .factory directory', '.factory', 0o755, /could not be read \(EACCES\)/],
    ['an unreadable project file', '.factory/project.yaml', 0o644, /could not be read \(EACCES\)/],
  ])('%s stops the pass before any write, and never files on GitHub instead', (_case, locked, mode, why) => {
    const at = install();
    projectFile(at, 'archon');
    const tracker = fakeTracker();
    runArtifacts(at.outputRoot, RUN, { verdict: [record('new')] });
    chmodSync(join(at.checkout, locked), 0o000);
    let runs: ScriptRun[];
    try {
      runs = [script(at, 'facts', pass('pass-1', tracker)), outcomeOf(at, 'pass-1', tracker)];
    } finally {
      chmodSync(join(at.checkout, locked), mode);
    }
    for (const run of runs) {
      expect(run.code).toBe(1);
      expect(run.stderr).toMatch(why);
      expect([run.createdIssues, issueCreates(run)]).toEqual([[], []]);
    }
    expect(tracker.read().requests).toEqual([]);
    expect(state(at, `discoveries/runs/${RUN}`)).toBeNull();
  }, 60_000);

  test.each([
    ['a project file that is not YAML', 'project: [\n', /is not valid YAML/],
    ['a project file for another repository', null, /is github\.com\/rahajri\/BAREA's, not ghe\.example\.com\/example\/repo's/],
  ])('%s stops the pass before any write, and never files on GitHub instead', (_case, yaml, why) => {
    const at = install();
    projectFile(at, 'archon', 'rahajri/BAREA');
    if (yaml !== null) writeFileSync(join(at.checkout, '.factory/project.yaml'), yaml);
    const tracker = fakeTracker();
    runArtifacts(at.outputRoot, RUN, { verdict: [record('new')] });
    for (const run of [script(at, 'facts', pass('pass-1', tracker)), outcomeOf(at, 'pass-1', tracker)]) {
      expect(run.code).toBe(1);
      expect(run.stderr).toMatch(why);
      expect([run.createdIssues, issueCreates(run)]).toEqual([[], []]);
    }
    expect(tracker.read().requests).toEqual([]);
    expect(state(at, `discoveries/runs/${RUN}`)).toBeNull();
  }, 60_000);

  test('a project whose tracker is github files the issue as before and never calls the tracker', () => {
    const at = install();
    projectFile(at, 'github');
    const tracker = fakeTracker();
    runArtifacts(at.outputRoot, RUN, { verdict: [record('new')] });
    const { facts, outcome } = decide(at, pass('pass-1', tracker), fileIt('new-defect'));

    expect(ok(facts)).toMatchObject({ tracker: 'github', archon_project_id: '', tracker_base_url: '' });
    ok(outcome);
    expect(outcome.createdIssues).toEqual([
      expect.objectContaining({ title: 'A new defect', body: expect.stringMatching(/^<!-- archon-discovery new-defect -->\nThe brief\./) }),
    ]);
    expect(tracker.read().requests).toEqual([]);
  }, 60_000);

  test('a checkout with no project file files the issue as before, with no tracker configured at all', () => {
    const at = install();
    const tracker = fakeTracker();
    runArtifacts(at.outputRoot, RUN, { verdict: [record('new')] });
    const { facts, outcome } = decide(at, { runId: 'pass-1', runs: [RUN], preload: tracker.preload }, fileIt('new-defect'));

    expect(ok(facts)).toMatchObject({ tracker: 'github', archon_project_id: '', tracker_base_url: '' });
    expect(existsSync(join(facts.artifacts, 'drain/tasks.json'))).toBe(false);
    ok(outcome);
    expect(outcome.createdIssues).toEqual([
      expect.objectContaining({ title: 'A new defect', body: expect.stringMatching(/^<!-- archon-discovery new-defect -->\nThe brief\./) }),
    ]);
    expect(tracker.read().requests).toEqual([]);
  }, 60_000);
});

describe('the discoveries workflow', () => {
  test('the pack ships no trigger binding: it runs only when started by hand or by a binding an operator adds', () => {
    const files = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
        entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)]
      );
    const binding = files(PACK).filter(
      path => !path.endsWith('.md') && /"bindingId"|intervalSeconds|bindingId:/.test(readFileSync(path, 'utf8'))
    );
    expect(binding).toEqual([]);
  });
});
