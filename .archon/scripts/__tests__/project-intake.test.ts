import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from './temp-roots';
import { PACK } from './deliver-checks-harness';
import { ArchonTrackerError, UnconfirmedTaskError } from '../../workflows/sdlc/.shared/archon-tracker';
import {
  assertSameSources,
  assertSameTarget,
  CREATE_OUTPUT,
  createPlannedTasks,
  intakeMarker,
  intakeTarget,
  intakeTaskDescription,
  intakeTasks,
  type IntakeSources,
  parseIntakeSources,
  parseIntakeTaskSummaries,
  parsePlan,
  parsePlanFile,
  PLAN_SCHEMA,
  planFile,
  PROPOSAL_OUTPUT,
  readIntakeSources,
  SOURCES_OUTPUT,
} from '../../workflows/sdlc/.shared/project-intake';
import { ProjectContextError } from '../../workflows/sdlc/.shared/project-context';
import {
  type Doc,
  fetchOf,
  git,
  handle,
  intakeCheckout,
  intakeTask,
  plan,
  plannedTask,
  type PlanJson,
  PROJECT_ID,
  projectYaml,
  ref,
  spec,
  SPEC_TEXT,
  type Task,
  type Tracker,
  tracker,
} from './fixtures/project-intake';

const track = trackTempRoots();

const OTHER_PROJECT = '00000000-0000-4000-8000-000000000000';
const BASE = 'http://tracker.example';

/** A committed checkout whose remote is BAREA's, with the project file when one is given. */
function checkout(yaml: string | null = projectYaml(), remote?: string): string {
  return intakeCheckout(track, yaml, remote);
}

async function refusal(pending: Promise<unknown>): Promise<Error> {
  try {
    await pending;
  } catch (error) {
    return error as Error;
  }
  throw new Error('it was not refused');
}

