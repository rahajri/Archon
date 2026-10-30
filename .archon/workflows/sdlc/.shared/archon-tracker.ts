/**
 * Tasks in the operator's Archon task tracker, scoped to one repository's business
 * project (./project-context.ts).
 *
 * This is separate from the forge: a forge issue and an Archon task are different
 * records on different services, and choosing the Archon tracker never reroutes an
 * issue write. Every request is scoped to the context's `archonProjectId`; the
 * tracker cannot be built without one, so there is no project to fall back to.
 */

import { type ArchonProjectContext, readProjectContext, requireArchonTracker } from './project-context.ts';
import { isObject } from './typed.ts';

/** The fields of a task this pack reads; the tracker returns more. */
export interface ArchonTask {
  readonly id: string;
  readonly project_id: string;
  readonly title: string;
  readonly status: string;
}

/** The writable task fields, as the tracker's `UpdateTaskRequest` names them. */
export interface ArchonTaskFields {
  readonly title?: string;
  readonly description?: string | null;
  readonly status?: string;
  readonly assignee?: string;
  readonly task_order?: number;
  readonly priority?: string;
  readonly feature?: string | null;
}

export type NewArchonTask = ArchonTaskFields & { readonly title: string };

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
 * There is no default: an unset or malformed value is refused rather than guessed.
 */
export function trackerBaseUrl(value: string | undefined): URL {
  const raw = (value ?? '').trim();
  if (raw === '') throw new ArchonTrackerError('ARCHON_TRACKER_BASE_URL is not set.', null);
  let url: URL;
  try {
    url = new URL(raw);
  } catch (error) {
    throw new ArchonTrackerError(`ARCHON_TRACKER_BASE_URL is not a URL: ${raw}`, null, { cause: error });
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ArchonTrackerError(`ARCHON_TRACKER_BASE_URL must be http or https: ${raw}`, null);
  }
  if (!url.pathname.endsWith('/')) url.pathname = `${url.pathname}/`;
  return url;
}

/**
 * The Archon tracker for a checkout, refused before any request when its project file,
 * its tracker choice or the base URL is missing or invalid.
 */
export function archonTrackerFor(
  checkout: string,
  baseUrlValue: string | undefined,
  fetchImpl: typeof fetch = fetch
): ArchonTracker {
  const context = requireArchonTracker(readProjectContext(checkout));
  return new ArchonTracker(context, trackerBaseUrl(baseUrlValue), fetchImpl);
}

export class ArchonTracker {
  constructor(
    readonly context: ArchonProjectContext,
    private readonly baseUrl: URL,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  async createTask(task: NewArchonTask): Promise<ArchonTask> {
    const created = taskOf(
      await this.request('POST', 'api/tasks', { ...task, project_id: this.context.archonProjectId }),
      'task'
    );
    if (created.project_id !== this.context.archonProjectId) {
      throw new ArchonTrackerError(
        `the tracker created task ${created.id} in project ${created.project_id}, not ${this.context.archonProjectId}.`,
        null
      );
    }
    return created;
  }

  async getTask(taskId: string): Promise<ArchonTask> {
    return taskOf(await this.request('GET', `api/tasks/${encodeURIComponent(taskId)}`), null);
  }

  async listProjectTasks(): Promise<ArchonTask[]> {
    const body = await this.request(
      'GET',
      `api/projects/${encodeURIComponent(this.context.archonProjectId)}/tasks`
    );
    if (!Array.isArray(body)) throw new ArchonTrackerError('the task list is not an array.', null);
    return body.map(item => taskOf(item, null));
  }

  async updateTask(taskId: string, fields: ArchonTaskFields): Promise<ArchonTask> {
    return taskOf(await this.request('PUT', `api/tasks/${encodeURIComponent(taskId)}`, fields), 'task');
  }

  private async request(method: string, path: string, body?: unknown): Promise<unknown> {
    const url = new URL(path, this.baseUrl);
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

/**
 * A task from a response body. Create and update wrap the task as `{ task }`; reads
 * return it bare. The service's OpenAPI document leaves response bodies untyped, so
 * the fields this pack relies on are checked here.
 */
function taskOf(body: unknown, envelope: 'task' | null): ArchonTask {
  const value = envelope === null ? body : isObject(body) ? body[envelope] : undefined;
  if (
    !isObject(value) ||
    typeof value.id !== 'string' ||
    typeof value.project_id !== 'string' ||
    typeof value.title !== 'string' ||
    typeof value.status !== 'string'
  ) {
    throw new ArchonTrackerError(`the tracker returned something that is not a task: ${JSON.stringify(body).slice(0, 500)}`, null);
  }
  return { id: value.id, project_id: value.project_id, title: value.title, status: value.status };
}
