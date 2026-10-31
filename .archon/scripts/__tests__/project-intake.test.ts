import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from './temp-roots';
import { PACK } from './deliver-checks-harness';
import { ArchonTrackerError } from '../../workflows/sdlc/.shared/archon-tracker';
import {
  assertSameSources,
  assertSameTarget,
  createPlannedTasks,
  intakeMarker,
  intakeTarget,
  intakeTaskDescription,
  intakeTasks,
  type IntakeSources,
  parsePlan,
  parsePlanFile,
  PLAN_STATUSES,
  planFile,
  PRIORITIES,
  readIntakeSources,
} from '../../workflows/sdlc/.shared/project-intake';
import { ProjectContextError } from '../../workflows/sdlc/.shared/project-context';

const track = trackTempRoots();

const PROJECT_ID = 'd9f7bb82-5fbc-43d1-aec5-b30006e98182';
const OTHER_PROJECT = '00000000-0000-4000-8000-000000000000';
const BASE = 'http://tracker.example';

function projectYaml(primary: 'archon' | 'github' = 'archon', projectId = PROJECT_ID, repo = 'rahajri/BAREA'): string {
  return `project:
  name: BAREA
  archon_project_id: ${projectId}
  github_repo: ${repo}
tracker:
  primary: ${primary}
  create_github_issue_on_ready: true
`;
}

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout;
}

/** A committed checkout whose remote is BAREA's, with the project file when one is given. */
function checkout(yaml: string | null = projectYaml(), remote = 'https://github.com/rahajri/BAREA.git'): string {
  const root = track(mkdtempSync(join(tmpdir(), 'project-intake-')));
  git(root, 'init', '--quiet');
  git(root, 'remote', 'add', 'origin', remote);
  if (yaml !== null) {
    mkdirSync(join(root, '.factory'));
    writeFileSync(join(root, '.factory/project.yaml'), yaml);
  }
  writeFileSync(join(root, 'README.md'), '# BAREA\n');
  git(root, 'add', '.');
  git(root, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '--quiet', '-m', 'init');
  return root;
}

const SPEC_TEXT = `# Cahier des charges

## Réception matière
Chaque lot reçu est contrôlé à la réception : le contrôleur saisit le numéro de coulée,
le certificat matière et le résultat du contrôle dimensionnel avant toute mise en stock.

## Traçabilité
Chaque pièce produite est rattachée au lot matière dont elle provient, et l'historique est consultable.
`;

interface Doc {
  id: string;
  title: string;
  document_type?: string;
  content?: unknown;
  [field: string]: unknown;
}

function spec(id: string, markdown = SPEC_TEXT, title = `Spec ${id}`): Doc {
  return { id, title, document_type: 'spec', content: { markdown }, status: 'draft', version: '1.0', tags: [], author: 'User' };
}

interface Task {
  id: string;
  project_id: string;
  title: string;
  description: string | null;
  status: string;
  archived: boolean;
}

interface Tracker {
  project: { id: string; title: string };
  docs: Doc[];
  tasks: Task[];
  requests: { method: string; path: string; body: unknown }[];
  /** Fail every task creation after this many succeeded. */
  failCreatesAfter?: number;
  /** Answer project reads as if they were another project's. */
  answerAs?: string;
}

function tracker(docs: Doc[] = [spec('doc-1')], tasks: Task[] = []): Tracker {
  return { project: { id: PROJECT_ID, title: 'BAREA' }, docs, tasks, requests: [] };
}

type Route = (state: Tracker, url: URL, body: Record<string, unknown> | undefined) => Response | undefined;

const projectPath = (state: Tracker): string => `/api/projects/${state.project.id}`;
const notFound = (detail: string): Response => Response.json({ detail }, { status: 404 });

