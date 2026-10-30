/**
 * Perform the writes the deciding agent declared, and nothing else.
 *
 * Every check runs before the first write: each queued ref is decided exactly once, and
 * an issue a discovery is tracked by reads back open in the repository. Then the public
 * writes: a filing creates or recovers its issue by the key's marker, and an evidence
 * comment is upserted by the same marker, so a pass that stops anywhere and is run
 * again never files or comments twice. A checkout whose `.factory/project.yaml` names
 * the Archon tracker as primary files each discovery as a task in that project instead,
 * recovered by its key's marker or by any of its refs, archived tasks included; it never
 * falls back to an issue, and refuses a `track`, which would write to GitHub. Last, each
 * run's document records the refs this pass decided and the questions it asked, and its
 * claim is released, except on a run with an asked record: it stays claimed by this run
 * until the question is answered and the run ends.
 *
 * The filing target is the one facts chose for this pass, not the checkout's project and
 * environment as they read now: the agent searched that target, and a resumed pass reruns
 * only this node. A project that no longer declares that target, or an
 * ARCHON_TRACKER_BASE_URL that now names another tracker, refuses the pass before any
 * write rather than filing into a tracker the agent never searched.
 *
 * Bound inputs: INPUTS_PATH, INPUTS_TRACKER, INPUTS_ARCHON_PROJECT_ID and
 * INPUTS_TRACKER_BASE_URL from facts;
 * INPUTS_DECISIONS and INPUTS_SUMMARY from the agent, `null` when it did not run; the
 * workflow's INPUTS_REPO_HOST and INPUTS_REPO_PATH.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type ArchonTracker, declaredArchonTracker, type NewArchonTask } from '../../.shared/archon-tracker.ts';
import {
  type AgentDecision,
  checkDecisions,
  describeFilingTarget,
  discoveryMarker,
  discoveryRefsLine,
  type FiledDiscovery,
  type FilingTarget,
  filedDiscoveries,
  filingsOf,
  filingTargetOf,
  mentionsDiscoveryMetadata,
  parseFilingTarget,
  parseRunDocument,
  type Question,
  type Queue,
  refRun,
  runName,
  sameFilingTarget,
} from '../../.shared/discoveries.ts';
import { forgeSource, type QualifiedPr, sameRepo } from '../../.shared/forge.ts';
import { artifactsDir, emit, nullableJson, refuse, text, trimmed } from '../../.shared/io.ts';
import { createIssue, viewIssue } from '../../.shared/issue.ts';
import { upsertComment } from '../../.shared/pr.ts';
import { stateGet, statePut } from '../../.shared/state.ts';

const IDLE = 'No finished run has undecided discoveries.';

function issueUrl(issue: { repo: { host: string; path: string }; number: number }): string {
  return `https://${issue.repo.host}/${issue.repo.path}/issues/${String(issue.number)}`;
}

/**
 * The body a filing carries: the marker, the refs it was filed for when it is a tracker
 * task, the agent's brief, then where it came from.
 */
function filingBody(decision: AgentDecision & { outcome: 'file' }, sha: string, task: boolean): string {
  const runs = [...new Set(decision.refs.map(refRun))];
  return [
    discoveryMarker(decision.key),
    ...(task ? [discoveryRefsLine(decision.refs)] : []),
    decision.body.trim(),
    '',
    '---',
    `Found by Archon run${runs.length === 1 ? '' : 's'} ${runs.join(', ')} and verified at ${sha} by the archon-discoveries workflow.`,
  ].join('\n');
}

function newTask(decision: AgentDecision & { outcome: 'file' }, sha: string): NewArchonTask {
  return { title: decision.title, description: filingBody(decision, sha, true), status: 'todo' };
}

/**
 * The tracker task each filing recovers instead of creating one, by key: the task that
 * carries its key's marker or any of its refs. A filing two tasks match is a problem, and
 * so is a brief holding discovery metadata, which would make its task read as corrupt.
 */
function recoveredTasks(filed: readonly FiledDiscovery[], decisions: readonly AgentDecision[], problems: string[]): Map<string, string> {
  const recovered = new Map<string, string>();
  for (const decision of decisions) {
    if (decision.outcome !== 'file') continue;
    if (mentionsDiscoveryMetadata(decision.body)) {
      problems.push(`key ${decision.key}'s body holds archon-discovery metadata, which would leave its task unreadable to a later pass`);
    }
    const tasks = filingsOf(filed, decision);
    if (tasks.length > 1) {
      const ids = tasks.map(entry => entry.task.id).join(', ');
      problems.push(`key ${decision.key} and its refs match more than one tracker task (${ids})`);
    } else if (tasks[0] !== undefined) {
      recovered.set(decision.key, tasks[0].task.id);
    }
  }
  return recovered;
}

/**
 * Why a GitHub issue cannot track the decision, or null when it can: it must be open in
 * this repository, whose project does not file discoveries into the Archon tracker.
 */
