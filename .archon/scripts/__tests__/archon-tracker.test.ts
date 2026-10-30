import { describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from './temp-roots';
import { CAPTURE } from '../archon-tracker-openapi';
import {
  ArchonTracker,
  ArchonTrackerError,
  declaredArchonTracker,
  trackerBaseUrl,
} from '../../workflows/sdlc/.shared/archon-tracker';
import { isObject } from '../../workflows/sdlc/.shared/typed';
import {
  type ArchonProjectContext,
  ProjectContextError,
  readProjectContext,
} from '../../workflows/sdlc/.shared/project-context';

const track = trackTempRoots();

const PROJECT_ID = 'd9f7bb82-5fbc-43d1-aec5-b30006e98182';
const BASE = 'http://127.0.0.1:8181';
const BAREA = { host: 'github.com', path: 'rahajri/BAREA' };

const ARCHON_PROJECT = `project:
  name: BAREA
  archon_project_id: ${PROJECT_ID}
  github_repo: rahajri/BAREA

tracker:
  primary: archon
  create_github_issue_on_ready: true
`;

function checkout(projectYaml?: string): string {
  const root = track(mkdtempSync(join(tmpdir(), 'archon-tracker-')));
  if (projectYaml !== undefined) {
    mkdirSync(join(root, '.factory'));
    writeFileSync(join(root, '.factory/project.yaml'), projectYaml);
  }
  return root;
}

/** Run `body` while `path` has no permissions, restoring them so the temp tree can be removed. */
function withoutAccess<T>(path: string, mode: number, body: () => T): T {
  chmodSync(path, 0o000);
  try {
    return body();
  } finally {
    chmodSync(path, mode);
  }
}

// chmod does not deny root, and Windows ignores the mode.
const permissionsApply = process.platform !== 'win32' && process.getuid?.() !== 0;

interface Sent {
  readonly method: string;
  readonly url: string;
  readonly body: unknown;
}

/** A fetch that records each request and answers with the next scripted response. */
function fakeFetch(...responses: Response[]): { fetch: typeof fetch; sent: Sent[] } {
  const sent: Sent[] = [];
  const impl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    sent.push({
      method: init?.method ?? 'GET',
      url: String(input),
      body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
    });
    const next = responses.shift();
    if (next === undefined) throw new Error('unexpected request');
    return next;
  };
  return { fetch: impl as typeof fetch, sent };
}

function task(id: string, projectId = PROJECT_ID): Record<string, unknown> {
  return { id, project_id: projectId, title: `task ${id}`, description: null, status: 'todo', assignee: 'User', archived: false };
}

const json = (value: unknown, status = 200): Response => Response.json(value, { status });

