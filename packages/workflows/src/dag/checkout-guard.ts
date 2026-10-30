import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readlink } from 'node:fs/promises';
import { resolve as resolvePath } from 'path';
import { isPathInside } from '@archon/paths';
import { execFileAsync } from '@archon/git';
import { type DagNode, isExecNode, isAgentNode } from '../schemas';
import type { NodeExecutionResult } from '../node-record-serialization';
import type { WorkflowDeps } from '../deps';
import { recordNodeState } from '../node-event-write';
import { finishNodeExecution } from '../node-execution';
import { checkoutObservationGitEnv, readCheckoutHeadCommit } from '../checkout-observation';
import type { RunLayersContext } from './run-context';
import { getLog } from './log';

/**
 * Absolute directories a run writes into by engine design (artifacts, state, logs).
 * Changes under them never count against a node's `mutates_checkout: false`
 * assertion (#2771) — extend here if another engine-write root appears.
 */
export function checkoutSnapshotExcludes(
  artifactsDir: string,
  stateDir: string,
  logDir: string
): readonly string[] {
  return [artifactsDir, stateDir, logDir].map(d => resolvePath(d));
}

export function isInsideAny(absPath: string, dirs: readonly string[]): boolean {
  return dirs.some(d => isPathInside(d, absPath, { includeRoot: true, lexical: true }));
}

type CheckoutContent =
  | { kind: 'file'; value: string }
  | { kind: 'symlink'; value: string }
  | { kind: 'missing' | 'other'; value: number };

interface CheckoutSnapshot {
  readonly headCommit: string | null;
  readonly paths: ReadonlyMap<string, { status: string; content: CheckoutContent }>;
}

async function fingerprint(path: string): Promise<CheckoutContent> {
  let stat;
  try {
    stat = await lstat(path);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return { kind: 'missing', value: 0 };
    }
    throw error;
  }
  if (stat.isSymbolicLink()) return { kind: 'symlink', value: await readlink(path) };
  if (!stat.isFile()) return { kind: 'other', value: stat.mode };
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return { kind: 'file', value: hash.digest('hex') };
}

async function readDirtyPaths(
  cwd: string,
  excludeDirs: readonly string[]
): Promise<Map<string, { status: string; content: CheckoutContent }>> {
  const env = checkoutObservationGitEnv();
  const { stdout } = await execFileAsync(
    'git',
    ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
    { cwd, env, timeout: 10_000 }
  );
  const snapshot = new Map<string, { status: string; content: CheckoutContent }>();
  if (stdout === '') return snapshot;

  // Keep cwd's lexical spelling: Git's absolute root may resolve aliases such as
  // macOS /var, while the engine's excluded roots retain that alias.
  const { stdout: root } = await execFileAsync('git', ['rev-parse', '--show-cdup'], {
    cwd,
    env,
    timeout: 10_000,
  });
  const repositoryRoot = resolvePath(cwd, root.replace(/\r?\n$/, ''));
  const records = stdout.split('\0');
  for (let i = 0; i < records.length - 1; i++) {
    const record = records[i];
    const status = record.slice(0, 2);
    const paths = [record.slice(3)];
    // Porcelain -z places the destination first and the rename/copy source next.
    if (status.includes('R') || status.includes('C')) paths.push(records[++i]);
    for (const path of paths) {
      const absolute = resolvePath(repositoryRoot, path);
      if (isInsideAny(absolute, excludeDirs) || snapshot.has(path)) continue;
      snapshot.set(path, { status, content: await fingerprint(absolute) });
    }
  }
  return snapshot;
}

/**
 * Observe Git-visible checkout state, excluding engine-owned roots.
 * Unavailable Git or filesystem observations return `undefined`; callers decide
 * whether that skips an ordinary assertion or fails closed before provider fallback.
 */
export async function snapshotCheckout(
  cwd: string,
  excludeDirs: readonly string[]
): Promise<CheckoutSnapshot | undefined> {
  try {
    const snapshot = await readDirtyPaths(cwd, excludeDirs);
    const headCommit = await readCheckoutHeadCommit(cwd);
    if (headCommit === undefined) {
      getLog().warn({ cwd }, 'dag_checkout_snapshot_unavailable');
      return undefined;
    }

    return { headCommit, paths: snapshot };
  } catch (error) {
    // A partial observation cannot establish that the checkout stayed unchanged.
    getLog().warn({ cwd, err: error }, 'dag_checkout_snapshot_unavailable');
    return undefined;
  }
}

function changedCheckoutPaths(before: CheckoutSnapshot, after: CheckoutSnapshot): string[] {
  const changed = [...new Set([...before.paths.keys(), ...after.paths.keys()])].filter(path => {
    const a = before.paths.get(path);
    const b = after.paths.get(path);
    return (
      a === undefined ||
      b === undefined ||
      a.status !== b.status ||
      a.content.kind !== b.content.kind ||
      a.content.value !== b.content.value
    );
  });

  // A provider may modify files and commit them, leaving `git status` clean.
  // HEAD identity therefore participates in the checkout invariant independently
  // of dirty-path equality.
  if (before.headCommit !== after.headCommit) changed.unshift('<HEAD>');

  return changed;
}

/**
 * Compare a guarded checkout with its pre-attempt snapshot. The result distinguishes
 * a proven mutation from an unavailable observation so fallback policy can fail closed
 * without discarding evidence that the checkout actually changed.
 */
