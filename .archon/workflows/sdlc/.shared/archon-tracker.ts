/**
 * Tasks in the operator's Archon task tracker, scoped to one repository's business
 * project (./project-context.ts).
 *
 * This is separate from the forge: a forge issue and an Archon task are different
 * records on different services, and choosing the Archon tracker never reroutes an
 * issue write. Every request is scoped to the context's `archonProjectId`; the
 * tracker cannot be built without one, so there is no project to fall back to.
 *
 * The request shapes here are the subset of the tracker's OpenAPI document this pack
 * uses; `.archon/scripts/__tests__/archon-tracker.test.ts` holds them against a capture
 * of that document. Its response bodies are untyped there, so `taskOf` checks the
 * fields this pack reads.
 */

import { type QualifiedPr, sameRepo } from './forge.ts';
import { type ArchonProjectContext, PROJECT_FILE, readProjectContext } from './project-context.ts';
import { isObject } from './typed.ts';

/** The fields of a listed task this pack reads; the tracker returns more. */
export interface ArchonTask {
  readonly id: string;
  readonly project_id: string;
  readonly title: string;
  readonly description: string | null;
  readonly status: string;
  readonly archived: boolean;
}

/** The fields of the tracker's `CreateTaskRequest` this pack sets, besides `project_id`. */
export interface NewArchonTask {
  readonly title: string;
  readonly description: string;
  readonly status: 'todo';
}

export class ArchonTrackerError extends Error {
  /** The HTTP status, or null when no response arrived or the response was unusable. */
  readonly status: number | null;

  constructor(message: string, status: number | null, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ArchonTrackerError';
    this.status = status;
  }
}

/**
 * The tracker's base URL from its configured value (`ARCHON_TRACKER_BASE_URL`).
 * There is no default: an unset or malformed value is refused rather than guessed. A
 * value carrying credentials (userinfo), a query or a fragment is refused, and no refusal
 * here quotes the value, which may hold a secret. An accepted base therefore carries
 * none of those, so the request diagnostics may name its origin and path, as every task
 * URL this pack prints does.
 */
export function trackerBaseUrl(value: string | undefined): URL {
  const raw = (value ?? '').trim();
  if (raw === '') throw new ArchonTrackerError('ARCHON_TRACKER_BASE_URL is not set.', null);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    // The parser's error quotes the value, so it is not kept as the cause.
    throw new ArchonTrackerError('ARCHON_TRACKER_BASE_URL is not a URL.', null);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ArchonTrackerError('ARCHON_TRACKER_BASE_URL must be an http or https URL.', null);
  }
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    throw new ArchonTrackerError('ARCHON_TRACKER_BASE_URL must not carry credentials, a query or a fragment.', null);
  }
  if (!url.pathname.endsWith('/')) url.pathname = `${url.pathname}/`;
  return url;
}

/**
 * The Archon tracker a checkout's project declares as primary, or null when the checkout
 * has no project file or its project keeps work on GitHub. A project file that names the
 * Archon tracker but cannot reach it — an unreadable or invalid file, a missing project
 * id, a `github_repo` other than the repository this run works on, an unset or malformed
 * base URL — is refused before any request, never read as GitHub.
 */
export function declaredArchonTracker(
  checkout: string,
  repo: QualifiedPr['repo'],
  baseUrlValue: string | undefined,
  fetchImpl: typeof fetch = fetch
): ArchonTracker | null {
  const context = readProjectContext(checkout);
  if (context === null || context.trackerPrimary !== 'archon') return null;
  if (!sameRepo(context.githubRepo, repo)) {
    const declared = `${context.githubRepo.host}/${context.githubRepo.path}`;
    throw new ArchonTrackerError(
      `${PROJECT_FILE} is ${declared}'s, not ${repo.host}/${repo.path}'s, so its tracker project is not this run's.`,
      null
    );
  }
  return new ArchonTracker(context, trackerBaseUrl(baseUrlValue), fetchImpl);
}

export class ArchonTracker {
  constructor(
    readonly context: ArchonProjectContext,
    private readonly baseUrl: URL,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  /** Create a task in the project and return its id. */
  async createTask(task: NewArchonTask): Promise<string> {
    const body = await this.request('POST', this.url('api/tasks'), { ...task, project_id: this.context.archonProjectId });
    const created = isObject(body) ? body.task : undefined;
    if (!isObject(created) || typeof created.id !== 'string' || typeof created.project_id !== 'string') {
      throw new ArchonTrackerError(`the tracker's create response is not a task: ${JSON.stringify(body).slice(0, 500)}`, null);
    }
    if (created.project_id !== this.context.archonProjectId) {
      throw new ArchonTrackerError(
        `the tracker created task ${created.id} in project ${created.project_id}, not ${this.context.archonProjectId}.`,
        null
      );
    }
    return created.id;
  }

  /** Every task in the project, archived ones included: the tracker leaves those out unless asked. */
  async listProjectTasks(): Promise<ArchonTask[]> {
    const url = this.url(`api/projects/${encodeURIComponent(this.context.archonProjectId)}/tasks`);
    url.searchParams.set('include_archived', 'true');
    const body = await this.request('GET', url);
    if (!Array.isArray(body)) throw new ArchonTrackerError('the task list is not an array.', null);
    return body.map(taskOf);
  }

  /** The task's address on the tracker's API; the tracker has no other link to a task. */
  taskUrl(taskId: string): string {
    return this.url(`api/tasks/${encodeURIComponent(taskId)}`).href;
  }

  private url(path: string): URL {
    return new URL(path, this.baseUrl);
  }

  private async request(method: 'GET' | 'POST', url: URL, body?: unknown): Promise<unknown> {
    const where = `${method} ${url.pathname}`;
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (error) {
      throw new ArchonTrackerError(`${where}: the tracker at ${url.origin} is unreachable.`, null, { cause: error });
    }
    const text = await response.text();
    if (!response.ok) {
      throw new ArchonTrackerError(`${where} failed with ${String(response.status)}: ${text.slice(0, 2000)}`, response.status);
    }
    try {
      return JSON.parse(text) as unknown;
    } catch (error) {
      throw new ArchonTrackerError(`${where} returned a body that is not JSON.`, response.status, { cause: error });
    }
  }
}

function taskOf(value: unknown): ArchonTask {
  if (
    !isObject(value) ||
    typeof value.id !== 'string' ||
    typeof value.project_id !== 'string' ||
    typeof value.title !== 'string' ||
    (typeof value.description !== 'string' && value.description !== null) ||
    typeof value.status !== 'string' ||
    typeof value.archived !== 'boolean'
  ) {
    throw new ArchonTrackerError(`the tracker listed something that is not a task: ${JSON.stringify(value).slice(0, 500)}`, null);
  }
  return {
    id: value.id,
    project_id: value.project_id,
    title: value.title,
    description: value.description,
    status: value.status,
    archived: value.archived,
  };
}