describe('readProjectContext', () => {
  test('reads a valid project file into a context', () => {
    expect(readProjectContext(checkout(ARCHON_PROJECT))).toEqual({
      projectName: 'BAREA',
      archonProjectId: PROJECT_ID,
      githubRepo: BAREA,
      trackerPrimary: 'archon',
      createGithubIssueOnReady: true,
    });
  });

  test('a checkout with no project file declares none', () => {
    expect(readProjectContext(checkout())).toBeNull();
    const root = checkout();
    mkdirSync(join(root, '.factory'));
    expect(readProjectContext(root)).toBeNull();
  });

  test.skipIf(!permissionsApply)('refuses an unreadable .factory directory or project file', () => {
    const root = checkout(ARCHON_PROJECT);
    withoutAccess(join(root, '.factory'), 0o755, () => {
      expect(() => readProjectContext(root)).toThrow(/could not be read \(EACCES\)/);
    });
    withoutAccess(join(root, '.factory/project.yaml'), 0o644, () => {
      expect(() => readProjectContext(root)).toThrow(/could not be read \(EACCES\)/);
    });
  });

  test('refuses a .factory that is not a directory', () => {
    const root = checkout();
    writeFileSync(join(root, '.factory'), '');
    expect(() => readProjectContext(root)).toThrow(/could not be read \(ENOTDIR\)/);
  });

  test('refuses invalid YAML', () => {
    expect(() => readProjectContext(checkout('project: [unclosed\n'))).toThrow(/is not valid YAML/);
  });

  test('refuses an archon tracker without archon_project_id', () => {
    const yaml = ARCHON_PROJECT.replace(/ {2}archon_project_id: .*\n/, '');
    expect(() => readProjectContext(checkout(yaml))).toThrow(/archon_project_id` is missing/);
  });

  test('refuses an archon_project_id that is not a project UUID', () => {
    const yaml = ARCHON_PROJECT.replace(PROJECT_ID, 'BAREA');
    expect(() => readProjectContext(checkout(yaml))).toThrow(/must be an Archon project UUID/);
  });

  test.each([
    ['project.name', ARCHON_PROJECT.replace('name: BAREA', 'name: ""')],
    ['project.github_repo', ARCHON_PROJECT.replace('rahajri/BAREA', 'BAREA')],
    ['project.github_repo', ARCHON_PROJECT.replace('rahajri/BAREA', '/local/path')],
    ['tracker.create_github_issue_on_ready', ARCHON_PROJECT.replace('ready: true', 'ready: "yes"')],
    ['tracker.primary', ARCHON_PROJECT.replace('primary: archon', 'primary: jira')],
  ])('refuses an invalid %s', (field, yaml) => {
    expect(() => readProjectContext(checkout(yaml))).toThrow(ProjectContextError);
    expect(() => readProjectContext(checkout(yaml))).toThrow(field);
  });

  test.each([
    ['https://github.com/rahajri/BAREA.git', BAREA],
    ['git@github.com:rahajri/BAREA.git', BAREA],
    ['ssh://git@ssh.github.com:443/rahajri/BAREA', BAREA],
    ['https://ghe.example.com/example/repo', { host: 'ghe.example.com', path: 'example/repo' }],
  ])('reads github_repo %s as the repository it names', (value, repo) => {
    expect(readProjectContext(checkout(ARCHON_PROJECT.replace('rahajri/BAREA', value)))?.githubRepo).toEqual(repo);
  });

  test('a github-primary project needs no archon_project_id', () => {
    const yaml = ARCHON_PROJECT.replace(/ {2}archon_project_id: .*\n/, '').replace('primary: archon', 'primary: github');
    expect(readProjectContext(checkout(yaml))).toMatchObject({ trackerPrimary: 'github', archonProjectId: null });
  });
});

describe('trackerBaseUrl', () => {
  test('takes the configured URL, keeping a path prefix', () => {
    expect(trackerBaseUrl(BASE).href).toBe(`${BASE}/`);
    expect(trackerBaseUrl('https://tracker.example/archon').href).toBe('https://tracker.example/archon/');
  });

  test.each([[undefined], [''], ['127.0.0.1:8181'], ['not a url'], ['ftp://tracker.example']])(
    'refuses %p',
    value => {
      expect(() => trackerBaseUrl(value)).toThrow(ArchonTrackerError);
    }
  );

  test.each([
    ['a malformed URL with credentials', 'htps://user:S3CRET@tracker.example'],
    ['an unparseable URL with credentials', 'http://user:S3CRET@[tracker'],
    ['credentials', 'http://user:S3CRET@tracker.example'],
    ['a token in the user part', 'https://S3CRET@tracker.example'],
    ['a query secret', 'http://tracker.example/?token=S3CRET'],
    ['a fragment', 'http://tracker.example/#S3CRET'],
  ])('refuses %s without repeating the value', (_case, value) => {
    let caught: unknown;
    try {
      trackerBaseUrl(value);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ArchonTrackerError);
    const error = caught as ArchonTrackerError;
    expect(`${error.message} ${String(error.cause ?? '')}`).not.toContain('S3CRET');
    expect(error.message).not.toContain('tracker.example');
  });
});

describe('declaredArchonTracker', () => {
  test("lists the checkout's Archon project, archived tasks included, at the configured base URL", async () => {
    const { fetch, sent } = fakeFetch(json([task('t1'), { ...task('t2'), archived: true }]));
    const tracker = declaredArchonTracker(checkout(ARCHON_PROJECT), BAREA, 'https://tracker.example/archon', fetch);
    if (tracker === null) throw new Error('an archon-primary project declares the tracker');

    expect(tracker.context.archonProjectId).toBe(PROJECT_ID);
    expect((await tracker.listProjectTasks()).map(listed => [listed.id, listed.archived])).toEqual([
      ['t1', false],
      ['t2', true],
    ]);
    expect(sent).toEqual([
      { method: 'GET', url: `https://tracker.example/archon/api/projects/${PROJECT_ID}/tasks?include_archived=true`, body: undefined },
    ]);
  });

  test('accepts a run on the declared repository in any letter case or URL form', () => {
    const yaml = ARCHON_PROJECT.replace('rahajri/BAREA', 'git@github.com:rahajri/BAREA.git');
    expect(declaredArchonTracker(checkout(yaml), { host: 'GitHub.com', path: 'Rahajri/barea' }, BASE)).not.toBeNull();
  });

  test.each([
    ['no project file', undefined],
    ['a .factory directory with no project file', null],
    ['a github-primary project', ARCHON_PROJECT.replace('primary: archon', 'primary: github')],
  ])('declares no tracker for %s, whatever the base URL or repository', (_case, yaml) => {
    const root = checkout(yaml ?? undefined);
    if (yaml === null) mkdirSync(join(root, '.factory'));
    const { fetch, sent } = fakeFetch();
    expect(declaredArchonTracker(root, { host: 'github.com', path: 'other/repo' }, undefined, fetch)).toBeNull();
    expect(sent).toEqual([]);
  });

  test.each([
    ['invalid YAML', 'project: [', BASE, /not valid YAML/],
    ['no archon_project_id', ARCHON_PROJECT.replace(/ {2}archon_project_id: .*\n/, ''), BASE, /archon_project_id/],
    ['a malformed archon_project_id', ARCHON_PROJECT.replace(PROJECT_ID, 'BAREA'), BASE, /archon_project_id/],
    ['no base URL', ARCHON_PROJECT, undefined, /is not set/],
    ['a malformed base URL', ARCHON_PROJECT, 'tracker', /is not a URL/],
  ])('refuses %s before sending anything', (_case, yaml, base, why) => {
    const { fetch, sent } = fakeFetch();
    expect(() => declaredArchonTracker(checkout(yaml), BAREA, base, fetch)).toThrow(why);
    expect(sent).toEqual([]);
  });

  test.each([
    ['another repository', { host: 'github.com', path: 'rahajri/Archon' }],
    ['the same path on another host', { host: 'ghe.example.com', path: 'rahajri/BAREA' }],
  ])("refuses a run on %s: the project file is the declared repository's", (_case, repo) => {
    const { fetch, sent } = fakeFetch();
    expect(() => declaredArchonTracker(checkout(ARCHON_PROJECT), repo, BASE, fetch)).toThrow(
      `is github.com/rahajri/BAREA's, not ${repo.host}/${repo.path}'s`
    );
    expect(sent).toEqual([]);
  });

  test.skipIf(!permissionsApply)('refuses an unreadable project before sending anything, never reading it as GitHub', () => {
    const root = checkout(ARCHON_PROJECT);
    const { fetch, sent } = fakeFetch();
    withoutAccess(join(root, '.factory'), 0o755, () => {
      expect(() => declaredArchonTracker(root, BAREA, BASE, fetch)).toThrow(ProjectContextError);
    });
    expect(sent).toEqual([]);
  });
});

