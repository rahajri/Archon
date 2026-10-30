/**
 * The discoveries workflow's state: one document per drained run.
 *
 * `discoveries/runs/<run-id>` is that run's memory and its claim. `decided` lists the
 * refs a pass decided for it, whatever the outcome, so a later pass does not queue them
 * again; `questions` holds what a pass asked a maintainer about it, with the answer once
 * there is one, so the next pass decides those refs from it. A run's claim is held while
 * a pass works it, and while one of its questions waits.
 *
 * There is no store of decisions across runs. A defect a later run finds again is judged
 * again, against the tracker: a filed issue or task carries the key's marker, so filing
 * the same key twice recovers it instead of opening another. A task also records the refs
 * it was filed for, so a pass that decides those refs again recovers it whatever key the
 * agent gives it this time.
 */

import type { ArchonTask } from './archon-tracker.ts';
import type { QualifiedPr } from './forge.ts';
import type { fetchDefaultBranch } from './remote.ts';
import type { DiscoveryRecord } from './report.ts';
import { isObject } from './typed.ts';

export const RUNS_PREFIX = 'discoveries/runs/';
const KEY = /^[a-z0-9][a-z0-9-]{2,80}$/;

export type IssueRef = QualifiedPr;

export interface Question {
  /** The keys of the asked decisions this question covers. */
  readonly keys: readonly string[];
  readonly refs: readonly string[];
  readonly text: string;
  readonly recommendation: string;
  readonly answer: { readonly text: string; readonly at: string } | null;
}

export interface RunDocument {
  readonly version: 1;
  readonly claim: { readonly run_id: string; readonly at: string } | null;
  /**
   * The refs a pass decided for this run. A document without it was drained before
   * runs carried their own memory, and all of its records count as decided.
   */
  readonly decided?: readonly string[];
  readonly questions?: readonly Question[];
}

export function isKey(value: unknown): value is string {
  return typeof value === 'string' && KEY.test(value);
}

export function runName(runId: string): string {
  return `${RUNS_PREFIX}${runId}`;
}

function isQualifiedRef(ref: unknown): ref is string {
  return typeof ref === 'string' && ref.indexOf(':') > 0;
}

/** The run a qualified ref belongs to. */
export function refRun(ref: string): string {
  if (!isQualifiedRef(ref)) throw new Error(`"${ref}" is not a qualified discovery ref`);
  return ref.slice(0, ref.indexOf(':'));
}

function text(value: unknown): value is string {
  return typeof value === 'string';
}

function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(text);
}

function question(value: unknown): Question | undefined {
  if (!isObject(value) || !strings(value.keys) || !strings(value.refs) || !text(value.text) || !text(value.recommendation)) {
    return undefined;
  }
  const answer = value.answer;
  if (answer !== null && !(isObject(answer) && text(answer.text) && text(answer.at))) return undefined;
  return {
    keys: value.keys,
    refs: value.refs,
    text: value.text,
    recommendation: value.recommendation,
    answer: answer === null ? null : { text: answer.text as string, at: answer.at as string },
  };
}

function claimOf(value: unknown): RunDocument['claim'] | undefined {
  if (value === null) return null;
  return isObject(value) && text(value.run_id) && text(value.at) ? { run_id: value.run_id, at: value.at } : undefined;
}

/** The questions field: absent, or every entry a question; undefined when it is neither. */
function questionsOf(value: unknown): { questions?: Question[] } | undefined {
  if (value === undefined) return {};
  if (!Array.isArray(value)) return undefined;
  const questions = value.map(question);
  return questions.every(entry => entry !== undefined) ? { questions: questions as Question[] } : undefined;
}

/** A drained run's document; null when there is none yet. */
export function parseRunDocument(name: string, value: unknown): RunDocument | null {
  if (value === null) return null;
  const claim = isObject(value) && value.version === 1 ? claimOf(value.claim) : undefined;
  const questions = isObject(value) ? questionsOf(value.questions) : undefined;
  const decided = isObject(value) ? value.decided : undefined;
  if (claim === undefined || questions === undefined || (decided !== undefined && !strings(decided))) {
    throw new Error(`${name} is not a drained-run document`);
  }
  return { version: 1, claim, ...(decided === undefined ? {} : { decided }), ...questions };
}

// --- one pass -------------------------------------------------------------------

/** One queued run and its undecided records, each ref qualified as `<run-id>:<ref>`. */
export interface QueuedRun {
  readonly id: string;
  readonly workflow: string;
  readonly completed_at: string;
  readonly artifacts: string;
  readonly records: readonly DiscoveryRecord[];
  /** What earlier passes asked about this run, with any answer; the agent decides from it. */
  readonly questions: readonly Question[];
}

export interface Queue {
  readonly base: ReturnType<typeof fetchDefaultBranch>;
  readonly runs: readonly QueuedRun[];
}

/** The deciding agent's outcomes; the decide node's output schema must admit exactly these. */
export const AGENT_OUTCOMES = ['file', 'track', 'drop', 'ask'] as const;

/** What the deciding agent declared for one discovery, as its output schema admits it. */
export type AgentDecision = {
  readonly key: string;
  readonly refs: readonly string[];
  readonly title: string;
} & (
  | { readonly outcome: 'file'; readonly body: string; readonly reason: string }
  | {
      readonly outcome: 'track';
      readonly issue: IssueRef;
      /** Evidence the issue does not hold yet; null posts nothing. */
      readonly comment: string | null;
      readonly reason: string;
    }
  | { readonly outcome: 'drop'; readonly reason: string }
  | { readonly outcome: 'ask'; readonly question: string; readonly recommendation: string }
);