/** The tracker's project, document and task routes, as the live service answers them; undefined when a route does not match. */
const ROUTES: Record<string, Route[]> = {
  GET: [
    (state, url) =>
      url.pathname === projectPath(state) ? Response.json({ ...state.project, id: state.answerAs ?? state.project.id, docs: state.docs }) : undefined,
    (state, url) => {
      if (url.pathname !== `${projectPath(state)}/docs`) return undefined;
      const documents = state.docs.map(({ content: _, ...metadata }) => metadata);
      return Response.json({ project_id: state.answerAs ?? state.project.id, documents, total_count: documents.length });
    },
    (state, url) => {
      if (!url.pathname.startsWith(`${projectPath(state)}/docs/`)) return undefined;
      const doc = state.docs.find(entry => url.pathname === `${projectPath(state)}/docs/${entry.id}`);
      return doc === undefined ? notFound('Document not found') : Response.json(doc);
    },
    (state, url) => {
      if (url.pathname !== `${projectPath(state)}/tasks`) return undefined;
      const archived = url.searchParams.get('include_archived') === 'true';
      return Response.json(state.tasks.filter(task => archived || !task.archived));
    },
    (state, url) => {
      if (!url.pathname.startsWith('/api/tasks/')) return undefined;
      const task = state.tasks.find(entry => url.pathname === `/api/tasks/${entry.id}`);
      return task === undefined ? notFound('Task not found') : Response.json(task);
    },
  ],
  POST: [
    (state, url, body) => {
      if (url.pathname !== '/api/tasks') return undefined;
      const earlier = state.requests.filter(entry => entry.method === 'POST').length - 1;
      if (state.failCreatesAfter !== undefined && earlier >= state.failCreatesAfter) return new Response('Internal Server Error', { status: 500 });
      const task = { id: `task-${String(state.tasks.length + 1)}`, archived: false, description: null, ...body } as Task;
      state.tasks.push(task);
      return Response.json({ message: 'Task created successfully', task });
    },
  ],
};

async function handle(state: Tracker, request: Request): Promise<Response> {
  const url = new URL(request.url);
  const body = request.method === 'POST' ? ((await request.json()) as Record<string, unknown>) : undefined;
  state.requests.push({ method: request.method, path: `${url.pathname}${url.search}`, body });
  for (const route of ROUTES[request.method] ?? []) {
    const response = route(state, url, body);
    if (response !== undefined) return response;
  }
  return new Response('not found', { status: 404 });
}

function fetchOf(state: Tracker): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => handle(state, new Request(String(input), init))) as typeof fetch;
}

const ref = (document_id = 'doc-1') => ({ document_id, location: 'Réception matière' });

function plannedTask(key: string, dependencies: string[] = [], lot = 'reception'): Record<string, unknown> {
  return {
    key,
    lot,
    title: `Build ${key}`,
    description: `What ${key} builds.`,
    priority: 'high',
    dependencies,
    acceptance_criteria: [`${key} works`],
    source_refs: [ref()],
  };
}

function plan(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: 'ready',
    reason: '',
    objective: 'Trace every part to its material lot.',
    scope: { included: ['reception', 'traceability'], excluded: [] },
    assumptions: [{ text: 'Every lot has a heat number.', source_refs: [ref()] }],
    constraints: [],
    lots: [
      { key: 'reception', title: 'Material reception', summary: 'Checks at reception.' },
      { key: 'traceability', title: 'Lot traceability', summary: 'Part to lot.' },
    ],
    tasks: [plannedTask('lot-reception-check'), plannedTask('part-lot-link', ['lot-reception-check'], 'traceability')],
    open_questions: [{ text: 'Which certificate formats?', blocking: true, source_refs: [] }],
    risks: [],
    ...overrides,
  };
}

async function refusal(pending: Promise<unknown>): Promise<Error> {
  try {
    await pending;
  } catch (error) {
    return error as Error;
  }
  throw new Error('it was not refused');
}

async function sourcesOf(state: Tracker, root = checkout()): Promise<IntakeSources> {
  return readIntakeSources(intakeTarget(root, BASE, fetchOf(state)));
}

