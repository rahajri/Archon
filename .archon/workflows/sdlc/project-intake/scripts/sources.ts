/**
 * Read what this intake plans from: the specifications in the Archon project the
 * checkout's `.factory/project.yaml` declares, refused unless that project keeps its work
 * in the Archon tracker and this checkout is the repository the file names.
 *
 * Writes `$ARTIFACTS_DIR/intake/sources.json`, every specification with its content and
 * fingerprint, and `$ARTIFACTS_DIR/intake/tasks.json`, the tasks an earlier intake
 * created in the project, archived ones included, so the agent reuses their keys. Writes
 * nothing else, and nothing in the checkout.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { emit, artifactsDir, refuse } from '../../.shared/io.ts';
import { intakeTarget, intakeTaskSummaries, intakeTasks, readIntakeSources } from '../../.shared/project-intake.ts';

try {
  const target = intakeTarget(process.cwd(), process.env.ARCHON_TRACKER_BASE_URL);
  const sources = await readIntakeSources(target);
  const existing = intakeTaskSummaries(target.tracker, intakeTasks(await target.tracker.listProjectTasks()));
  const intake = join(artifactsDir(), 'intake');
  mkdirSync(intake, { recursive: true });
  writeFileSync(join(intake, 'sources.json'), `${JSON.stringify(sources, null, 2)}\n`);
  writeFileSync(join(intake, 'tasks.json'), `${JSON.stringify(existing, null, 2)}\n`);
  emit({ project_id: sources.project.id, documents: sources.documents.length, fingerprint: sources.fingerprint });
} catch (error) {
  refuse(`project intake sources: ${error instanceof Error ? error.message : String(error)}`);
}