describe('ArchonTracker', () => {
  const context: ArchonProjectContext = {
    projectName: 'BAREA',
    archonProjectId: PROJECT_ID,
    githubRepo: BAREA,
    trackerPrimary: 'archon',
    createGithubIssueOnReady: true,
  };
  const trackerWith = (...responses: Response[]): { tracker: ArchonTracker; sent: Sent[] } => {
    const { fetch, sent } = fakeFetch(...responses);
    return { tracker: new ArchonTracker(context, trackerBaseUrl(BASE), fetch), sent };
  };
  const newTask = {
    title: 'Ship it',
    description: '<!-- archon-discovery ship-it -->\n<!-- archon-discovery-refs ["run:review#0"] -->\nThe brief.',
    status: 'todo',
  } as const;
  const stored = (changes: Record<string, unknown> = {}): Record<string, unknown> => ({
    ...task('t1'),
    ...newTask,
    ...changes,
  });

  test("creates a todo task in the context's project, reads it back as sent, and returns its id", async () => {
    const { tracker, sent } = trackerWith(json({ message: 'Task created successfully', task: task('t1') }), json(stored()));
    expect(await tracker.createTask(newTask)).toBe('t1');
    expect(sent).toEqual([
      { method: 'POST', url: `${BASE}/api/tasks`, body: { ...newTask, project_id: PROJECT_ID } },
      { method: 'GET', url: `${BASE}/api/tasks/t1`, body: undefined },
    ]);
    expect(tracker.taskUrl('t1')).toBe(`${BASE}/api/tasks/t1`);
  });

  test.each([
    ['strips its HTML comments', { description: 'The brief.' }, 'description'],
    ['escapes its metadata', { description: newTask.description.replaceAll('<', '&lt;') }, 'description'],
    ['truncates its description', { description: newTask.description.slice(0, 40) }, 'description'],
    ['drops its description', { description: null }, 'description'],
    ['alters its title', { title: 'Ship it later' }, 'title'],
    ['alters its status', { status: 'backlog' }, 'status'],
    ['stores it in another project', { project_id: '00000000-0000-4000-8000-000000000000' }, 'project_id'],
  ])('refuses a created task the tracker %s, naming the field and the task', async (_case, changes, field) => {
    const { tracker } = trackerWith(json({ task: task('t1') }), json(stored(changes)));
    await expect(tracker.createTask(newTask)).rejects.toThrow(
      `the tracker created task t1 but reads back a different ${field}; a later pass could not recover it`
    );
  });

  test('refuses a created task that does not read back as a task', async () => {
    const { tracker } = trackerWith(json({ task: task('t1') }), new Response('{"detail":"Task not found"}', { status: 404 }));
    await expect(tracker.createTask(newTask)).rejects.toThrow('GET /api/tasks/t1 failed with 404');
  });

  test.each([
    [422, '{"detail":[{"msg":"Field required"}]}'],
    [404, '{"detail":"Project not found"}'],
    [500, 'Internal Server Error'],
  ])('reports a %i response with its status and body', async (status, body) => {
    const { tracker } = trackerWith(new Response(body, { status }));
    const error = await tracker.createTask(newTask).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ArchonTrackerError);
    expect((error as ArchonTrackerError).status).toBe(status);
    expect((error as ArchonTrackerError).message).toContain(body);
  });

  test('reports an unreachable tracker by its origin', async () => {
    const tracker = new ArchonTracker(context, trackerBaseUrl(BASE), (async () => {
      throw new TypeError('connection refused');
    }) as unknown as typeof fetch);
    await expect(tracker.listProjectTasks()).rejects.toThrow(`the tracker at ${BASE} is unreachable`);
  });

  test('refuses a response that is not a task, or a listed task without its archived flag', async () => {
    const { archived: _, ...unflagged } = task('t1');
    const { tracker } = trackerWith(json({ message: 'ok' }), json([unflagged]));
    await expect(tracker.createTask(newTask)).rejects.toThrow(/create response is not a task/);
    await expect(tracker.listProjectTasks()).rejects.toThrow(/not a task/);
  });
});

