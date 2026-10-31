/**
 * Create the approved plan's tasks as todo tasks in the checkout's Archon project.
 *
 * The plan is `$ARTIFACTS_DIR/intake/plan.json`, as the operator approved it. Before any
 * write, the checkout and environment must still name the project, tracker and repository
 * the plan was made for, and the project's specifications must still be the versions it
 * analysed; anything else refuses, so a stale backlog is never written. A task an earlier
 * run created carries its key's marker and is recovered, not created again, so this node
 * run again after a failure partway continues where it stopped.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { artifactsDir, emit, refuse } from '../../.shared/io.ts';
import {
  assertSameSources,
  assertSameTarget,
  CREATE_OUTPUT,
  createPlannedTasks,
  intakeTarget,
  parsePlanFile,
  readIntakeSources,
} from '../../.shared/project-intake.ts';
import type { Infer } from '../../.shared/schema.ts';

try {
  const file = parsePlanFile(JSON.parse(readFileSync(join(artifactsDir(), 'intake', 'plan.json'), 'utf8')));
  const target = intakeTarget(process.cwd(), process.env.ARCHON_TRACKER_BASE_URL);
  assertSameTarget(file, target);
  assertSameSources(file, await readIntakeSources(target));
  const { created, recovered } = await createPlannedTasks(target.tracker, file);
  emit({
    summary: `Created ${String(created.length)} todo tasks in Archon project ${file.project_id}; ${String(recovered.length)} were already there from an earlier intake.`,
    created,
    recovered,
  } satisfies Infer<typeof CREATE_OUTPUT>);
} catch (error) {
  refuse(`project intake create: ${error instanceof Error ? error.message : String(error)}`);
}
