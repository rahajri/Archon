/**
 * Tasks in the operator's Archon task tracker, scoped to one repository's business
 * project (./project-context.ts).
 *
 * This is separate from the forge: a forge issue and an Archon task are different
 * records on different services, and choosing the Archon tracker never reroutes an
 * issue write. Every request is scoped to the context's `archonProjectId`; the
 * tracker cannot be built without one, so there is no project to fall back to.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { type ArchonProjectContext, PROJECT_FILE, readProjectContext } from './project-context.ts';
import { isObject } from './typed.ts';

/** The fields of a task this pack reads; the tracker returns more. */
export interface ArchonTask {
  readonly id: string;
  readonly project_id: string;
  readonly title: string;
  readonly description: string | null;
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
 * The Archon tracker a checkout's project declares as primary, or null when the checkout
 * has no project file or its project keeps work on GitHub. A project file that names the
 * Archon tracker but cannot reach it — an invalid file, a missing project id, an unset or
 * malformed base URL — is refused before any request, never read as GitHub.
 */
export function declaredArchonTracker(
  checkout: string,
  baseUrlValue: string | undefined,
  fetchImpl: typeof fetch = fetch
): ArchonTracker | null {
  if (!existsSync(join(checkout, PROJECT_FILE))) return null;
  const context = readProjectContext(checkout);
  if (context.trackerPrimary !== 'archon') return null;
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

  /**
   * Create the one task in the project whose description begins with `marker`, or
   * recover it when an earlier attempt already created it, so a repeated call never
   * creates a second one. A recovered task is returned as it is, never edited. Refuses
   * when more than one task carries the marker.
   */
  async createMarkedTask(marker: string, task: NewArchonTask & { readonly description: string }): Promise<ArchonTask> {
    if (firstLine(task.description) !== marker) {
      throw new ArchonTrackerError('the task description must begin with its marker', null);
    }
    const marked = (await this.listProjectTasks()).filter(
      listed => listed.description !== null && firstLine(listed.description) === marker
    );
    if (marked.length > 1) throw new ArchonTrackerError(`more than one task carries ${marker}`, null);
    return marked[0] ?? (await this.createTask(task));
  }

  /** The task's address on the tracker's API; the tracker has no other link to a task. */
  taskUrl(taskId: string): string {
    return new URL(`api/tasks/${encodeURIComponent(taskId)}`, this.baseUrl).href;
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
    (typeof value.description !== 'string' && value.description !== null) ||
    typeof value.status !== 'string'
  ) {
    throw new ArchonTrackerError(`the tracker returned something that is not a task: ${JSON.stringify(body).slice(0, 500)}`, null);
  }
  return {
    id: value.id,
    project_id: value.project_id,
    title: value.title,
    description: value.description,
    status: value.status,
  };
}

function firstLine(text: string): string {
  return text.split(/\r?\n/, 1)[0] ?? '';
}