// --- the tracker's contract ------------------------------------------------------------

type Schema = Record<string, unknown>;

/** The capture `.archon/scripts/archon-tracker-openapi.ts` writes from the tracker's OpenAPI document. */
const contract = JSON.parse(readFileSync(CAPTURE, 'utf8')) as {
  paths: Record<string, Record<string, { parameters: Schema[]; requestBody: Schema | null }>>;
  components: { schemas: Record<string, Schema> };
};

function resolveRef(schema: Schema): Schema {
  const ref = schema.$ref;
  return typeof ref === 'string' ? (contract.components.schemas[ref.replace('#/components/schemas/', '')] ?? {}) : schema;
}

const SCALARS: Record<string, (value: unknown) => boolean> = {
  string: value => typeof value === 'string',
  boolean: value => typeof value === 'boolean',
  integer: value => Number.isInteger(value),
  null: value => value === null,
};

/** Why `value` does not satisfy `schema`, for the JSON types this contract uses; null when it does. */
function mismatch(value: unknown, schema: Schema, at: string): string | null {
  const resolved = resolveRef(schema);
  if (Array.isArray(resolved.anyOf)) {
    return (resolved.anyOf as Schema[]).some(branch => mismatch(value, branch, at) === null) ? null : `${at} matches no anyOf branch`;
  }
  if (resolved.type === 'object') return objectMismatch(value, resolved, at);
  const check = typeof resolved.type === 'string' ? SCALARS[resolved.type] : undefined;
  if (check === undefined) return `${at} has a type this check does not know: ${JSON.stringify(resolved.type)}`;
  return check(value) ? null : `${at} is not ${resolved.type === 'integer' ? 'an' : 'a'} ${String(resolved.type)}`;
}

