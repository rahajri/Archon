/**
 * A fake Archon tracker as the project intake scripts meet it, answering the project,
 * document and task routes as the live service does, and the test data an intake plans
 * from. Shared by the pack's intake tests and the engine-side output conformance test.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { intakeMarker } from '../../../workflows/sdlc/.shared/project-intake';

export const PROJECT_ID = 'd9f7bb82-5fbc-43d1-aec5-b30006e98182';

export function projectYaml(primary: 'archon' | 'github' = 'archon', projectId = PROJECT_ID, repo = 'rahajri/BAREA'): string {
  return `project:
  name: BAREA
  archon_project_id: ${projectId}
  github_repo: ${repo}
tracker:
  primary: ${primary}
  create_github_issue_on_ready: true
`;
}

export function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout;
}

/** A committed checkout whose remote is BAREA's, with the project file when one is given. */
export function intakeCheckout(
  track: (root: string) => string,
  yaml: string | null = projectYaml(),
  remote = 'https://github.com/rahajri/BAREA.git'
): string {
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

export const SPEC_TEXT = `# Cahier des charges

## Réception matière
Chaque lot reçu est contrôlé à la réception : le contrôleur saisit le numéro de coulée,
le certificat matière et le résultat du contrôle dimensionnel avant toute mise en stock.

## Traçabilité
Chaque pièce produite est rattachée au lot matière dont elle provient, et l'historique est consultable.
`;

export interface Doc {
  id: string;
  title: string;
  document_type?: string;
  content?: unknown;
  [field: string]: unknown;
}

export function spec(id: string, markdown = SPEC_TEXT, title = `Spec ${id}`): Doc {
  return { id, title, document_type: 'spec', content: { markdown }, status: 'draft', version: '1.0', tags: [], author: 'User' };
}

export interface Task {
  id: string;
  project_id: string;
  title: string;
  description: string | null;
  status: string;
  archived: boolean;
}

export interface Tracker {
  project: { id: string; title: string };
  docs: Doc[];
  tasks: Task[];
  requests: { method: string; path: string; body: unknown }[];
  /** Answer every task creation after `after` succeeded with `status`, having stored the task first when `stored`. */
  failCreates?: { after: number; status: number; stored: boolean };
  /** Store a created task and answer its creation, but fail reading it back. */
  failReadBack?: boolean;
  /** How the tracker stores a created task; it answers the creation with the task as sent. */
  stores?: (task: Task) => Task;
  /** Answer project reads as if they were another project's. */
  answerAs?: string;
}

export function tracker(docs: Doc[] = [spec('doc-1')], tasks: Task[] = []): Tracker {
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
      if (state.failReadBack) return new Response('Internal Server Error', { status: 500 });
      const task = state.tasks.find(entry => url.pathname === `/api/tasks/${entry.id}`);
      return task === undefined ? notFound('Task not found') : Response.json(task);
    },
  ],
  POST: [
    (state, url, body) => {
      if (url.pathname !== '/api/tasks') return undefined;
      const earlier = state.requests.filter(entry => entry.method === 'POST').length - 1;
      const failing = state.failCreates !== undefined && earlier >= state.failCreates.after ? state.failCreates : undefined;
      if (failing !== undefined && !failing.stored) return new Response(`failed with ${String(failing.status)}`, { status: failing.status });
      const task = { id: `task-${String(state.tasks.length + 1)}`, archived: false, description: null, ...body } as Task;
      state.tasks.push(state.stores?.({ ...task }) ?? task);
      if (failing !== undefined) return new Response(`failed with ${String(failing.status)} after storing`, { status: failing.status });
      return Response.json({ message: 'Task created successfully', task });
    },
  ],
};

/** A task an earlier intake created for the planned task `key`. */
export function intakeTask(id: string, key: string, archived = false): Task {
  return {
    id,
    project_id: PROJECT_ID,
    title: `Build ${key}`,
    description: `${intakeMarker(key)}\nThe brief.`,
    status: archived ? 'done' : 'todo',
    archived,
  };
}

export async function handle(state: Tracker, request: Request): Promise<Response> {
  const url = new URL(request.url);
  const body = request.method === 'POST' ? ((await request.json()) as Record<string, unknown>) : undefined;
  state.requests.push({ method: request.method, path: `${url.pathname}${url.search}`, body });
  for (const route of ROUTES[request.method] ?? []) {
    const response = route(state, url, body);
    if (response !== undefined) return response;
  }
  return new Response('not found', { status: 404 });
}

export function fetchOf(state: Tracker): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => handle(state, new Request(String(input), init))) as typeof fetch;
}

/** `intake/plan.json` as a test edits it. */
export type PlanJson = { plan: { tasks: Record<string, unknown>[] } };

export const ref = (document_id = 'doc-1') => ({ document_id, location: 'Réception matière' });

export function plannedTask(key: string, dependencies: string[] = [], lot = 'reception'): Record<string, unknown> {
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

export function plan(overrides: Record<string, unknown> = {}): Record<string, unknown> {
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