describe('where project intake reads and writes', () => {
  test("reads and writes the Archon project the checkout's project file declares, at the configured tracker", async () => {
    const state = tracker();
    const target = intakeTarget(checkout(), `${BASE}/`, fetchOf(state));
    expect(target.tracker.context).toMatchObject({ archonProjectId: PROJECT_ID, trackerPrimary: 'archon', githubRepo: { host: 'github.com', path: 'rahajri/BAREA' } });
    expect(target.docs.context).toBe(target.tracker.context);
    expect(target.tracker.baseUrl.href).toBe(`${BASE}/`);
    await readIntakeSources(target);
    expect(state.requests.map(request => request.path)).toEqual([
      `/api/projects/${PROJECT_ID}`,
      `/api/projects/${PROJECT_ID}/docs`,
      `/api/projects/${PROJECT_ID}/docs/doc-1`,
    ]);
  });

  test.each([
    ['no project file', null, /has no \.factory\/project\.yaml/],
    ['a project that keeps its work on GitHub', projectYaml('github'), /keeps its work on GitHub/],
  ])('refuses a checkout with %s before any request: intake never falls back to GitHub', (_case, yaml, why) => {
    const state = tracker();
    expect(() => intakeTarget(checkout(yaml), BASE, fetchOf(state))).toThrow(why);
    expect(() => intakeTarget(checkout(yaml), BASE, fetchOf(state))).toThrow('needs .factory/project.yaml with tracker.primary archon');
    expect(state.requests).toEqual([]);
  });

  test('refuses a checkout that is not the repository its project file names', () => {
    const state = tracker();
    expect(() => intakeTarget(checkout(projectYaml(), 'https://github.com/rahajri/Archon.git'), BASE, fetchOf(state))).toThrow(
      'names github.com/rahajri/BAREA, but no git remote of this checkout points at it'
    );
    expect(state.requests).toEqual([]);
  });

  test.each([
    ['an unset base URL', undefined, /is not set/],
    ['a base URL with credentials', 'http://user:S3CRET@tracker.example', /must not carry credentials/],
    ['a base URL with a query', 'http://tracker.example/?token=S3CRET', /must not carry credentials/],
    ['a base URL with a fragment', 'http://tracker.example/#S3CRET', /must not carry credentials/],
  ])('refuses %s without repeating it', (_case, base, why) => {
    const error = (() => {
      try {
        intakeTarget(checkout(), base);
      } catch (caught) {
        return caught as Error;
      }
      throw new Error('accepted');
    })();
    expect(error).toBeInstanceOf(ArchonTrackerError);
    expect(error.message).toMatch(why);
    expect(error.message).not.toContain('S3CRET');
  });

  test('refuses an invalid project file rather than reading it as no project', () => {
    expect(() => intakeTarget(checkout('project: ['), BASE)).toThrow(ProjectContextError);
  });
});