function objectMismatch(value: unknown, schema: Schema, at: string): string | null {
  if (!isObject(value)) return `${at} is not an object`;
  const properties = (schema.properties ?? {}) as Record<string, Schema>;
  const missing = ((schema.required ?? []) as string[]).find(key => !(key in value));
  if (missing !== undefined) return `${at}.${missing} is required`;
  for (const [key, field] of Object.entries(value)) {
    const declared = properties[key];
    const problem = declared === undefined ? `${at}.${key} is not in the contract` : mismatch(field, declared, `${at}.${key}`);
    if (problem !== null) return problem;
  }
  return null;
}

type Operation = (typeof contract.paths)[string][string];

function queryProblems(url: URL, operation: Operation): string[] {
  return [...url.searchParams].flatMap(([name, raw]) => {
    const parameter = operation.parameters.find(entry => entry.in === 'query' && entry.name === name);
    if (parameter === undefined) return [`query ${name} is not in the contract`];
    const value = raw === 'true' ? true : raw === 'false' ? false : /^-?\d+$/.test(raw) ? Number(raw) : raw;
    return [mismatch(value, parameter.schema as Schema, `query ${name}`)].filter(problem => problem !== null);
  });
}

function bodyProblems(body: unknown, operation: Operation): string[] {
  const content = (operation.requestBody?.content as Record<string, { schema: Schema }> | undefined)?.['application/json'];
  if (body === undefined) return operation.requestBody?.required === true ? ['the required body is missing'] : [];
  if (content === undefined) return ['the operation takes no JSON body'];
  return [mismatch(body, content.schema, 'body')].filter(problem => problem !== null);
}

/** Every way a sent request leaves the captured contract. */
function contractProblems(request: Sent): string[] {
  const url = new URL(request.url);
  const path = url.pathname.slice(new URL(BASE).pathname.length - 1);
  const template = Object.keys(contract.paths).find(candidate =>
    new RegExp(`^${candidate.replace(/\{[^}]+\}/g, '[^/]+')}$`).test(path)
  );
  const operation = template === undefined ? undefined : contract.paths[template]?.[request.method.toLowerCase()];
  if (operation === undefined) return [`${request.method} ${path} is not in the contract`];
  return [...queryProblems(url, operation), ...bodyProblems(request.body, operation)];
}

describe("the tracker's contract", () => {
  test('every request the client sends is one the captured OpenAPI document declares', async () => {
    const created = { title: 'A defect', description: 'The brief.', status: 'todo' } as const;
    const { fetch, sent } = fakeFetch(json([task('t1')]), json({ task: task('t2') }), json({ ...task('t2'), ...created }));
    const tracker = declaredArchonTracker(checkout(ARCHON_PROJECT), BAREA, BASE, fetch);
    await tracker?.listProjectTasks();
    await tracker?.createTask(created);

    expect(sent.map(request => request.method)).toEqual(['GET', 'POST', 'GET']);
    expect(sent.map(contractProblems)).toEqual([[], [], []]);
  });

  test('the check refuses a request outside the contract', () => {
    const at = `${BASE}/api/projects/${PROJECT_ID}/tasks`;
    expect(contractProblems({ method: 'GET', url: `${at}?archived=true`, body: undefined })).toEqual([
      'query archived is not in the contract',
    ]);
    expect(contractProblems({ method: 'POST', url: `${BASE}/api/tasks`, body: { title: 'x' } })).toEqual(['body.project_id is required']);
    expect(contractProblems({ method: 'POST', url: `${BASE}/api/tasks`, body: { project_id: 'p', title: 'x', labels: [] } })).toEqual([
      'body.labels is not in the contract',
    ]);
    expect(contractProblems({ method: 'POST', url: `${BASE}/api/tasks`, body: { project_id: 'p', title: 1 } })).toEqual([
      'body.title is not a string',
    ]);
    expect(contractProblems({ method: 'PUT', url: `${BASE}/api/tasks/t1`, body: {} })).toEqual(['PUT /api/tasks/t1 is not in the contract']);
    expect(contractProblems({ method: 'GET', url: `${BASE}/api/tasks`, body: undefined })).toEqual(['GET /api/tasks is not in the contract']);
  });
});