export async function checkoutStateSinceSnapshot(
  cwd: string,
  excludeDirs: readonly string[],
  before: CheckoutSnapshot | undefined
): Promise<'unchanged' | 'changed' | 'unavailable'> {
  if (before === undefined) return 'unavailable';
  const after = await snapshotCheckout(cwd, excludeDirs);
  if (after === undefined) return 'unavailable';
  return changedCheckoutPaths(before, after).length === 0 ? 'unchanged' : 'changed';
}

/**
 * Take a `mutates_checkout: false` node's pre-run snapshot and record it in its
 * concurrent layer's snapshot set, so a sibling's violation can name it. Returns
 * `undefined` for an undeclared node: nothing to assert.
 */
export async function snapshotGuardedNode(
  ctx: Pick<RunLayersContext, 'cwd' | 'guardedLayerSnapshots'>,
  node: DagNode,
  excludeDirs: readonly string[]
): Promise<CheckoutSnapshot | undefined> {
  if (node.mutates_checkout !== false) return undefined;
  ctx.guardedLayerSnapshots?.add(node.id);
  return snapshotCheckout(ctx.cwd, excludeDirs);
}

/**
 * A node whose `mutates_checkout: false` the engine enforces: exec and agent nodes.
 * Every other node may write to the checkout as far as layer scheduling knows.
 */
export function isCheckoutGuarded(node: DagNode): boolean {
  return node.mutates_checkout === false && (isExecNode(node) || isAgentNode(node));
}

/**
 * Enforce a node's `mutates_checkout: false` declaration (#2771): when the pre-run
 * snapshot changed, rewrite its result to a failure that names the node and lists what
 * moved, and persist the standard `node_failed` event so the violation surfaces like any
 * other node failure. Applied OUTSIDE the retry loop so the failure is non-retryable by
 * construction — retrying a node that provably mutates would only multiply the damage.
 * Ordinary nodes keep an already-failed attributable outcome; cross-provider fallback
 * may opt into checking failed results because a checkout violation must remain terminal.
 * An absent post-run snapshot skips the ordinary assertion. Cross-provider fallback
 * opts into fail-closed enforcement with `checkFailedResult`.
 */
export async function assertCheckoutUntouched(
  node: DagNode,
  cwd: string,
  excludeDirs: readonly string[],
  before: CheckoutSnapshot | undefined,
  result: NodeExecutionResult,
  deps: WorkflowDeps,
  logDir: string,
  guardedLayerSnapshots: ReadonlySet<string> | undefined,
  checkFailedResult = false
): Promise<NodeExecutionResult> {
  if (
    node.mutates_checkout !== false ||
    before === undefined ||
    (result.state !== 'completed' && !checkFailedResult)
  ) {
    return result;
  }
  const failCheckoutContract = async (error: string): Promise<NodeExecutionResult> => {
    if (result.execution === undefined) {
      if (result.state === 'failed' && result.failureKind === 'cancelled') {
        return result;
      }
      throw new Error(`Node '${node.id}' finished without its execution record`);
    }

    // This amends an already-recorded attempt. Keep its facts without charging its spend twice.
    const amended = await recordNodeState(
      { store: deps.store, logDir },
      finishNodeExecution(
        { ...result.execution, accounting: 'amendment' },
        { status: 'failed', error, failureKind: 'output_contract' },
        {
          output: {
            text: result.output,
            ...('structuredOutput' in result && result.structuredOutput !== undefined
              ? { structured: result.structuredOutput }
              : {}),
            ...('declaredOutputPaths' in result && result.declaredOutputPaths !== undefined
              ? { declaredOutputPaths: result.declaredOutputPaths }
              : {}),
          },
        }
      )
    );

    // Retry accounting is the accumulated cost of all attempts, not only the amended last one.
    return {
      ...amended,
      costUsd: result.costUsd,
      tokens: result.tokens,
      tokensUnknown: result.tokensUnknown,
    };
  };

  const after = await snapshotCheckout(cwd, excludeDirs);
  if (after === undefined) {
    if (!checkFailedResult) return result;

    const error =
      `Node \`${node.id}\` declared \`mutates_checkout: false\`, ` +
      'but the checkout could not be verified after execution';

    getLog().error({ nodeId: node.id }, 'dag_mutates_checkout_verification_unavailable');

    return failCheckoutContract(error);
  }

  const changed = changedCheckoutPaths(before, after);
  if (changed.length === 0) return result;
  const changedPaths = changed.sort().slice(0, 10).join(', ');
  const concurrentGuardedSiblings = [...(guardedLayerSnapshots ?? [])].filter(id => id !== node.id);
  const error =
    concurrentGuardedSiblings.length === 0
      ? `Node \`${node.id}\` declared \`mutates_checkout: false\` but modified the working tree: ${changedPaths}`
      : `Node \`${node.id}\` declared \`mutates_checkout: false\`, and the working tree changed; the guarded siblings ${concurrentGuardedSiblings.map(id => `\`${id}\``).join(', ')} also ran in this parallel layer, so the change may not be this node's alone: ${changedPaths}`;
  getLog().error({ nodeId: node.id, changed: changedPaths }, 'dag_mutates_checkout_violation');
  return failCheckoutContract(error);
}