describe("the project's specifications", () => {
  test('reads one specification in full, with its metadata and fingerprint, and sets other documents aside', async () => {
    const note = { id: 'doc-0', title: 'Meeting notes', document_type: 'note', content: { markdown: 'notes' } };
    const sources = await sourcesOf(tracker([spec('doc-1'), note]));
    expect(sources.project).toEqual({ id: PROJECT_ID, title: 'BAREA' });
    expect(sources.repo).toEqual({ host: 'github.com', path: 'rahajri/BAREA' });
    expect(sources.tracker_base_url).toBe(`${BASE}/`);
    expect(sources.documents).toEqual([
      {
        id: 'doc-1',
        title: 'Spec doc-1',
        document_type: 'spec',
        metadata: { status: 'draft', version: '1.0', tags: [], author: 'User' },
        sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        content: SPEC_TEXT,
      },
    ]);
    expect(sources.set_aside).toEqual([{ id: 'doc-0', title: 'Meeting notes', document_type: 'note' }]);
  });

  test('reads every specification when there are several, in a stable order', async () => {
    const sources = await sourcesOf(tracker([spec('doc-b'), spec('doc-a')]));
    expect(sources.documents.map(document => document.id)).toEqual(['doc-a', 'doc-b']);
  });

  test('refuses a project with no documents, saying where to upload one', async () => {
    await expect(sourcesOf(tracker([]))).rejects.toThrow(
      `Archon project "BAREA" (${PROJECT_ID}) has no documents. Upload the specification in the project's Docs tab with the type spec`
    );
  });

  test('refuses a project whose documents include no specification, naming what it holds', async () => {
    const readme = { id: 'doc-r', title: 'README', document_type: 'note', content: { markdown: SPEC_TEXT } };
    await expect(sourcesOf(tracker([readme]))).rejects.toThrow('has no document typed spec ("README" (doc-r) typed note)');
  });

  test.each([
    ['as the Docs tab creates it', { markdown: '# BAREA_DT_cadrage\n\nStart writing your document here...' }],
    ['holding its title alone', { markdown: '# Spec doc-1\n\nSpec doc-1\n' }],
    ['holding headings alone', { markdown: '# Scope\n## Reception\n### Traceability\n' }],
    ['with no content', null],
    ['with empty markdown', { markdown: '' }],
  ])('refuses a specification %s rather than planning from guesses', async (_case, content) => {
    await expect(sourcesOf(tracker([{ ...spec('doc-1'), content }, spec('doc-2')]))).rejects.toThrow(
      /"Spec doc-1" \(doc-1\) is typed spec but holds \d+ words beyond its headings, too few to plan from/
    );
  });

  test('refuses a specification whose content is not markdown, without quoting it', async () => {
    const error = await refusal(sourcesOf(tracker([{ ...spec('doc-1'), content: { html: '<p>SECRET-CONTENT</p>' } }])));
    expect(error.message).toContain('stores its content as fields html');
    expect(error.message).not.toContain('SECRET-CONTENT');
  });

  test('refuses a project that reads back as another', async () => {
    await expect(sourcesOf({ ...tracker(), answerAs: OTHER_PROJECT })).rejects.toThrow(`the tracker does not read back project ${PROJECT_ID}`);
  });

  test("refuses a document list that is not the project's, and a document that reads back as another", async () => {
    const state = tracker();
    const listing = (body: unknown) => (async (input: RequestInfo | URL, init?: RequestInit) =>
      String(input).endsWith('/docs') ? Response.json(body) : handle(state, new Request(String(input), init))) as typeof fetch;
    const other = { project_id: OTHER_PROJECT, documents: [], total_count: 0 };
    await expect(readIntakeSources(intakeTarget(checkout(), BASE, listing(other)))).rejects.toThrow(`the tracker's document list is not project ${PROJECT_ID}'s`);
    const partial = { project_id: PROJECT_ID, documents: [{ id: 'doc-1' }], total_count: 2 };
    await expect(readIntakeSources(intakeTarget(checkout(), BASE, listing(partial)))).rejects.toThrow('lists 1 of project');

    const swapped = (async (input: RequestInfo | URL, init?: RequestInit) =>
      String(input).endsWith('/docs/doc-1')
        ? Response.json({ ...spec('doc-9'), content: { markdown: 'PRIVATE' } })
        : handle(state, new Request(String(input), init))) as typeof fetch;
    const error = await refusal(readIntakeSources(intakeTarget(checkout(), BASE, swapped)));
    expect(error.message).toContain(`the tracker does not read back document doc-1 of project ${PROJECT_ID}: an object with id doc-9`);
    expect(error.message).not.toContain('PRIVATE');
  });

  test('a fingerprint depends on what was analysed, not on listing order or tracker metadata', async () => {
    const first = await sourcesOf(tracker([spec('doc-1'), spec('doc-2')]));
    const reordered = await sourcesOf(tracker([{ ...spec('doc-2'), status: 'review', version: '1.1' }, spec('doc-1')]));
    expect(reordered.fingerprint).toBe(first.fingerprint);
    expect(reordered.documents.map(document => document.sha256)).toEqual(first.documents.map(document => document.sha256));

    const edited = await sourcesOf(tracker([spec('doc-1', `${SPEC_TEXT}\nUne exigence de plus.`), spec('doc-2')]));
    const retitled = await sourcesOf(tracker([spec('doc-1', SPEC_TEXT, 'Renamed'), spec('doc-2')]));
    const fewer = await sourcesOf(tracker([spec('doc-1')]));
    expect(new Set([first, edited, retitled, fewer].map(sources => sources.fingerprint)).size).toBe(4);
  });
});