/** The `output_format` the workflow declares for node `id`. */
function outputFormat(id: string): unknown {
  const workflow = Bun.YAML.parse(readFileSync(join(PACK, 'project-intake/archon-project-intake.yaml'), 'utf8')) as {
    nodes: { id: string; output_format?: unknown }[];
  };
  return workflow.nodes.find(node => node.id === id)?.output_format;
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
    ['a task without acceptance criteria', { tasks: [{ ...plannedTask('a-task'), acceptance_criteria: [] }] }, 'plan.tasks[0].acceptance_criteria has fewer than 1 entries'],
    ['a blank acceptance criterion', { tasks: [{ ...plannedTask('a-task'), acceptance_criteria: [' '] }] }, 'plan.tasks[0].acceptance_criteria[0] does not match'],
    ['a task without sources', { tasks: [{ ...plannedTask('a-task'), source_refs: [] }] }, 'plan.tasks[0].source_refs has fewer than 1 entries'],
    ['a citation of a document not analysed', { tasks: [{ ...plannedTask('a-task'), source_refs: [ref('doc-x')] }] }, 'plan.tasks[0].source_refs[0] cites doc-x, which is not an analysed source'],
    ['a citation of a document not analysed in a risk', { risks: [{ text: 'Late.', source_refs: [ref('doc-x')] }] }, 'plan.risks[0].source_refs[0] cites doc-x'],
    ['a citation with no document', { tasks: [{ ...plannedTask('a-task'), source_refs: [{ document_id: '', location: 'here' }] }] }, 'plan.tasks[0].source_refs[0].document_id does not match'],
    ['a citation with no location', { tasks: [{ ...plannedTask('a-task'), source_refs: [{ document_id: 'doc-1', location: ' ' }] }] }, 'plan.tasks[0].source_refs[0].location does not match'],
    ['an assumption without a source', { assumptions: [{ text: 'Guessed.', source_refs: [] }] }, 'plan.assumptions[0].source_refs has fewer than 1 entries'],
    ['a constraint without a source', { constraints: [{ text: 'Guessed.', source_refs: [] }] }, 'plan.constraints[0].source_refs has fewer than 1 entries'],
    ['a blank scope item', { scope: { included: [''], excluded: [] } }, 'plan.scope.included[0] does not match'],
    ['a malformed key', { tasks: [{ ...plannedTask('a-task'), key: 'A Task' }] }, 'plan.tasks[0].key does not match ^[a-z0-9][a-z0-9-]{2,80}$'],
    ['a malformed lot key', { lots: [{ key: 'ab', title: 'Lot', summary: 'Its summary.' }] }, 'plan.lots[0].key does not match'],
    ['a multi-line title', { tasks: [{ ...plannedTask('a-task'), title: 'one\ntwo' }] }, 'plan.tasks[0].title does not match'],
    ['a blank lot title', { lots: [{ key: 'reception', title: ' ', summary: 'Its summary.' }] }, 'plan.lots[0].title does not match'],
    ['an unknown priority', { tasks: [{ ...plannedTask('a-task'), priority: 'urgent' }] }, 'plan.tasks[0].priority is not one of critical, high, medium, low'],
    ['an unknown status', { status: 'done' }, 'plan.status is not one of ready, insufficient'],
    ['a field the schema does not declare', { estimate: '3 days' }, 'plan.estimate is not a field it declares'],
    ['a missing field', { risks: undefined }, 'plan.risks is missing'],
    ['an open question without its blocking flag', { open_questions: [{ text: 'Which?', source_refs: [] }] }, 'plan.open_questions[0].blocking is missing'],
    ['intake metadata in a description', { tasks: [{ ...plannedTask('a-task'), description: '<!-- archon-project-intake x-y-z -->' }] }, 'plan.tasks[0].description holds archon-project-intake metadata'],
    ['discovery metadata in a description', { tasks: [{ ...plannedTask('a-task'), description: '<!--archon-discovery x -->' }] }, 'plan.tasks[0].description holds archon-discovery metadata'],
    ['discovery metadata in a criterion', { tasks: [{ ...plannedTask('a-task'), acceptance_criteria: ['Quotes <!-- ARCHON-DISCOVERY-refs [] -->'] }] }, 'plan.tasks[0].acceptance_criteria[0] holds archon-discovery metadata'],
    ['a ready plan with no task', { tasks: [] }, 'plan.tasks is empty in a ready plan'],
    ['a ready plan with no objective', { objective: ' ' }, 'plan.objective is empty in a ready plan'],
    ['an insufficient plan with no reason', { status: 'insufficient', reason: ' ', lots: [], tasks: [] }, 'plan.reason is empty, but an insufficient plan says why'],
  ])('refuses %s', (_case, overrides, why) => {
    const value = JSON.parse(JSON.stringify(plan(overrides))) as unknown;
    expect(() => parsePlan(value, sources)).toThrow(why);
  });

  test('accepts an HTML comment that is no workflow\'s task metadata', () => {
    const description = 'Keep <!-- generated --> markers and <!-- archon-notes --> as they are.';
    expect(parsePlan(plan({ tasks: [{ ...plannedTask('a-task'), description }] }), sources).tasks[0]?.description).toBe(description);
  });

  test("the plan node's output_format is the schema the plan is checked against", () => {
    expect(outputFormat('plan')).toEqual(JSON.parse(JSON.stringify(PLAN_SCHEMA)));
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

describe("the run's files", () => {
  const summary = { key: 'part-lot-link', title: 'Build it', status: 'todo', archived: true, url: `${BASE}/api/tasks/t1` };

  test('tasks.json reads back what the sources node writes', () => {
    expect(parseIntakeTaskSummaries(JSON.parse(JSON.stringify([summary])))).toEqual([summary]);
    expect(parseIntakeTaskSummaries([])).toEqual([]);
  });

  test.each([
    ['not a list', { tasks: [summary] }, 'tasks is not a list'],
    ['a key intake never writes', [{ ...summary, key: 'Part Lot Link' }], 'tasks[0].key does not match'],
    ['a missing field', [{ key: summary.key, title: summary.title, status: summary.status, url: summary.url }], 'tasks[0].archived is missing'],
    ['a field it does not write', [{ ...summary, description: 'x' }], 'tasks[0].description is not a field it declares'],
    ['an archived flag that is not a boolean', [{ ...summary, archived: 'yes' }], 'tasks[0].archived is not true or false'],
    ['one key twice', [summary, { ...summary, url: `${BASE}/api/tasks/t2` }], 'it lists part-lot-link more than once'],
  ])('tasks.json holding %s is refused', (_case, value, why) => {
    expect(() => parseIntakeTaskSummaries(value)).toThrow(`intake/tasks.json is not what this workflow wrote: `);
    expect(() => parseIntakeTaskSummaries(value)).toThrow(why);
  });

  test('sources.json reads back what the sources node writes, and refuses anything else', async () => {
    const sources = await sourcesOf(tracker([spec('doc-1'), { id: 'doc-0', title: 'Untyped', content: null }]));
    expect(parseIntakeSources(JSON.parse(JSON.stringify(sources)))).toEqual(sources);
    expect(() => parseIntakeSources({ ...sources, fingerprint: 7 })).toThrow('intake/sources.json is not what this workflow wrote: sources.fingerprint is not a string');
    expect(() => parseIntakeSources({ ...sources, documents: [{ id: 'doc-1' }] })).toThrow('sources.documents[0].title is missing');
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

  const keys = (written: { key: string }[]) => written.map(entry => entry.key);

  test('a creation the tracker refuses before storing anything names what this run created, and running again creates only the rest', async () => {
    const state = tracker();
    const { target, file } = await approved(state);
    state.failCreates = { after: 0, status: 422, stored: false };
    const first = await refusal(createPlannedTasks(target.tracker, file));
    expect(first.message).toBe(
      'the tracker refused to create lot-reception-check: POST /api/tasks failed with 422: failed with 422 lot-reception-check was the first task this run tried to create. Running the create step again recovers what this run created and creates the rest.'
    );
    expect(first.cause).not.toBeInstanceOf(UnconfirmedTaskError);
    expect(state.tasks).toEqual([]);

    state.requests.length = 0;
    state.failCreates = { after: 1, status: 422, stored: false };
    await expect(createPlannedTasks(target.tracker, file)).rejects.toThrow(
      'the tracker refused to create part-lot-link: POST /api/tasks failed with 422: failed with 422 Before part-lot-link, this run created lot-reception-check, each read back as sent. Running the create step again'
    );
    state.failCreates = undefined;
    const again = await createPlannedTasks(target.tracker, file);
    expect([keys(again.recovered), keys(again.created)]).toEqual([['lot-reception-check'], ['part-lot-link']]);
    expect(state.tasks.map(task => task.title)).toEqual(['Build lot-reception-check', 'Build part-lot-link']);
  });

  /** What an unconfirmed create must and must not say: it never claims the tracker holds nothing, nor asks for a blind rerun. */
  function expectUnconfirmed(error: Error, key: string): void {
    expect(error.cause).toBeInstanceOf(UnconfirmedTaskError);
    expect(error.message).toStartWith(`creating ${key} was not confirmed: `);
    expect(error.message).toContain(`Before running again, look in project ${PROJECT_ID} for a task whose description's first line carries its marker`);
    expect(error.message).toContain(`Its marker is ${intakeMarker(key)}.`);
    for (const claim of ['refused', 'nothing was written', 'no task was', 'holds no', 'created no task', 'Running the create step again recovers']) {
      expect(error.message).not.toContain(claim);
    }
  }

  test.each([
    ['answered 400 after storing it', { status: 400, stored: true }],
    ['answered 500 after storing it', { status: 500, stored: true }],
    ['answered 500', { status: 500, stored: false }],
    ['answered 502 from a gateway', { status: 502, stored: false }],
    ['answered 504 from a gateway', { status: 504, stored: false }],
  ])('a create the tracker %s is unconfirmed, names its marker, and a rerun recovers the task by that marker if it was stored', async (_case, failing) => {
    const state = tracker();
    const { target, file } = await approved(state);
    state.failCreates = { after: 1, ...failing };
    const error = await refusal(createPlannedTasks(target.tracker, file));
    expectUnconfirmed(error, 'part-lot-link');
    expect(error.message).toContain(`POST /api/tasks failed with ${String(failing.status)}`);
    expect(error.message).toContain('The tracker may have stored the task.');
    expect(error.message).toEndWith('Before part-lot-link, this run created lot-reception-check, each read back as sent.');
    expect(state.tasks).toHaveLength(failing.stored ? 2 : 1);

    state.failCreates = undefined;
    state.requests.length = 0;
    const again = await createPlannedTasks(target.tracker, file);
    expect(keys(again.recovered)).toEqual(failing.stored ? ['lot-reception-check', 'part-lot-link'] : ['lot-reception-check']);
    expect(keys(again.created)).toEqual(failing.stored ? [] : ['part-lot-link']);
    expect(state.tasks).toHaveLength(2);
  });

  test('a create that gets no answer is unconfirmed and names its marker', async () => {
    const state = tracker();
    const root = checkout();
    const answering = fetchOf(state);
    const { file } = await approved(state);
    const dropping = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') throw new TypeError('socket hang up');
      return answering(input, init);
    }) as typeof fetch;
    const error = await refusal(createPlannedTasks(intakeTarget(root, BASE, dropping).tracker, file));
    expectUnconfirmed(error, 'lot-reception-check');
    expect(error.message).toContain(`POST /api/tasks: the tracker at ${BASE} is unreachable. The tracker may have stored the task.`);
  });

  test('a task stored but not read back is reported as unconfirmed, not as never created, and a rerun recovers it by its marker', async () => {
    const state = tracker();
    const { target, file } = await approved(state);
    state.failReadBack = true;
    const error = await refusal(createPlannedTasks(target.tracker, file));
    expectUnconfirmed(error, 'lot-reception-check');
    expect((error.cause as UnconfirmedTaskError).taskId).toBe('task-1');
    expect(error.message).toStartWith(
      'creating lot-reception-check was not confirmed: the tracker created task task-1 but did not read it back: GET /api/tasks/task-1 failed with 500: Internal Server Error The tracker stored task task-1.'
    );
    expect(error.message).toEndWith('lot-reception-check was the first task this run tried to create.');

    state.failReadBack = false;
    const again = await createPlannedTasks(target.tracker, file);
    expect([keys(again.recovered), keys(again.created)]).toEqual([['lot-reception-check'], ['part-lot-link']]);
    expect(state.tasks).toHaveLength(2);
  });

  test.each([
    ['alters its description below the marker', (task: Task) => ({ ...task, description: (task.description ?? '').replace('**Priority:** high', '**Priority:** none') }), true],
    ['strips its HTML comments', (task: Task) => ({ ...task, description: (task.description ?? '').replace(/<!--[\s\S]*?-->\n?/g, '') }), false],
  ])('a task the tracker %s is reported as unconfirmed with its id, and recovered only when its marker survived', async (_case, stores, recoverable) => {
    const state = tracker();
    const { target, file } = await approved(state);
    state.stores = stores;
    const error = await refusal(createPlannedTasks(target.tracker, file));
    expectUnconfirmed(error, 'lot-reception-check');
    expect((error.cause as UnconfirmedTaskError).taskId).toBe('task-1');
    expect(error.message).toStartWith(
      'creating lot-reception-check was not confirmed: the tracker created task task-1 but reads back a different description than was sent, so it is not reported as filed. The tracker stored task task-1.'
    );

    state.stores = undefined;
    const again = await createPlannedTasks(target.tracker, file);
    expect(keys(again.recovered)).toEqual(recoverable ? ['lot-reception-check'] : []);
    expect(state.tasks).toHaveLength(recoverable ? 2 : 3);
  });

  test('refuses before any request a description a document title would fill with task metadata', async () => {
    const state = tracker([spec('doc-1', SPEC_TEXT, 'Spec <!-- archon-discovery quoted -->')]);
    const { target, file } = await approved(state);
    await expect(createPlannedTasks(target.tracker, file)).rejects.toThrow(
      "nothing was written: task lot-reception-check's description would hold archon-discovery metadata"
    );
    expect(state.requests).toEqual([]);
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
  test.each([
    ['sources', SOURCES_OUTPUT],
    ['proposal', PROPOSAL_OUTPUT],
    ['create', CREATE_OUTPUT],
  ])("the %s node's output_format is the schema its script emits", (id, schema) => {
    expect(outputFormat(id)).toEqual(JSON.parse(JSON.stringify(schema)));
  });

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
      expect(JSON.parse(proposal.stdout)).toMatchObject({ lots: 2, tasks: 2 });
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

      // A later intake hands the plan agent those tasks, archived ones included, through tasks.json.
      (state.tasks[0] as Task).archived = true;
      expect(await runScript('sources', root, artifacts, base)).toMatchObject({ code: 0, stderr: '' });
      expect(parseIntakeTaskSummaries(JSON.parse(readFileSync(join(artifacts, 'intake/tasks.json'), 'utf8')))).toEqual([
        { key: 'lot-reception-check', title: 'Build lot-reception-check', status: 'todo', archived: true, url: `${base}/api/tasks/task-1` },
        { key: 'part-lot-link', title: 'Build part-lot-link', status: 'todo', archived: false, url: `${base}/api/tasks/task-2` },
      ]);

      expect(git(root, 'status', '--porcelain', '--ignored') + git(root, 'rev-parse', 'HEAD')).toBe(before);
    } finally {
      server.stop(true);
    }
  }, 60_000);

  const servers: { stop: (force: boolean) => unknown }[] = [];
  afterEach(() => {
    for (const server of servers.splice(0)) server.stop(true);
  });

  function serve(state: Tracker): string {
    const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: request => handle(state, request) });
    servers.push(server);
    return `http://127.0.0.1:${String(server.port)}`;
  }

  /** A checkout whose intake ran sources and proposal against `state`, ready for create. */
  async function proposed(state: Tracker) {
    const base = serve(state);
    const root = checkout();
    const artifacts = track(mkdtempSync(join(tmpdir(), 'project-intake-artifacts-')));
    expect(await runScript('sources', root, artifacts, base)).toMatchObject({ code: 0, stderr: '' });
    expect(await runScript('proposal', root, artifacts, base, { INPUTS_PLAN: JSON.stringify(plan()) })).toMatchObject({ code: 0, stderr: '' });
    return { base, root, artifacts };
  }

  const posts = (state: Tracker) => state.requests.filter(request => request.method === 'POST');

  test('create refuses before any task is posted when a specification changed after the plan', async () => {
    const state = tracker();
    const { base, root, artifacts } = await proposed(state);
    Object.assign(state.docs[0] as Doc, { content: { markdown: `${SPEC_TEXT}\nUne exigence ajoutée après l'approbation.` } });

    const create = await runScript('create', root, artifacts, base);
    expect(create.code).toBe(1);
    expect(create.stdout).toBe('');
    expect(create.stderr).toContain("nothing was written: the project's specifications changed since they were analysed (edited doc-1)");
    expect(posts(state)).toEqual([]);
    expect(state.tasks).toEqual([]);
  }, 60_000);

  test('create refuses before any task is posted when the tracker it would write to is not the one planned against', async () => {
    const state = tracker();
    const { base, root, artifacts } = await proposed(state);
    // Another tracker serving the same project and specifications: only the target guard tells them apart.
    const elsewhere = tracker(structuredClone(state.docs));
    const other = serve(elsewhere);

    const create = await runScript('create', root, artifacts, other);
    expect(create.code).toBe(1);
    expect(create.stderr).toContain(`nothing was written: ARCHON_TRACKER_BASE_URL now names ${other}/, not ${base}/`);
    expect([posts(state), posts(elsewhere)]).toEqual([[], []]);
    expect([state.tasks, elsewhere.tasks]).toEqual([[], []]);
  }, 60_000);

  test('create refuses before any task is posted when the project file now names another project', async () => {
    const state = tracker();
    const { base, root, artifacts } = await proposed(state);
    writeFileSync(join(root, '.factory/project.yaml'), projectYaml('archon', OTHER_PROJECT));
    state.project.id = OTHER_PROJECT;

    const create = await runScript('create', root, artifacts, base);
    expect(create.code).toBe(1);
    expect(create.stderr).toContain(`nothing was written: .factory/project.yaml now names project ${OTHER_PROJECT}, not ${PROJECT_ID}`);
    expect(posts(state)).toEqual([]);
  }, 60_000);

  test('proposal refuses a tasks.json or sources.json the sources node did not write', async () => {
    const state = tracker();
    const { base, root, artifacts } = await proposed(state);
    const valid = readFileSync(join(artifacts, 'intake/tasks.json'), 'utf8');
    const summaries = JSON.parse(valid) as Record<string, unknown>[];
    writeFileSync(join(artifacts, 'intake/tasks.json'), JSON.stringify([...summaries, { key: 'not a key', title: 't', status: 'todo', archived: false, url: base }]));
    const tasks = await runScript('proposal', root, artifacts, base, { INPUTS_PLAN: JSON.stringify(plan()) });
    expect(tasks.code).toBe(1);
    expect(tasks.stderr).toContain('project intake proposal: intake/tasks.json is not what this workflow wrote: tasks[0].key does not match');

    writeFileSync(join(artifacts, 'intake/tasks.json'), valid);
    writeFileSync(join(artifacts, 'intake/sources.json'), JSON.stringify({ documents: [{ id: 'doc-1' }] }));
    const sources = await runScript('proposal', root, artifacts, base, { INPUTS_PLAN: JSON.stringify(plan()) });
    expect(sources.code).toBe(1);
    expect(sources.stderr).toContain('project intake proposal: intake/sources.json is not what this workflow wrote');
  }, 60_000);

  test('the approval counts the planned tasks the project already holds, archived ones included, and nothing else', async () => {
    const state = tracker(
      [spec('doc-1')],
      [
        intakeTask('t1', 'lot-reception-check'),
        intakeTask('t2', 'part-lot-link', true),
        intakeTask('t3', 'retired-task'),
        { ...intakeTask('t4', 'unused-key'), description: 'A task a person wrote about part-lot-link.' },
        { ...intakeTask('t5', 'unused-key'), description: '<!-- archon-discovery cert-upload -->\nThe brief.' },
      ]
    );
    const base = serve(state);
    const root = checkout();
    const artifacts = track(mkdtempSync(join(tmpdir(), 'project-intake-artifacts-')));
    expect(await runScript('sources', root, artifacts, base)).toMatchObject({ code: 0, stderr: '' });
    const planned = plan({ tasks: [plannedTask('lot-reception-check'), plannedTask('part-lot-link', ['lot-reception-check'], 'traceability'), plannedTask('cert-upload')] });
    const proposal = await runScript('proposal', root, artifacts, base, { INPUTS_PLAN: JSON.stringify(planned) });
    expect(proposal).toMatchObject({ code: 0, stderr: '' });
    expect((JSON.parse(proposal.stdout) as { question: string }).question).toStartWith(
      `Project intake proposes 3 tasks in 2 lots for Archon project ${PROJECT_ID}: 1 to create as todo, 2 already there from an earlier intake.`
    );

    const create = await runScript('create', root, artifacts, base);
    expect(JSON.parse(create.stdout)).toMatchObject({ created: [{ key: 'cert-upload' }], recovered: [{ key: 'lot-reception-check' }, { key: 'part-lot-link' }] });
  }, 60_000);

  test('a damaged intake marker in the project stops the run before the operator is asked, rather than changing the count', async () => {
    const state = tracker([spec('doc-1')], [intakeTask('t1', 'lot-reception-check'), { ...intakeTask('t2', 'unused-key'), description: '<!--archon-project-intake part-lot-link-->' }]);
    const base = serve(state);
    const root = checkout();
    const artifacts = track(mkdtempSync(join(tmpdir(), 'project-intake-artifacts-')));
    const sources = await runScript('sources', root, artifacts, base);
    expect(sources.code).toBe(1);
    expect(sources.stdout).toBe('');
    expect(sources.stderr).toContain('task t2 carries archon-project-intake metadata that is not one canonical marker on its first line');
    expect(existsSync(join(artifacts, 'intake/tasks.json'))).toBe(false);
  }, 60_000);

  test.each([
    ['a malformed task key', (file: PlanJson) => Object.assign(file.plan.tasks[0] ?? {}, { key: 'Lot Reception' }), 'plan_file.plan.tasks[0].key does not match'],
    ['a task without its source_refs', (file: PlanJson) => delete file.plan.tasks[0]?.source_refs, 'plan_file.plan.tasks[0].source_refs is missing'],
    ['a dependency on an undeclared task', (file: PlanJson) => Object.assign(file.plan.tasks[1] ?? {}, { dependencies: ['nowhere'] }), 'task part-lot-link depends on nowhere, which the plan does not declare'],
    ['a multi-line title', (file: PlanJson) => Object.assign(file.plan.tasks[0] ?? {}, { title: 'Build it\nand more' }), 'plan_file.plan.tasks[0].title does not match'],
    ['a citation of a document not analysed', (file: PlanJson) => Object.assign(file.plan.tasks[0] ?? {}, { source_refs: [ref('doc-x')] }), 'cites doc-x, which is not an analysed source'],
  ])('create refuses a plan.json edited after the proposal to hold %s, before any task is posted', async (_case, tamper, why) => {
    const state = tracker();
    const { base, root, artifacts } = await proposed(state);
    const path = join(artifacts, 'intake/plan.json');
    const file = JSON.parse(readFileSync(path, 'utf8')) as PlanJson;
    tamper(file);
    writeFileSync(path, JSON.stringify(file));

    const create = await runScript('create', root, artifacts, base);
    expect(create.code).toBe(1);
    expect(create.stdout).toBe('');
    expect(create.stderr).toContain('project intake create: intake/plan.json is not what this workflow wrote: ');
    expect(create.stderr).toContain(why);
    expect(posts(state)).toEqual([]);
    expect(state.tasks).toEqual([]);
  }, 60_000);

  test('an insufficient plan stops before the operator is asked', async () => {
    const root = checkout();
    const artifacts = track(mkdtempSync(join(tmpdir(), 'project-intake-artifacts-')));
    mkdirSync(join(artifacts, 'intake'));
    writeFileSync(join(artifacts, 'intake/sources.json'), JSON.stringify(await sourcesOf(tracker())));
    writeFileSync(join(artifacts, 'intake/tasks.json'), '[]');
    const insufficient = plan({ status: 'insufficient', reason: 'The document holds only a title.', lots: [], tasks: [], assumptions: [], open_questions: [] });
    const run = await runScript('proposal', root, artifacts, BASE, { INPUTS_PLAN: JSON.stringify(insufficient) });
    expect(run.code).toBe(1);
    expect(run.stdout).toBe('');
    expect(run.stderr).toContain('nothing was planned: the specifications are not enough to plan from without guessing. The document holds only a title.');
  }, 60_000);
});
