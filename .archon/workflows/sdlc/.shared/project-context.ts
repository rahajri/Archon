/**
 * The business project a repository belongs to, read from its `.factory/project.yaml`.
 *
 * This is not the engine's codebase record for the checkout: the engine identifies a
 * repository by its path and remote, while `archon_project_id` names a project in the
 * operator's Archon task tracker. The two identities are unrelated, so the tracker
 * project is only ever read from this file and never derived from a repository or
 * codebase name.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isObject } from './typed.ts';

export const PROJECT_FILE = '.factory/project.yaml';

export type TrackerPrimary = 'archon' | 'github';

interface ProjectContextBase {
  readonly projectName: string;
  /** `owner/name` on GitHub. */
  readonly githubRepo: string;
  /** Project policy: open a GitHub issue once a tracker task is ready. Recorded, not yet acted on. */
  readonly createGithubIssueOnReady: boolean;
}

export type ArchonProjectContext = ProjectContextBase & {
  readonly trackerPrimary: 'archon';
  readonly archonProjectId: string;
};

export type ProjectContext =
  | ArchonProjectContext
  | (ProjectContextBase & { readonly trackerPrimary: 'github'; readonly archonProjectId: string | null });

export class ProjectContextError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ProjectContextError';
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GITHUB_REPO = /^[^/\s]+\/[^/\s]+$/;

/** Read and validate `<checkout>/.factory/project.yaml`; every defect is a `ProjectContextError`. */
export function readProjectContext(checkout: string): ProjectContext {
  const file = join(checkout, PROJECT_FILE);
  let source: string;
  try {
    source = readFileSync(file, 'utf8');
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === 'ENOENT';
    throw new ProjectContextError(
      missing ? `${file} does not exist; this repository declares no project context.` : `${file} could not be read.`,
      { cause: error }
    );
  }
  let document: unknown;
  try {
    document = Bun.YAML.parse(source);
  } catch (error) {
    throw new ProjectContextError(`${file} is not valid YAML.`, { cause: error });
  }
  return parseProjectContext(document, file);
}

function parseProjectContext(document: unknown, file: string): ProjectContext {
  const fail = (problem: string): never => {
    throw new ProjectContextError(`${file}: ${problem}`);
  };
  if (!isObject(document)) return fail('the document is not a mapping.');
  const project = document.project;
  const tracker = document.tracker;
  if (!isObject(project)) return fail('`project` is missing or not a mapping.');
  if (!isObject(tracker)) return fail('`tracker` is missing or not a mapping.');

  const projectName = project.name;
  if (typeof projectName !== 'string' || projectName.trim() === '') {
    return fail('`project.name` must be a non-empty string.');
  }
  const githubRepo = project.github_repo;
  if (typeof githubRepo !== 'string' || !GITHUB_REPO.test(githubRepo)) {
    return fail('`project.github_repo` must be `owner/name`.');
  }
  const createGithubIssueOnReady = tracker.create_github_issue_on_ready;
  if (typeof createGithubIssueOnReady !== 'boolean') {
    return fail('`tracker.create_github_issue_on_ready` must be true or false.');
  }
  const archonProjectId = project.archon_project_id;
  if (archonProjectId !== undefined && (typeof archonProjectId !== 'string' || !UUID.test(archonProjectId))) {
    return fail('`project.archon_project_id` must be an Archon project UUID.');
  }

  const base = { projectName, githubRepo, createGithubIssueOnReady };
  switch (tracker.primary) {
    case 'archon':
      if (archonProjectId === undefined) {
        return fail('`tracker.primary` is archon but `project.archon_project_id` is missing.');
      }
      return { ...base, trackerPrimary: 'archon', archonProjectId };
    case 'github':
      return { ...base, trackerPrimary: 'github', archonProjectId: archonProjectId ?? null };
    default:
      return fail('`tracker.primary` must be archon or github.');
  }
}