describe('the plan', () => {
  const sources = { documents: [{ id: 'doc-1' }] };

  test('accepts a plan that holds together', () => {
    expect(parsePlan(plan(), sources).tasks.map(task => task.key)).toEqual(['lot-reception-check', 'part-lot-link']);
  });

  test.each([
    ['an unknown dependency', { tasks: [plannedTask('a-task', ['nowhere'])] }, 'task a-task depends on nowhere, which the plan does not declare'],
    ['a self dependency', { tasks: [plannedTask('a-task', ['a-task'])] }, 'task a-task depends on itself'],
    ['a dependency cycle', { tasks: [plannedTask('a-task', ['b-task']), plannedTask('b-task', ['a-task'])] }, 'the dependencies of a-task, b-task form a cycle'],
    ['a task in an undeclared lot', { tasks: [plannedTask('a-task', [], 'nowhere')] }, 'task a-task is in lot nowhere'],
    ['a duplicate task key', { tasks: [plannedTask('a-task'), plannedTask('a-task')] }, 'task key a-task is used more than once'],
    ['a task without acceptance criteria', { tasks: [{ ...plannedTask('a-task'), acceptance_criteria: [] }] }, 'tasks[0].acceptance_criteria has fewer than 1 entries'],
    ['a task without sources', { tasks: [{ ...plannedTask('a-task'), source_refs: [] }] }, 'tasks[0].source_refs has fewer than 1 entries'],
    ['a citation of a document not analysed', { tasks: [{ ...plannedTask('a-task'), source_refs: [ref('doc-x')] }] }, 'cites doc-x, which is not an analysed source'],
    ['an assumption without a source', { assumptions: [{ text: 'Guessed.', source_refs: [] }] }, 'assumptions[0].source_refs has fewer than 1 entries'],
    ['a malformed key', { tasks: [{ ...plannedTask('a-task'), key: 'A Task' }] }, 'tasks[0].key is not a key'],
    ['a multi-line title', { tasks: [{ ...plannedTask('a-task'), title: 'one\ntwo' }] }, 'tasks[0].title is not one line'],
    ['an unknown priority', { tasks: [{ ...plannedTask('a-task'), priority: 'urgent' }] }, 'tasks[0].priority is not one of'],
    ['intake metadata in a description', { tasks: [{ ...plannedTask('a-task'), description: '<!-- archon-project-intake x-y-z -->' }] }, 'tasks[0].description holds tracker metadata'],
    ['discovery metadata in a description', { tasks: [{ ...plannedTask('a-task'), description: '<!--archon-discovery x -->' }] }, 'tasks[0].description holds tracker metadata'],
    ['a ready plan with no task', { tasks: [] }, 'tasks has fewer than 1 entries'],
    ['an insufficient plan with no reason', { status: 'insufficient', reason: ' ', lots: [], tasks: [] }, 'reason is not a non-empty string'],
  ])('refuses %s', (_case, overrides, why) => {
    expect(() => parsePlan(plan(overrides), sources)).toThrow(why);
  });

  test("the plan node's schema admits the statuses, priorities and fields the plan is read with", () => {
    const workflow = Bun.YAML.parse(readFileSync(join(PACK, 'project-intake/archon-project-intake.yaml'), 'utf8')) as {
      nodes: { id: string; output_format?: { required: string[]; properties: Record<string, { enum?: string[]; items?: { properties: Record<string, { enum?: string[] }> } }> } }[];
    };
    const schema = workflow.nodes.find(node => node.id === 'plan')?.output_format;
    expect(schema?.properties.status?.enum).toEqual([...PLAN_STATUSES]);
    expect(schema?.properties.tasks?.items?.properties.priority?.enum).toEqual([...PRIORITIES]);
    expect([...(schema?.required ?? [])].sort()).toEqual(Object.keys(parsePlan(plan(), sources)).sort());
  });
});