/**
 * The exact checks before any write: every queued ref is decided exactly once, by a
 * decision whose key is valid and used once. Returns every violation; an empty list
 * passes. Filing a key twice is safe: the issue's marker recovers it.
 */
export function checkDecisions(queued: readonly string[], decisions: readonly AgentDecision[]): string[] {
  const problems: string[] = [];
  const seen = new Map<string, string>();
  const keys = new Set<string>();
  for (const decision of decisions) {
    if (!isKey(decision.key)) problems.push(`"${decision.key}" is not a valid key`);
    if (keys.has(decision.key)) problems.push(`key ${decision.key} is decided more than once`);
    keys.add(decision.key);
    if (decision.refs.length === 0) problems.push(`key ${decision.key} names no ref`);
    for (const ref of decision.refs) {
      const earlier = seen.get(ref);
      if (earlier !== undefined) problems.push(`${ref} is decided under both ${earlier} and ${decision.key}`);
      seen.set(ref, decision.key);
      if (!queued.includes(ref)) problems.push(`${ref} (key ${decision.key}) is not a queued ref`);
    }
  }
  for (const ref of queued) if (!seen.has(ref)) problems.push(`${ref} has no decision`);
  return problems;
}

/**
 * Where a pass files: GitHub issues, or tasks in one Archon tracker project. `facts`
 * chooses it and carries it on its output, so the outcome, a resumed one too, files
 * where the agent searched.
 */
export type FilingTarget =
  | { readonly tracker: 'github'; readonly archon_project_id: '' }
  | { readonly tracker: 'archon'; readonly archon_project_id: string };

export function parseFilingTarget(tracker: string, archonProjectId: string): FilingTarget {
  if (tracker === 'github' && archonProjectId === '') return { tracker, archon_project_id: '' };
  if (tracker === 'archon' && archonProjectId !== '') return { tracker, archon_project_id: archonProjectId };
  throw new Error(`"${tracker}" with Archon project "${archonProjectId}" is not a filing target`);
}

export function describeFilingTarget(target: FilingTarget): string {
  return target.tracker === 'github' ? 'GitHub issues' : `Archon tracker project ${target.archon_project_id}`;
}

const MARKER_OPEN = '<!-- archon-discovery ';
const REFS_OPEN = '<!-- archon-discovery-refs ';
const COMMENT_CLOSE = ' -->';

/** The marker on a filed issue's or task's first line, and on an evidence comment's. */
export function discoveryMarker(key: string): string {
  if (!isKey(key)) throw new Error(`"${key}" is not a decision key`);
  return `${MARKER_OPEN}${key}${COMMENT_CLOSE}`;
}

/** The line after a filed task's marker: the queued refs it was filed for. `>` is escaped so no ref closes the comment. */
export function discoveryRefsLine(refs: readonly string[]): string {
  return `${REFS_OPEN}${JSON.stringify(refs).replaceAll('>', '\\u003e')}${COMMENT_CLOSE}`;
}

/** A tracker task this workflow filed: its marker's key and the refs it was filed for. */
export interface FiledDiscovery {
  readonly key: string;
  /** Empty for a task filed before tasks recorded their refs. */
  readonly refs: readonly string[];
  readonly task: ArchonTask;
}

/**
 * The payload of a metadata comment line opening with `open`, null when the line is not
 * one. A line that opens like one but does not close is corrupt, never "not one": read as
 * absent, a task's marker or refs would stop matching and the pass would file it again.
 */
function metadata(line: string, open: string, task: ArchonTask): string | null {
  if (!line.startsWith(open.trimEnd())) return null;
  if (!line.startsWith(open) || !line.endsWith(COMMENT_CLOSE)) {
    throw new Error(`task ${task.id} carries a corrupt ${open.trim()} line`);
  }
  return line.slice(open.length, -COMMENT_CLOSE.length);
}

/**
 * The tasks a discoveries pass filed, by the marker on their description's first line.
 * A task whose marker or refs line is corrupt refuses the read rather than matching nothing.
 */
export function filedDiscoveries(tasks: readonly ArchonTask[]): FiledDiscovery[] {
  return tasks.flatMap(task => {
    const [first = '', second = ''] = (task.description ?? '').split(/\r?\n/, 2);
    const key = metadata(first, MARKER_OPEN, task);
    if (key === null) return [];
    if (!isKey(key)) throw new Error(`task ${task.id} carries a discovery marker whose key is not a decision key`);
    const refs = metadata(second, REFS_OPEN, task);
    if (refs === null) return [{ key, refs: [], task }];
    let parsed: unknown;
    try {
      parsed = JSON.parse(refs);
    } catch {
      parsed = undefined;
    }
    if (!Array.isArray(parsed) || parsed.length === 0 || !parsed.every(isQualifiedRef)) {
      throw new Error(`task ${task.id} carries a discovery refs line that is not a list of refs`);
    }
    return [{ key, refs: parsed, task }];
  });
}

/**
 * The filed tasks a `file` decision is: the one carrying its key's marker, and any filed
 * for one of its refs. More than one is a conflict for the caller to refuse.
 */
export function filingsOf(filed: readonly FiledDiscovery[], decision: { key: string; refs: readonly string[] }): FiledDiscovery[] {
  return filed.filter(entry => entry.key === decision.key || entry.refs.some(ref => decision.refs.includes(ref)));
}
