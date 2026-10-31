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
import type { QualifiedPr } from './forge.ts';
import { urlRepo } from './remote.ts';
import { isObject } from './typed.ts';

export const PROJECT_FILE = '.factory/project.yaml';

interface ProjectContextBase {
  readonly projectName: string;
  /** The repository the file was written for: `owner/name` on github.com, or a remote URL. */
  readonly githubRepo: QualifiedPr['repo'];
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

/**
 * The trackers a project can keep its work in. Each consumer that routes on one — the
 * tracker a checkout declares, the filing target a pass carries — is keyed or switched
 * exhaustively on this type, so a new kind fails to compile until each routes it.
 */
export type TrackerKind = ProjectContext['trackerPrimary'];

export class ProjectContextError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ProjectContextError';
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GITHUB_REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/**
 * Read and validate `<checkout>/.factory/project.yaml`, or null when the file does not
 * exist. Only a missing file means the repository declares no project: an unreadable
 * `.factory/` or file is a `ProjectContextError` like every other defect, never "none".
 */
export function readProjectContext(checkout: string): ProjectContext | null {
  const file = join(checkout, PROJECT_FILE);
  let source: string;
  try {
    source = readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    const code = (error as NodeJS.ErrnoException).code ?? 'an unknown error';
    throw new ProjectContextError(`${file} could not be read (${code}).`, { cause: error });
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
  const githubRepo = typeof project.github_repo === 'string' ? repoOf(project.github_repo) : undefined;
  if (githubRepo === undefined) {
    return fail('`project.github_repo` must be `owner/name` or the repository\'s remote URL.');
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

function repoOf(value: string): QualifiedPr['repo'] | undefined {
  const trimmed = value.trim();
  return GITHUB_REPO.test(trimmed) ? { host: 'github.com', path: trimmed } : urlRepo(trimmed);
}
