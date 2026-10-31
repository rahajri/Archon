/**
 * Check the agent's plan and put it to the operator.
 *
 * A plan that does not hold together, or that the agent declared insufficient, stops the
 * run here, before any question is asked. A ready plan is written to
 * `$ARTIFACTS_DIR/intake/plan.json` with the identity and source fingerprints it was
 * made from, and the approval question summarizes it.
 *
 * Bound input: INPUTS_PLAN, the plan agent's output.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { artifactsDir, emit, nullableJson, refuse } from '../../.shared/io.ts';
import {
  approvalQuestion,
  parseIntakeSources,
  parseIntakeTaskSummaries,
  parsePlan,
  planFile,
  PROPOSAL_OUTPUT,
} from '../../.shared/project-intake.ts';
import type { Infer } from '../../.shared/schema.ts';

try {
  const intake = join(artifactsDir(), 'intake');
  const sources = parseIntakeSources(JSON.parse(readFileSync(join(intake, 'sources.json'), 'utf8')));
  const existing = parseIntakeTaskSummaries(JSON.parse(readFileSync(join(intake, 'tasks.json'), 'utf8')));
  const plan = parsePlan(nullableJson(process.env.INPUTS_PLAN), sources);
  if (plan.status === 'insufficient') {
    throw new Error(`nothing was planned: the specifications are not enough to plan from without guessing. ${plan.reason.trim()}`);
  }
  const file = planFile(sources, plan);
  const path = join(intake, 'plan.json');
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`);
  emit({
    question: approvalQuestion(file, new Set(existing.map(task => task.key)), path),
    lots: plan.lots.length,
    tasks: plan.tasks.length,
  } satisfies Infer<typeof PROPOSAL_OUTPUT>);
} catch (error) {
  refuse(`project intake proposal: ${error instanceof Error ? error.message : String(error)}`);
}
