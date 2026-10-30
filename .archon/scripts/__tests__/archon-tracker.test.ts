import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from './temp-roots';
import {
  ArchonTracker,
  ArchonTrackerError,
  archonTrackerFor,
  trackerBaseUrl,
} from '../../workflows/sdlc/.shared/archon-tracker';
import {
  type ArchonProjectContext,
  ProjectContextError,
  readProjectContext,
  requireArchonTracker,
} from '../../workflows/sdlc/.shared/project-context';

const track = trackTempRoots();

const PROJECT_ID = 'd9f7bb82-5fbc-43d1-aec5-b30006e98182';
const BASE = 'http://127.0.0.1:8181';

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
  return { id, project_id: projectId, title: `task ${id}`, status: 'todo', assignee: 'User' };
}

const json = (value: unknown, status = 200): Response => Response.json(value, { status });

describe('readProjectContext', () => {
  test('reads a valid project file into a context', () => {
    expect(readProjectContext(checkout(ARCHON_PROJECT))).toEqual({
      projectName: 'BAREA',
      archonProjectId: PROJECT_ID,
      githubRepo: 'rahajri/BAREA',
      trackerPrimary: 'archon',
      createGithubIssueOnReady: true,
    });
  });

  test('refuses a checkout with no project file', () => {
    expect(() => readProjectContext(checkout())).toThrow(/project\.yaml does not exist/);
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
    ['tracker.create_github_issue_on_ready', ARCHON_PROJECT.replace('ready: true', 'ready: "yes"')],
    ['tracker.primary', ARCHON_PROJECT.replace('primary: archon', 'primary: jira')],
  ])('refuses an invalid %s', (field, yaml) => {
    expect(() => readProjectContext(checkout(yaml))).toThrow(ProjectContextError);
    expect(() => readProjectContext(checkout(yaml))).toThrow(field);
  });

  test('a github-primary project needs no archon_project_id and is not an archon tracker', () => {
    const yaml = ARCHON_PROJECT.replace(/ {2}archon_project_id: .*\n/, '').replace('primary: archon', 'primary: github');
    const context = readProjectContext(checkout(yaml));
    expect(context).toMatchObject({ trackerPrimary: 'github', archonProjectId: null });
    expect(() => requireArchonTracker(context)).toThrow(/tracker\.primary=github, not archon/);
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
});

describe('archonTrackerFor', () => {
  test("creates the task in the checkout's Archon project", async () => {
    const { fetch, sent } = fakeFetch(json({ message: 'Task created successfully', task: task('t1') }));
    const tracker = archonTrackerFor(checkout(ARCHON_PROJECT), BASE, fetch);

    expect(tracker.context.archonProjectId).toBe(PROJECT_ID);
    const created = await tracker.createTask({ title: 'Ship it', priority: 'high' });

    expect(created).toEqual({ id: 't1', project_id: PROJECT_ID, title: 'task t1', status: 'todo' });
    expect(sent).toEqual([
      { method: 'POST', url: `${BASE}/api/tasks`, body: { title: 'Ship it', priority: 'high', project_id: PROJECT_ID } },
    ]);
  });

  test('sends requests to the configured base URL', async () => {
    const { fetch, sent } = fakeFetch(json([task('t1')]));
    await archonTrackerFor(checkout(ARCHON_PROJECT), 'https://tracker.example/archon', fetch).listProjectTasks();
    expect(sent[0]?.url).toBe(`https://tracker.example/archon/api/projects/${PROJECT_ID}/tasks`);
  });

  test.each([
    ['no project file', undefined, BASE],
    ['invalid YAML', 'project: [', BASE],
    ['no archon_project_id', ARCHON_PROJECT.replace(/ {2}archon_project_id: .*\n/, ''), BASE],
    ['a malformed archon_project_id', ARCHON_PROJECT.replace(PROJECT_ID, 'BAREA'), BASE],
    ['a github-primary project', ARCHON_PROJECT.replace('primary: archon', 'primary: github'), BASE],
    ['no base URL', ARCHON_PROJECT, undefined],
    ['a malformed base URL', ARCHON_PROJECT, 'tracker'],
  ])('refuses %s before sending anything', (_case, yaml, base) => {
    const { fetch, sent } = fakeFetch();
    expect(() => archonTrackerFor(checkout(yaml), base, fetch)).toThrow();
    expect(sent).toEqual([]);
  });
});

describe('ArchonTracker', () => {
  const context: ArchonProjectContext = {
    projectName: 'BAREA',
    archonProjectId: PROJECT_ID,
    githubRepo: 'rahajri/BAREA',
    trackerPrimary: 'archon',
    createGithubIssueOnReady: true,
  };
  const trackerWith = (...responses: Response[]): { tracker: ArchonTracker; sent: Sent[] } => {
    const { fetch, sent } = fakeFetch(...responses);
    return { tracker: new ArchonTracker(context, trackerBaseUrl(BASE), fetch), sent };
  };

  test('reads, lists and updates tasks', async () => {
    const { tracker, sent } = trackerWith(
      json(task('t1')),
      json([task('t1'), task('t2')]),
      json({ message: 'Task updated successfully', task: { ...task('t1'), status: 'doing' } })
    );

    expect((await tracker.getTask('t1')).id).toBe('t1');
    expect((await tracker.listProjectTasks()).map(t => t.id)).toEqual(['t1', 't2']);
    expect((await tracker.updateTask('t1', { status: 'doing' })).status).toBe('doing');
    expect(sent).toEqual([
      { method: 'GET', url: `${BASE}/api/tasks/t1`, body: undefined },
      { method: 'GET', url: `${BASE}/api/projects/${PROJECT_ID}/tasks`, body: undefined },
      { method: 'PUT', url: `${BASE}/api/tasks/t1`, body: { status: 'doing' } },
    ]);
  });

  test.each([
    [422, '{"detail":[{"msg":"Field required"}]}'],
    [404, '{"detail":"Task not found"}'],
    [500, 'Internal Server Error'],
  ])('reports a %i response with its status and body', async (status, body) => {
    const { tracker } = trackerWith(new Response(body, { status }));
    const error = await tracker.createTask({ title: 'x' }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ArchonTrackerError);
    expect((error as ArchonTrackerError).status).toBe(status);
    expect((error as ArchonTrackerError).message).toContain(body);
  });

  test('reports an unreachable tracker', async () => {
    const tracker = new ArchonTracker(context, trackerBaseUrl(BASE), (async () => {
      throw new TypeError('connection refused');
    }) as unknown as typeof fetch);
    await expect(tracker.getTask('t1')).rejects.toThrow(/is unreachable/);
  });

  test('refuses a created task that landed in another project', async () => {
    const { tracker } = trackerWith(json({ task: task('t1', '00000000-0000-4000-8000-000000000000') }));
    await expect(tracker.createTask({ title: 'x' })).rejects.toThrow(/not d9f7bb82/);
  });

  test('refuses a response that is not a task', async () => {
    const { tracker } = trackerWith(json({ message: 'ok' }));
    await expect(tracker.createTask({ title: 'x' })).rejects.toThrow(/not a task/);
  });
});
