/**
 * Tasks in the operator's Archon task tracker, scoped to one repository's business
 * project (./project-context.ts).
 *
 * This is separate from the forge: a forge issue and an Archon task are different
 * records on different services, and choosing the Archon tracker never reroutes an
 * issue write. Every task it lists or creates is in the context's `archonProjectId`;
 * the tracker cannot be built without one, so there is no project to fall back to.
 *
 * The request shapes here and in ./archon-docs.ts are the subset of the tracker's
 * OpenAPI document this pack uses; `.archon/scripts/__tests__/archon-tracker.test.ts`
 * holds them against a capture of that document. Its response bodies are untyped there,
 * so `taskOf` checks the fields this pack reads.
 */

import { type QualifiedPr, sameRepo } from './forge.ts';
import { type ArchonProjectContext, PROJECT_FILE, type ProjectContext, readProjectContext } from './project-context.ts';
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
 * A task creation the tracker may have stored but that is not confirmed as sent: the
 * request got no answer, an error the tracker may send after storing the task, or one
 * that could not be read, or the task did not read back as it was sent. `taskId` is the
 * stored task's id when the tracker returned one.
 */
export class UnconfirmedTaskError extends ArchonTrackerError {
  constructor(
    message: string,
    readonly taskId: string | null,
    options?: ErrorOptions
  ) {
    super(message, null, options);
    this.name = 'UnconfirmedTaskError';
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
  if (context === null) return null;
  switch (context.trackerPrimary) {
    case 'github':
      return null;
    case 'archon':
      break;
    default:
      throw new ArchonTrackerError(`No route for tracker ${(context satisfies never as ProjectContext).trackerPrimary}.`, null);
  }
  if (!sameRepo(context.githubRepo, repo)) {
    const declared = `${context.githubRepo.host}/${context.githubRepo.path}`;
    throw new ArchonTrackerError(
      `${PROJECT_FILE} is ${declared}'s, not ${repo.host}/${repo.path}'s, so its tracker project is not this run's.`,
      null
    );
  }
  return new ArchonTracker(context, trackerBaseUrl(baseUrlValue), fetchImpl);
}

/**
 * The one create answer that proves nothing was stored: the tracker (FastAPI) validates a
 * request against `CreateTaskRequest` before its handler runs. The handler answers a
 * failure with 400 or 500, but it inserts the task before it can fail, so either may
 * follow a stored task, as may any status a proxy in between sends.
 */
const REQUEST_INVALID = 422;

export class ArchonTracker {
  constructor(
    readonly context: ArchonProjectContext,
    /** As `trackerBaseUrl` accepted it, so it may be printed and carried. */
    readonly baseUrl: URL,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  /**
   * Create a task in the project and return its id, once the tracker reads back every
   * field of the request as it was sent. A refusal is an `ArchonTrackerError` only when
   * the tracker answered the create with a request validation error, which it sends
   * before its handler runs, so no task was stored; every other failure is an
   * `UnconfirmedTaskError`, since the task may be stored. What a later pass makes of one
   * depends on what survived: each workflow that files here recovers a task by the
   * marker on its description's first line, in this project.
   */
  async createTask(task: NewArchonTask): Promise<string> {
    const sent = { ...task, project_id: this.context.archonProjectId };
    let body: unknown;
    try {
      body = await this.request('POST', this.url('api/tasks'), sent);
    } catch (error) {
      if (error instanceof ArchonTrackerError && error.status === REQUEST_INVALID) throw error;
      throw this.unconfirmed(null, error instanceof Error ? error.message : String(error), error);
    }
    const created = isObject(body) ? body.task : undefined;
    if (!isObject(created) || typeof created.id !== 'string') {
      throw this.unconfirmed(null, `the tracker's create response is not a task: ${JSON.stringify(body).slice(0, 500)}`);
    }
    const id = created.id;
    let stored: unknown;
    try {
      stored = await this.request('GET', new URL(this.taskUrl(id)));
    } catch (error) {
      throw this.unconfirmed(id, `the tracker created task ${id} but did not read it back: ${error instanceof Error ? error.message : String(error)}`, error);
    }
    if (!isObject(stored)) {
      throw this.unconfirmed(id, `the tracker reads back task ${id} as something that is not a task: ${JSON.stringify(stored).slice(0, 500)}`);
    }
    const altered = Object.entries(sent).flatMap(([field, value]) => (stored[field] === value ? [] : [field]));
    if (altered.length > 0) {
      throw this.unconfirmed(id, `the tracker created task ${id} but reads back a different ${altered.join(', ')} than was sent, so it is not reported as filed.`);
    }
    return id;
  }

  private unconfirmed(taskId: string | null, what: string, cause?: unknown): UnconfirmedTaskError {
    const project = this.context.archonProjectId;
    const task = taskId === null ? 'The tracker may have stored the task.' : `The tracker stored task ${taskId}.`;
    return new UnconfirmedTaskError(
      `${what} ${task} Before running again, look in project ${project} for a task whose description's first line carries its marker: a later pass recovers that task as filed, but files the task again when the marker is missing or damaged.`,
      taskId,
      cause === undefined ? undefined : { cause }
    );
  }

  /**
   * Every task in the project, archived ones included: the tracker leaves those out unless
   * asked. A listed task from another project is refused, since a caller recovers its own
   * filings from this list and must never take another project's task for one.
   */
  async listProjectTasks(): Promise<ArchonTask[]> {
    const url = this.url(`api/projects/${encodeURIComponent(this.context.archonProjectId)}/tasks`);
    url.searchParams.set('include_archived', 'true');
    const body = await this.request('GET', url);
    if (!Array.isArray(body)) throw new ArchonTrackerError('the task list is not an array.', null);
    const tasks = body.map(taskOf);
    const foreign = tasks.find(task => task.project_id !== this.context.archonProjectId);
    if (foreign !== undefined) {
      throw new ArchonTrackerError(
        `the tracker lists task ${foreign.id} of project ${foreign.project_id} among project ${this.context.archonProjectId}'s tasks.`,
        null
      );
    }
    return tasks;
  }

  /** The task's address on the tracker's API; the tracker has no other link to a task. */
  taskUrl(taskId: string): string {
    return this.url(`api/tasks/${encodeURIComponent(taskId)}`).href;
  }

  private url(path: string): URL {
    return new URL(path, this.baseUrl);
  }

  private request(method: 'GET' | 'POST', url: URL, body?: unknown): Promise<unknown> {
    return trackerRequest(this.fetchImpl, method, url, body);
  }
}

/**
 * One JSON request to the tracker. `url` is built on a base `trackerBaseUrl` accepted, so
 * its origin and path may be printed; a failure says which request failed and how.
 */
export async function trackerRequest(
  fetchImpl: typeof fetch,
  method: 'GET' | 'POST',
  url: URL,
  body?: unknown
): Promise<unknown> {
  const where = `${method} ${url.pathname}`;
  let response: Response;
  try {
    response = await fetchImpl(url, {
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
