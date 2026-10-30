/**
 * Tasks in the operator's Archon task tracker, scoped to one repository's business
 * project (./project-context.ts).
 *
 * This is separate from the forge: a forge issue and an Archon task are different
 * records on different services, and choosing the Archon tracker never reroutes an
 * issue write. Every task it lists or creates is in the context's `archonProjectId`;
 * the tracker cannot be built without one, so there is no project to fall back to.
 *
 * The request shapes here are the subset of the tracker's OpenAPI document this pack
 * uses; `.archon/scripts/__tests__/archon-tracker.test.ts` holds them against a capture
 * of that document. Its response bodies are untyped there, so `taskOf` checks the
 * fields this pack reads.
 */

import { type QualifiedPr, sameRepo } from './forge.ts';
import { type ArchonProjectContext, PROJECT_FILE, readProjectContext } from './project-context.ts';
import { isObject } from './typed.ts';

/** The fields of a task this pack reads; the tracker returns more. */
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
 * value carrying credentials (userinfo), a query or a fragment, even an empty one, is
 * refused, and no refusal here quotes the value, which may hold a secret. An accepted
 * base therefore carries none of those, so it and what is built on it may be printed:
 * task URLs, the origin of a tracker that is unreachable, and the method and path of a
 * request that fails.
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
  // The parsed URL keeps an empty `?` or `#` in its href, so a base ending in one would
  // name the same tracker as the plain base yet carry a different filing target.
  if (url.username !== '' || url.password !== '' || raw.includes('?') || raw.includes('#')) {
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
    /** As `trackerBaseUrl` accepted it, so it may be printed and carried. */
    readonly baseUrl: URL,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  /**
   * Create a task in the project and return its id, once the tracker reads back every
   * field of the request as it was sent. A task stored any other way is refused, not
   * reported as filed: what a later pass makes of it depends on what survived, since it
   * recovers a task by the archon-discovery header in its description, in this project.
   */
  async createTask(task: NewArchonTask): Promise<string> {
    const sent = { ...task, project_id: this.context.archonProjectId };
    const body = await this.request('POST', this.url('api/tasks'), sent);
    const created = isObject(body) ? body.task : undefined;
    if (!isObject(created) || typeof created.id !== 'string') {
      throw new ArchonTrackerError(`the tracker's create response is not a task: ${JSON.stringify(body).slice(0, 500)}`, null);
    }
    const stored = await this.request('GET', new URL(this.taskUrl(created.id)));
    if (!isObject(stored)) {
      const excerpt = JSON.stringify(stored).slice(0, 500);
      throw new ArchonTrackerError(`the tracker reads back task ${created.id} as something that is not a task: ${excerpt}`, null);
    }
    const altered = Object.entries(sent).flatMap(([field, value]) => (stored[field] === value ? [] : [field]));
    if (altered.length > 0) {
      throw new ArchonTrackerError(
        `the tracker created task ${created.id} but reads back a different ${altered.join(', ')} than was sent, so it is not reported as filed. Check it before running again: a later pass recovers it as filed if its archon-discovery header is intact and it is in project ${this.context.archonProjectId}.`,
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
    throw new ArchonTrackerError(`the tracker returned something that is not a task: ${JSON.stringify(value).slice(0, 500)}`, null);
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