function trackingProblem(decision: AgentDecision & { outcome: 'track' }, repo: QualifiedPr['repo'], toTracker: boolean): string | null {
  if (toTracker) {
    return `key ${decision.key} is tracked on a GitHub issue, but this project files discoveries into the Archon tracker`;
  }
  if (!sameRepo(decision.issue.repo, repo)) {
    return `key ${decision.key} is tracked by an issue outside ${repo.host}/${repo.path}`;
  }
  try {
    return viewIssue(decision.issue).state === 'open'
      ? null
      : `key ${decision.key} is tracked by ${issueUrl(decision.issue)}, which is not open`;
  } catch (error) {
    return `key ${decision.key}: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/** The tracker to file into: the checkout's, refused unless it is still the target facts chose. */
function chosenTracker(target: FilingTarget, repo: QualifiedPr['repo']): ArchonTracker | null {
  const tracker = declaredArchonTracker(process.cwd(), repo, process.env.ARCHON_TRACKER_BASE_URL);
  const current = filingTargetOf(tracker);
  if (!sameFilingTarget(current, target)) {
    throw new Error(
      `nothing was written: facts chose ${describeFilingTarget(target)} for this pass, but the checkout now files into ${describeFilingTarget(current)}`
    );
  }
  return tracker;
}

async function main(): Promise<void> {
  const idle = trimmed(process.env.INPUTS_PATH) === 'idle';
  if (idle) {
    emit({ summary: IDLE, written: [], dropped: [], asked: [], question: '' });
    return;
  }
  const repo = {
    host: trimmed(process.env.INPUTS_REPO_HOST),
    path: trimmed(process.env.INPUTS_REPO_PATH),
  };
  const queue = JSON.parse(readFileSync(join(artifactsDir(), 'drain', 'queue.json'), 'utf8')) as Queue;
  const decisions = (nullableJson(process.env.INPUTS_DECISIONS) ?? []) as AgentDecision[];
  const summary = text(process.env.INPUTS_SUMMARY);
  const target = parseFilingTarget({
    tracker: trimmed(process.env.INPUTS_TRACKER),
    archon_project_id: trimmed(process.env.INPUTS_ARCHON_PROJECT_ID),
    tracker_base_url: trimmed(process.env.INPUTS_TRACKER_BASE_URL),
  });
  const tracker = chosenTracker(target, repo);
  const filed = tracker === null ? [] : filedDiscoveries(await tracker.listProjectTasks());

  const problems = checkDecisions(
    queue.runs.flatMap(run => run.records.map(record => record.ref)),
    decisions
  );
  const recovered = tracker === null ? new Map<string, string>() : recoveredTasks(filed, decisions, problems);
  for (const decision of decisions) {
    if (decision.outcome !== 'track') continue;
    const problem = trackingProblem(decision, repo, tracker !== null);
    if (problem !== null) problems.push(problem);
  }
  const dropped = decisions.flatMap(decision =>
    decision.outcome === 'drop' ? [{ key: decision.key, reason: decision.reason }] : []
  );
  const asked = decisions.filter(
    (decision): decision is AgentDecision & { outcome: 'ask' } => decision.outcome === 'ask'
  );

  if (problems.length > 0) throw new Error(`nothing was written: ${problems.join('; ')}`);

  // The public writes first. Each is found again by its marker, and a task by its refs
  // too, so a pass run again after a stop never repeats one.
  const sha = queue.base.sha;
  const written: { key: string; outcome: 'file' | 'track'; url: string }[] = [];
  const source = forgeSource();
  for (const decision of decisions) {
    const marker = discoveryMarker(decision.key);
    if (decision.outcome === 'file') {
      const url =
        tracker === null
          ? createIssue(repo, decision.title, filingBody(decision, sha, false), marker).url
          : tracker.taskUrl(recovered.get(decision.key) ?? (await tracker.createTask(newTask(decision, sha))));
      written.push({ key: decision.key, outcome: 'file', url });
    } else if (decision.outcome === 'track') {
      const comment = decision.comment?.trim() || null;
      // One marked comment per key: later evidence replaces it in place.
      const url =
        comment === null
          ? issueUrl(decision.issue)
          : upsertComment({ kind: 'issue', ref: decision.issue }, marker, `${marker}\n${comment}`, source).url;
      written.push({ key: decision.key, outcome: 'track', url });
    }
  }

  // Then each run's memory: the refs decided this pass, and the questions asked. A run
  // with an asked record keeps this run's claim, so no other pass asks again while the
  // question waits.
  const self = trimmed(process.env.WORKFLOW_ID);
  for (const run of queue.runs) {
    const name = runName(run.id);
    const read = stateGet(name);
    const document = parseRunDocument(name, read.value);
    if (document?.claim?.run_id !== self) throw new Error(`${name} is no longer claimed by this run`);
    const ofRun = (refs: readonly string[]): string[] => refs.filter(ref => refRun(ref) === run.id);
    const decided = decisions.filter(decision => decision.outcome !== 'ask').flatMap(decision => ofRun(decision.refs));
    const questions: Question[] = asked
      .filter(decision => ofRun(decision.refs).length > 0)
      .map(decision => ({
        keys: [decision.key],
        refs: ofRun(decision.refs),
        text: decision.question,
        recommendation: decision.recommendation,
        answer: null,
      }));
    const next = {
      version: 1 as const,
      claim: questions.length > 0 ? document.claim : null,
      decided: [...new Set([...(document.decided ?? []), ...decided])],
      // A question this pass answered by deciding its refs is settled; one it asked again replaces it.
      questions: [
        ...(document.questions ?? []).filter(old =>
          old.refs.every(ref => !decided.includes(ref) && !questions.some(asking => asking.refs.includes(ref)))
        ),
        ...questions,
      ],
    };
    if (statePut(name, next, read.revision) === 'conflict') {
      throw new Error(`${name} changed while this run held its claim`);
    }
  }
  emit({
    summary,
    written,
    dropped,
    asked: asked.map(decision => decision.key),
    question: asked
      .map(
        (decision, index) =>
          `${String(index + 1)}. ${decision.key}: ${decision.question}\n   Recommended: ${decision.recommendation}`
      )
      .join('\n'),
  });
}

try {
  await main();
} catch (error) {
  refuse(`discoveries outcome: ${error instanceof Error ? error.message : String(error)}`);
}