describe('the intake marker', () => {
  const task = (id: string, description: string | null, archived = false, project_id = PROJECT_ID): Task => ({
    id,
    project_id,
    title: 'A task',
    description,
    status: 'todo',
    archived,
  });

  test('is one canonical comment per key, and reads back to its key', () => {
    expect(intakeMarker('part-lot-link')).toBe('<!-- archon-project-intake part-lot-link -->');
    expect(() => intakeMarker('Not A Key')).toThrow('is not a planned task key');
    const found = intakeTasks([task('t1', `${intakeMarker('part-lot-link')}\nThe brief.`), task('t2', 'a task a person wrote'), task('t3', null)]);
    expect([...found].map(([key, entry]) => [key, entry.id])).toEqual([['part-lot-link', 't1']]);
  });

  test('ignores a discoveries task, and the discoveries pass ignores an intake task', async () => {
    const { filedDiscoveries } = await import('../../workflows/sdlc/.shared/discoveries');
    const discovery = task('t1', '<!-- archon-discovery a-defect -->\nThe brief.');
    const intake = task('t2', `${intakeMarker('part-lot-link')}\nThe brief.`);
    expect([...intakeTasks([discovery, intake]).keys()]).toEqual(['part-lot-link']);
    expect(filedDiscoveries([discovery, intake]).map(entry => entry.key)).toEqual(['a-defect']);
  });

  test.each([
    ['a marker after the first line', `The brief.\n${'<!-- archon-project-intake a-key -->'}`],
    ['a second marker', `<!-- archon-project-intake a-key -->\n<!-- archon-project-intake b-key -->`],
    ['a marker in other spacing', '<!--archon-project-intake a-key-->'],
    ['a marker in another case', '<!-- ARCHON-PROJECT-INTAKE a-key -->'],
    ['a marker with no key', '<!-- archon-project-intake  -->'],
    ['a marker with a malformed key', '<!-- archon-project-intake A Key -->'],
  ])('refuses %s rather than reading the task as unrelated', (_case, description) => {
    expect(() => intakeTasks([task('t9', description)])).toThrow('task t9 carries archon-project-intake metadata that is not one canonical marker');
  });

  test('refuses two tasks with one key, archived or not', () => {
    const marker = `${intakeMarker('part-lot-link')}\nThe brief.`;
    expect(() => intakeTasks([task('t1', marker), task('t2', marker, true)])).toThrow('more than one task carries the intake marker of part-lot-link (tasks t1, t2)');
  });
});

describe('creating the approved plan', () => {
  async function approved(state: Tracker, overrides: Record<string, unknown> = {}) {
    const root = checkout();
    const target = intakeTarget(root, BASE, fetchOf(state));
    const sources = await readIntakeSources(target);
    const file = parsePlanFile(JSON.parse(JSON.stringify(planFile(sources, parsePlan(plan(overrides), sources)))));
    state.requests.length = 0;
    return { root, target, file };
  }

  test("creates each task as a todo task in the project, dependencies first, carrying its marker and the plan's metadata", async () => {
    const state = tracker();
    const { target, file } = await approved(state, {
      tasks: [plannedTask('part-lot-link', ['lot-reception-check'], 'traceability'), plannedTask('lot-reception-check')],
    });
    const { created, recovered } = await createPlannedTasks(target.tracker, file);

    expect(created.map(entry => entry.key)).toEqual(['lot-reception-check', 'part-lot-link']);
    expect(created[0]?.url).toBe(`${BASE}/api/tasks/task-1`);
    expect(recovered).toEqual([]);
    const posts = state.requests.filter(request => request.method === 'POST');
    expect(posts.map(request => request.path)).toEqual(['/api/tasks', '/api/tasks']);
    expect(posts.map(request => request.body)).toEqual([
      { project_id: PROJECT_ID, status: 'todo', title: 'Build lot-reception-check', description: expect.any(String) },
      { project_id: PROJECT_ID, status: 'todo', title: 'Build part-lot-link', description: expect.any(String) },
    ]);
    expect(state.tasks.map(task => [task.project_id, task.status])).toEqual([
      [PROJECT_ID, 'todo'],
      [PROJECT_ID, 'todo'],
    ]);
    expect((posts[1]?.body as { description: string }).description).toBe(
      [
        '<!-- archon-project-intake part-lot-link -->',
        'What part-lot-link builds.',
        '',
        '**Lot:** Lot traceability (`traceability`)',
        '**Priority:** high',
        '**Depends on:** `lot-reception-check` Build lot-reception-check',
        '',
        '**Acceptance criteria**',
        '- [ ] part-lot-link works',
        '',
        '**Sources**',
        '- Spec doc-1 (`doc-1`): Réception matière',
        '',
        '---',
        `Planned by the archon-project-intake workflow from the project's specifications at fingerprint ${file.fingerprint.slice(0, 12)}.`,
      ].join('\n')
    );
  });

  test('the same plan renders the same description every time', async () => {
    const { file } = await approved(tracker());
    const task = file.plan.tasks[0];
    if (task === undefined) throw new Error('the plan has a task');
    expect(intakeTaskDescription(task, file)).toBe(intakeTaskDescription(task, parsePlanFile(JSON.parse(JSON.stringify(file)))));
  });

  test('a rerun recovers every task an earlier run created, archived ones included, and creates nothing', async () => {
    const state = tracker();
    const { target, file } = await approved(state);
    await createPlannedTasks(target.tracker, file);
    const first = state.tasks[0];
    if (first === undefined) throw new Error('a task was created');
    first.archived = true;
    state.requests.length = 0;

    const again = await createPlannedTasks(target.tracker, file);
    expect(again.created).toEqual([]);
    expect(again.recovered.map(entry => entry.key)).toEqual(['lot-reception-check', 'part-lot-link']);
    expect(state.requests.map(request => `${request.method} ${request.path}`)).toEqual([`GET /api/projects/${PROJECT_ID}/tasks?include_archived=true`]);
    expect(state.tasks).toHaveLength(2);
  });

  test('a failure partway names what was created, and running again creates only the rest', async () => {
    const state = tracker();
    const { target, file } = await approved(state);
    state.failCreatesAfter = 1;
    await expect(createPlannedTasks(target.tracker, file)).rejects.toThrow(
      'creating part-lot-link failed after this run created lot-reception-check; running the intake\'s create step again recovers what was created'
    );
    state.failCreatesAfter = undefined;
    const again = await createPlannedTasks(target.tracker, file);
    expect([again.recovered.map(entry => entry.key), again.created.map(entry => entry.key)]).toEqual([['lot-reception-check'], ['part-lot-link']]);
    expect(state.tasks.map(task => task.title)).toEqual(['Build lot-reception-check', 'Build part-lot-link']);
  });

  test('refuses before any write when two tasks carry one key or intake metadata is corrupt', async () => {
    for (const tasks of [
      [
        { id: 'x1', project_id: PROJECT_ID, title: 't', description: '<!-- archon-project-intake part-lot-link -->', status: 'todo', archived: false },
        { id: 'x2', project_id: PROJECT_ID, title: 't', description: '<!-- archon-project-intake part-lot-link -->', status: 'done', archived: true },
      ],
      [{ id: 'x3', project_id: PROJECT_ID, title: 't', description: 'brief\n<!-- archon-project-intake part-lot-link -->', status: 'todo', archived: false }],
    ]) {
      const state = tracker([spec('doc-1')], tasks);
      const { target, file } = await approved(state);
      await expect(createPlannedTasks(target.tracker, file)).rejects.toThrow(/archon-project-intake metadata|more than one task/);
      expect(state.requests.filter(request => request.method === 'POST')).toEqual([]);
    }
  });

  test('refuses before any write when the specifications changed since they were analysed', async () => {
    for (const change of [
      (state: Tracker) => Object.assign(state.docs[0] as Doc, { content: { markdown: `${SPEC_TEXT}\nUne exigence ajoutée.` } }),
      (state: Tracker) => state.docs.push(spec('doc-2')),
      (state: Tracker) => Object.assign(state.docs[0] as Doc, { document_type: 'note' }) && state.docs.push(spec('doc-3')),
    ]) {
      const state = tracker();
      const { target, file } = await approved(state);
      change(state);
      assertSameTarget(file, target);
      const current = await readIntakeSources(target);
      expect(() => assertSameSources(file, current)).toThrow(/^nothing was written: the project's specifications changed since they were analysed \((edited doc-1|added doc-2|added doc-3; removed doc-1)\)/);
      expect(state.requests.filter(request => request.method === 'POST')).toEqual([]);
    }
  });

  test('refuses before any write when the project, tracker or repository changed since the plan', async () => {
    const state = tracker();
    const { root, file } = await approved(state);
    writeFileSync(join(root, '.factory/project.yaml'), projectYaml('archon', OTHER_PROJECT));
    expect(() => assertSameTarget(file, intakeTarget(root, BASE, fetchOf(state)))).toThrow(
      `nothing was written: .factory/project.yaml now names project ${OTHER_PROJECT}, not ${PROJECT_ID}`
    );
    writeFileSync(join(root, '.factory/project.yaml'), projectYaml());
    expect(() => assertSameTarget(file, intakeTarget(root, 'http://other-tracker.example', fetchOf(state)))).toThrow(
      'ARCHON_TRACKER_BASE_URL now names http://other-tracker.example/, not http://tracker.example/'
    );
    const moved = checkout(projectYaml('archon', PROJECT_ID, 'rahajri/Other'), 'https://github.com/rahajri/Other.git');
    expect(() => assertSameTarget(file, intakeTarget(moved, BASE, fetchOf(state)))).toThrow(
      'the repository is now github.com/rahajri/Other, not github.com/rahajri/BAREA'
    );
    expect(state.requests).toEqual([]);
  });
});

// --- the scripts, end to end against a tracker over HTTP ------------------------------------

const SCRIPTS = join(PACK, 'project-intake/scripts');

async function runScript(name: string, cwd: string, artifacts: string, base: string, env: Record<string, string> = {}) {
  const child = Bun.spawn(['bun', join(SCRIPTS, `${name}.ts`)], {
    cwd,
    env: { ...process.env, ARTIFACTS_DIR: artifacts, ARCHON_TRACKER_BASE_URL: base, ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { code, stdout, stderr };
}

describe('the workflow scripts', () => {
  test('read, propose, and after approval create, writing only run artifacts and tracker tasks', async () => {
    const state = tracker();
    const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: request => handle(state, request) });
    try {
      const base = `http://127.0.0.1:${String(server.port)}`;
      const root = checkout();
      const before = git(root, 'status', '--porcelain', '--ignored') + git(root, 'rev-parse', 'HEAD');
      const artifacts = track(mkdtempSync(join(tmpdir(), 'project-intake-artifacts-')));

      const sources = await runScript('sources', root, artifacts, base);
      expect(sources).toMatchObject({ code: 0, stderr: '' });
      expect(JSON.parse(sources.stdout)).toMatchObject({ project_id: PROJECT_ID, documents: 1 });

      const proposal = await runScript('proposal', root, artifacts, base, { INPUTS_PLAN: JSON.stringify(plan()) });
      expect(proposal).toMatchObject({ code: 0, stderr: '' });
      const question = (JSON.parse(proposal.stdout) as { question: string }).question;
      expect(question).toContain('Project intake proposes 2 tasks in 2 lots');
      expect(question).toContain('2 to create as todo, 0 already there');
      expect(question).toContain('Which certificate formats?');
      expect(state.requests.filter(request => request.method === 'POST')).toEqual([]);

      const create = await runScript('create', root, artifacts, base);
      expect(create).toMatchObject({ code: 0, stderr: '' });
      expect(JSON.parse(create.stdout)).toMatchObject({ created: [{ key: 'lot-reception-check' }, { key: 'part-lot-link' }], recovered: [] });
      const rerun = await runScript('create', root, artifacts, base);
      expect(JSON.parse(rerun.stdout)).toMatchObject({ created: [], recovered: [{ key: 'lot-reception-check' }, { key: 'part-lot-link' }] });
      expect(state.tasks).toHaveLength(2);

      expect(git(root, 'status', '--porcelain', '--ignored') + git(root, 'rev-parse', 'HEAD')).toBe(before);
    } finally {
      server.stop(true);
    }
  }, 60_000);

  test('an insufficient plan stops before the operator is asked', async () => {
    const root = checkout();
    const artifacts = track(mkdtempSync(join(tmpdir(), 'project-intake-artifacts-')));
    mkdirSync(join(artifacts, 'intake'));
    writeFileSync(join(artifacts, 'intake/sources.json'), JSON.stringify({ documents: [{ id: 'doc-1' }] }));
    writeFileSync(join(artifacts, 'intake/tasks.json'), '[]');
    const insufficient = plan({ status: 'insufficient', reason: 'The document holds only a title.', lots: [], tasks: [], assumptions: [], open_questions: [] });
    const run = await runScript('proposal', root, artifacts, BASE, { INPUTS_PLAN: JSON.stringify(insufficient) });
    expect(run.code).toBe(1);
    expect(run.stdout).toBe('');
    expect(run.stderr).toContain('nothing was planned: the specifications are not enough to plan from without guessing. The document holds only a title.');
  }, 60_000);
});
