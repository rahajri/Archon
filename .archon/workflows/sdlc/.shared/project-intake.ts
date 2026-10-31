/**
 * Project intake: turn the specifications an operator uploaded to an Archon project's
 * Docs into todo tasks in that same project.
 *
 * The checkout's `.factory/project.yaml` names the project, which must keep its work in
 * the Archon tracker: intake reads and writes only that project, and has no GitHub path
 * to fall back to. The sources are the project's documents typed `spec`, read in full and
 * fingerprinted, so a plan is tied to the exact versions it was made from. The plan is an
 * agent's; this module validates it, and after the operator approves it, creates each
 * planned task once. A task carries its plan key in a marker on its description's first
 * line, so a later run recovers it instead of creating it again, archived ones included.
 */

import { createHash } from 'node:crypto';
import { type ArchonDocument, ArchonProjectDocs } from './archon-docs.ts';
import { type ArchonTask, ArchonTracker, trackerBaseUrl, UnconfirmedTaskError } from './archon-tracker.ts';
import { type QualifiedPr, sameRepo } from './forge.ts';
import { PROJECT_FILE, readProjectContext } from './project-context.ts';
import { findRemote } from './remote.ts';
import { conforms, type Infer, object } from './schema.ts';
import { opensTaskMetadata, taskMetadataIn } from './task-metadata.ts';
import { isObject } from './typed.ts';

type Repo = QualifiedPr['repo'];

export class ProjectIntakeError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ProjectIntakeError';
  }
}

/** The Archon document type an operator gives a specification in the Docs tab. */
export const SPEC_TYPE = 'spec';

/**
 * The fewest words a specification holds beyond its headings. A document the Docs tab
 * just created holds its title and one line of placeholder text; planning from that
 * would invent the whole backlog.
 */
export const MIN_SPEC_WORDS = 25;

// --- where intake reads and writes ------------------------------------------------------

/** The checkout's Archon project, on the tracker at the configured base URL. */
export interface IntakeTarget {
  readonly repo: Repo;
  readonly tracker: ArchonTracker;
  readonly docs: ArchonProjectDocs;
}

/**
 * The project a checkout declares, refused unless it keeps its work in the Archon
 * tracker, a remote of the checkout is the repository the project file names, and the
 * base URL is one `trackerBaseUrl` accepts. Nothing is requested before all three hold.
 */
export function intakeTarget(checkout: string, baseUrlValue: string | undefined, fetchImpl: typeof fetch = fetch): IntakeTarget {
  const context = readProjectContext(checkout);
  if (context?.trackerPrimary !== 'archon') {
    const state = context === null ? `has no ${PROJECT_FILE}` : `keeps its work on GitHub (tracker.primary is ${context.trackerPrimary})`;
    throw new ProjectIntakeError(
      `project intake reads the specification from an Archon project's Docs and files tasks there, so it needs ${PROJECT_FILE} with tracker.primary archon and an archon_project_id; this checkout ${state}.`
    );
  }
  const repo = context.githubRepo;
  if (findRemote(repo, checkout) === undefined) {
    throw new ProjectIntakeError(
      `${PROJECT_FILE} names ${repo.host}/${repo.path}, but no git remote of this checkout points at it, so its Archon project is not this repository's.`
    );
  }
  const baseUrl = trackerBaseUrl(baseUrlValue);
  return {
    repo,
    tracker: new ArchonTracker(context, baseUrl, fetchImpl),
    docs: new ArchonProjectDocs(context, baseUrl, fetchImpl),
  };
}

// --- the run's files --------------------------------------------------------------------
//
// Each node hands the next its result as a file in the run's artifacts. Every file has one
// schema here: its type is inferred from it, and its reader refuses anything else.

const STRING = { type: 'string' } as const;
const INTEGER = { type: 'integer' } as const;
const REPO = object({ host: STRING, path: STRING });

function refuseRunFile(name: string, problems: readonly string[]): never {
  throw new ProjectIntakeError(`intake/${name} is not what this workflow wrote: ${problems.join('; ')}`);
}

// --- what each script node outputs --------------------------------------------------------
//
// Each is the node's `output_format`, held equal to it by a test, and the type its script
// emits, so the workflow and the script cannot disagree on a field.

export const SOURCES_OUTPUT = object({ project_id: STRING, documents: INTEGER, fingerprint: STRING });
export const PROPOSAL_OUTPUT = object({ question: STRING, lots: INTEGER, tasks: INTEGER });
const WRITTEN = { type: 'array', items: object({ key: STRING, url: STRING }) } as const;
export const CREATE_OUTPUT = object({ summary: STRING, created: WRITTEN, recovered: WRITTEN });

export type WrittenTask = Infer<typeof WRITTEN>[number];

// --- the sources ------------------------------------------------------------------------

/** `intake/sources.json`: what one intake run analyses, and where it came from. */
const SOURCES_SCHEMA = object({
  project: object({ id: STRING, title: STRING }),
  repo: REPO,
  tracker_base_url: STRING,
  /** SHA-256 over the project id and every source's fingerprint. */
  fingerprint: STRING,
  /** Each specification as intake analyses it: the document, its markdown, and their fingerprint. */
  documents: {
    type: 'array',
    items: object({
      id: STRING,
      title: STRING,
      document_type: STRING,
      metadata: { type: 'object' },
      /** SHA-256 of the id, title, type and content, so any change to what was analysed changes it. */
      sha256: STRING,
      content: STRING,
    }),
  },
  /** The project's other documents, which are not specifications and are not analysed. */
  set_aside: { type: 'array', items: object({ id: STRING, title: STRING, document_type: { type: ['string', 'null'] } }) },
});

export type IntakeSources = Infer<typeof SOURCES_SCHEMA>;
type IntakeSource = IntakeSources['documents'][number];

export function parseIntakeSources(value: unknown): IntakeSources {
  const problems: string[] = [];
  if (!conforms(SOURCES_SCHEMA, value, 'sources', problems)) refuseRunFile('sources.json', problems);
  return value;
}

function sha256(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function describe(document: { id: string; title: string }): string {
  return `"${document.title}" (${document.id})`;
}

/** The document's markdown; empty when it has no content. */
function markdownOf(document: ArchonDocument): string {
  const { content } = document;
  if (content === null) return '';
  if (isObject(content) && typeof content.markdown === 'string') return content.markdown;
  const fields = isObject(content) ? `fields ${Object.keys(content).join(', ') || '(none)'}` : `a ${typeof content}`;
  throw new ProjectIntakeError(
    `${describe(document)} stores its content as ${fields}, not the markdown the Docs tab writes; intake does not read it.`
  );
}

/** The words of a specification outside its headings and its title line. */
export function specificationWords(title: string, markdown: string): number {
  return markdown
    .split(/\r?\n/)
    .filter(line => !/^\s{0,3}#{1,6}(\s|$)/.test(line) && line.trim() !== title.trim())
    .join(' ')
    .split(/\s+/)
    .filter(word => /[\p{L}\p{N}]/u.test(word)).length;
}

function sourceOf(document: ArchonDocument & { document_type: string }): IntakeSource {
  const content = markdownOf(document);
  const words = specificationWords(document.title, content);
  if (words < MIN_SPEC_WORDS) {
    throw new ProjectIntakeError(
      `${describe(document)} is typed ${SPEC_TYPE} but holds ${String(words)} words beyond its headings, too few to plan from without guessing. Write or upload the specification into it, or change its type if it is not one.`
    );
  }
  const { id, title, document_type, metadata } = document;
  return { id, title, document_type, metadata, sha256: sha256([id, title, document_type, content]), content };
}

/**
 * The project's specifications: every document typed `spec`, each with enough content to
 * plan from. No document, no specification, or one without content stops the intake
 * with what the operator should do; nothing is guessed from other files.
 */
export async function readIntakeSources(target: IntakeTarget): Promise<IntakeSources> {
  const project = await target.docs.readProject();
  const all = await target.docs.readDocuments();
  const where = `Archon project "${project.title}" (${project.id})`;
  if (all.length === 0) {
    throw new ProjectIntakeError(
      `${where} has no documents. Upload the specification in the project's Docs tab with the type ${SPEC_TYPE}, then run the intake again.`
    );
  }
  const specs = all.filter((document): document is ArchonDocument & { document_type: string } => document.document_type === SPEC_TYPE);
  if (specs.length === 0) {
    const listed = all.map(document => `${describe(document)} typed ${document.document_type ?? '(none)'}`).join('; ');
    throw new ProjectIntakeError(
      `${where} has no document typed ${SPEC_TYPE} (${listed}). Give the specification the type ${SPEC_TYPE} in the Docs tab, then run the intake again.`
    );
  }
  const documents = specs.map(sourceOf).sort((left, right) => left.id.localeCompare(right.id));
  return {
    project,
    repo: target.repo,
    tracker_base_url: target.tracker.baseUrl.href,
    fingerprint: sha256({ project: project.id, documents: documents.map(document => [document.id, document.sha256]) }),
    documents,
    set_aside: all
      .filter(document => document.document_type !== SPEC_TYPE)
      .map(({ id, title, document_type }) => ({ id, title, document_type })),
  };
}

// --- the marker -------------------------------------------------------------------------

/** A lot's or planned task's key: the one pattern the plan schema, the task list and the marker share. */
const KEY_PATTERN = '^[a-z0-9][a-z0-9-]{2,80}$';
const KEY = { type: 'string', pattern: KEY_PATTERN } as const;
const MARKER_OPEN = '<!-- archon-project-intake ';
const MARKER_CLOSE = ' -->';
/**
 * Whether text opens an intake comment in any spacing or case. A description holding one
 * anywhere but its canonical first line is corrupt metadata, never an unrelated task:
 * read as no intake task, its planned task would be created a second time.
 */
const isIntakeMetadata = (text: string): boolean => opensTaskMetadata('archon-project-intake', text);

export function isIntakeKey(value: unknown): value is string {
  return typeof value === 'string' && new RegExp(KEY_PATTERN, 'u').test(value);
}

/** The first line of a task intake created for the planned task `key`. */
export function intakeMarker(key: string): string {
  if (!isIntakeKey(key)) throw new ProjectIntakeError(`"${key}" is not a planned task key`);
  return `${MARKER_OPEN}${key}${MARKER_CLOSE}`;
}

/** The planned task key a task's description records, or null when it holds no intake metadata. */
function intakeKeyOf(task: ArchonTask): string | null {
  const description = task.description ?? '';
  if (!isIntakeMetadata(description)) return null;
  const [first = '', ...rest] = description.split(/\r?\n/);
  const key = first.startsWith(MARKER_OPEN) && first.endsWith(MARKER_CLOSE) ? first.slice(MARKER_OPEN.length, -MARKER_CLOSE.length) : '';
  if (!isIntakeKey(key) || rest.some(isIntakeMetadata)) {
    throw new ProjectIntakeError(
      `task ${task.id} carries archon-project-intake metadata that is not one canonical marker on its first line; fix or remove it before running the intake again.`
    );
  }
  return key;
}

/**
 * The tasks intake created in the project, by planned task key, archived ones included.
 * Corrupt metadata, or two tasks with one key, refuses the read: either would leave a
 * planned task matched to the wrong task or created twice.
 */
export function intakeTasks(tasks: readonly ArchonTask[]): Map<string, ArchonTask> {
  const byKey = new Map<string, ArchonTask[]>();
  for (const task of tasks) {
    const key = intakeKeyOf(task);
    if (key !== null) byKey.set(key, [...(byKey.get(key) ?? []), task]);
  }
  const conflicts = [...byKey].filter(([, matched]) => matched.length > 1);
  if (conflicts.length > 0) {
    const named = conflicts.map(([key, matched]) => `${key} (tasks ${matched.map(task => task.id).join(', ')})`).join('; ');
    throw new ProjectIntakeError(`more than one task carries the intake marker of ${named}; keep one of each before running the intake again.`);
  }
  return new Map([...byKey].map(([key, [task]]) => [key, task as ArchonTask]));
}

/** `intake/tasks.json`: the tasks an earlier intake created, which the plan agent reuses the keys of. */
const TASK_SUMMARIES_SCHEMA = {
  type: 'array',
  items: object({ key: KEY, title: STRING, status: STRING, archived: { type: 'boolean' }, url: STRING }),
} as const;

export type IntakeTaskSummary = Infer<typeof TASK_SUMMARIES_SCHEMA>[number];

export function intakeTaskSummaries(tracker: ArchonTracker, tasks: ReadonlyMap<string, ArchonTask>): IntakeTaskSummary[] {
  return [...tasks].map(([key, task]) => ({ key, title: task.title, status: task.status, archived: task.archived, url: tracker.taskUrl(task.id) }));
}

export function parseIntakeTaskSummaries(value: unknown): readonly IntakeTaskSummary[] {
  const problems: string[] = [];
  if (!conforms(TASK_SUMMARIES_SCHEMA, value, 'tasks', problems)) refuseRunFile('tasks.json', problems);
  const repeated = duplicates(value.map(task => task.key));
  if (repeated.length > 0) refuseRunFile('tasks.json', [`it lists ${repeated.join(', ')} more than once`]);
  return value;
}

// --- the plan ---------------------------------------------------------------------------

const PLAN_STATUSES = ['ready', 'insufficient'] as const;
const PRIORITIES = ['critical', 'high', 'medium', 'low'] as const;

/** Text with something in it. */
const TEXT = { type: 'string', pattern: '\\S' } as const;
/** One line with something in it. */
const LINE = { type: 'string', pattern: '^[^\\r\\n]*\\S[^\\r\\n]*$' } as const;
/** Where a source says something: a document's id, and a section heading, a numbered requirement or a short quote in it. */
const SOURCE_REFS = { type: 'array', items: object({ document_id: TEXT, location: TEXT }) } as const;
const CITED = { ...SOURCE_REFS, minItems: 1 } as const;

/**
 * The plan agent's output. The plan node's `output_format` is this schema, held equal to
 * it by a test, and `parsePlan` checks the agent's output against it before the rules no
 * schema expresses.
 */
export const PLAN_SCHEMA = object({
  status: { type: 'string', enum: PLAN_STATUSES },
  reason: STRING,
  objective: STRING,
  scope: object({ included: { type: 'array', items: TEXT }, excluded: { type: 'array', items: TEXT } }),
  assumptions: { type: 'array', items: object({ text: TEXT, source_refs: CITED }) },
  constraints: { type: 'array', items: object({ text: TEXT, source_refs: CITED }) },
  lots: { type: 'array', items: object({ key: KEY, title: LINE, summary: TEXT }) },
  tasks: {
    type: 'array',
    items: object({
      key: KEY,
      lot: KEY,
      title: LINE,
      description: TEXT,
      priority: { type: 'string', enum: PRIORITIES },
      dependencies: { type: 'array', items: KEY },
      acceptance_criteria: { type: 'array', items: TEXT, minItems: 1 },
      source_refs: CITED,
    }),
  },
  open_questions: { type: 'array', items: object({ text: TEXT, blocking: { type: 'boolean' }, source_refs: SOURCE_REFS }) },
  risks: { type: 'array', items: object({ text: TEXT, source_refs: SOURCE_REFS }) },
});

export type IntakePlan = Infer<typeof PLAN_SCHEMA>;
export type PlannedLot = IntakePlan['lots'][number];
export type PlannedTask = IntakePlan['tasks'][number];
type SourceRef = PlannedTask['source_refs'][number];

function duplicates(keys: readonly string[]): string[] {
  return [...new Set(keys.filter((key, index) => key !== '' && keys.indexOf(key) !== index))];
}

/** The tasks in an order that creates every dependency before its dependants, in plan order otherwise. */
export function creationOrder(tasks: readonly PlannedTask[]): PlannedTask[] {
  const ordered: PlannedTask[] = [];
  const placed = new Set<string>();
  let pending = [...tasks];
  while (pending.length > 0) {
    const ready = pending.filter(task => task.dependencies.every(dependency => placed.has(dependency)));
    if (ready.length === 0) throw new ProjectIntakeError(`the dependencies of ${pending.map(task => task.key).join(', ')} form a cycle`);
    for (const task of ready) {
      ordered.push(task);
      placed.add(task.key);
    }
    pending = pending.filter(task => !placed.has(task.key));
  }
  return ordered;
}

function graphProblems(lots: readonly PlannedLot[], tasks: readonly PlannedTask[]): string[] {
  const problems = [
    ...duplicates(lots.map(lot => lot.key)).map(key => `lot key ${key} is used more than once`),
    ...duplicates(tasks.map(task => task.key)).map(key => `task key ${key} is used more than once`),
  ];
  const lotKeys = new Set(lots.map(lot => lot.key));
  const taskKeys = new Set(tasks.map(task => task.key));
  for (const task of tasks) {
    if (!lotKeys.has(task.lot)) problems.push(`task ${task.key} is in lot ${task.lot}, which the plan does not declare`);
    for (const dependency of task.dependencies) {
      if (dependency === task.key) problems.push(`task ${task.key} depends on itself`);
      else if (!taskKeys.has(dependency)) problems.push(`task ${task.key} depends on ${dependency}, which the plan does not declare`);
    }
  }
  if (problems.length > 0) return problems;
  try {
    creationOrder(tasks);
    return [];
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
}

/** Every string in a value, by its path. */
function stringsIn(value: unknown, at: string): [string, string][] {
  if (typeof value === 'string') return [[at, value]];
  if (Array.isArray(value)) return value.flatMap((entry, index) => stringsIn(entry, `${at}[${String(index)}]`));
  if (isObject(value)) return Object.entries(value).flatMap(([field, entry]) => stringsIn(entry, `${at}.${field}`));
  return [];
}

/**
 * What the plan schema cannot say: which fields a status requires, that every citation
 * is an analysed source, that no text holds task metadata, and that the lots and
 * dependencies hold together.
 */
function planProblems(plan: IntakePlan, at: string, documentIds: ReadonlySet<string>): string[] {
  const ready = plan.status === 'ready';
  const problems = [
    ...(!ready && plan.reason.trim() === '' ? [`${at}.reason is empty, but an insufficient plan says why`] : []),
    ...(ready && plan.objective.trim() === '' ? [`${at}.objective is empty in a ready plan`] : []),
    ...(ready && plan.lots.length === 0 ? [`${at}.lots is empty in a ready plan`] : []),
    ...(ready && plan.tasks.length === 0 ? [`${at}.tasks is empty in a ready plan`] : []),
  ];
  const cited: [string, readonly { readonly source_refs: readonly SourceRef[] }[]][] = [
    ['assumptions', plan.assumptions],
    ['constraints', plan.constraints],
    ['tasks', plan.tasks],
    ['open_questions', plan.open_questions],
    ['risks', plan.risks],
  ];
  for (const [field, entries] of cited) {
    entries.forEach((entry, index) =>
      entry.source_refs.forEach((ref, refIndex) => {
        if (!documentIds.has(ref.document_id)) {
          problems.push(`${at}.${field}[${String(index)}].source_refs[${String(refIndex)}] cites ${ref.document_id}, which is not an analysed source`);
        }
      })
    );
  }
  for (const [where, text] of stringsIn(plan, at)) {
    const metadata = taskMetadataIn(text);
    if (metadata.length > 0) problems.push(`${where} holds ${metadata.join(' and ')} metadata, which would leave its task unreadable to a later pass`);
  }
  return problems.length > 0 ? problems : graphProblems(plan.lots, plan.tasks);
}

/**
 * The plan in `value`, every source it cites one of the analysed documents. Anything
 * else refuses, naming every problem: a plan that does not hold together is not shown
 * to the operator for approval.
 */
export function parsePlan(value: unknown, sources: { readonly documents: readonly { readonly id: string }[] }): IntakePlan {
  const problems: string[] = [];
  if (conforms(PLAN_SCHEMA, value, 'plan', problems)) {
    problems.push(...planProblems(value, 'plan', new Set(sources.documents.map(document => document.id))));
    if (problems.length === 0) return value;
  }
  throw new ProjectIntakeError(`the plan does not hold together: ${problems.join('; ')}`);
}

// --- the approved plan and its writes -----------------------------------------------------

/** `intake/plan.json`: a ready plan, with the identity and sources it was made from. */
const PLAN_FILE_SCHEMA = object({
  project_id: STRING,
  repo: REPO,
  tracker_base_url: STRING,
  fingerprint: STRING,
  documents: { type: 'array', items: object({ id: STRING, title: STRING, sha256: STRING }) },
  plan: PLAN_SCHEMA,
});

export type IntakePlanFile = Infer<typeof PLAN_FILE_SCHEMA>;

export function planFile(sources: IntakeSources, plan: IntakePlan): IntakePlanFile {
  return {
    project_id: sources.project.id,
    repo: sources.repo,
    tracker_base_url: sources.tracker_base_url,
    fingerprint: sources.fingerprint,
    documents: sources.documents.map(({ id, title, sha256: digest }) => ({ id, title, sha256: digest })),
    plan,
  };
}

/** A plan file as it was written, its plan checked again against the sources it records. */
export function parsePlanFile(value: unknown): IntakePlanFile {
  const problems: string[] = [];
  if (!conforms(PLAN_FILE_SCHEMA, value, 'plan_file', problems)) refuseRunFile('plan.json', problems);
  const planned = planProblems(value.plan, 'plan_file.plan', new Set(value.documents.map(document => document.id)));
  if (planned.length > 0) refuseRunFile('plan.json', planned);
  return value;
}

const STALE = 'The approved plan was made for what this run analysed; run the intake again to plan from what is there now.';

/**
 * Refuses a write into anything but the project the plan was made for: a checkout or
 * environment that now names another project, tracker or repository. Checked before the
 * sources are read again, so a change of project is reported as one.
 */
export function assertSameTarget(file: IntakePlanFile, target: IntakeTarget): void {
  const projectId = target.tracker.context.archonProjectId;
  const baseUrl = target.tracker.baseUrl.href;
  const changed = [
    ...(projectId === file.project_id ? [] : [`${PROJECT_FILE} now names project ${projectId}, not ${file.project_id}`]),
    ...(baseUrl === file.tracker_base_url ? [] : [`ARCHON_TRACKER_BASE_URL now names ${baseUrl}, not ${file.tracker_base_url}`]),
    ...(sameRepo(target.repo, file.repo) ? [] : [`the repository is now ${target.repo.host}/${target.repo.path}, not ${file.repo.host}/${file.repo.path}`]),
  ];
  if (changed.length > 0) throw new ProjectIntakeError(`nothing was written: ${changed.join('; ')}. ${STALE}`);
}

/**
 * Refuses a write the plan no longer describes: specifications added, removed or edited
 * since they were analysed. The operator approved a backlog for those exact versions.
 */
export function assertSameSources(file: IntakePlanFile, current: IntakeSources): void {
  if (current.project.id !== file.project_id || current.fingerprint !== file.fingerprint) {
    throw new ProjectIntakeError(`nothing was written: ${sourceChange(file, current)}. ${STALE}`);
  }
}

function sourceChange(file: IntakePlanFile, current: IntakeSources): string {
  const before = new Map(file.documents.map(document => [document.id, document.sha256]));
  const now = new Map(current.documents.map(document => [document.id, document.sha256]));
  const edited = [...now].filter(([id, digest]) => before.has(id) && before.get(id) !== digest).map(([id]) => id);
  const added = [...now.keys()].filter(id => !before.has(id));
  const removed = [...before.keys()].filter(id => !now.has(id));
  const parts = [
    ...(edited.length > 0 ? [`edited ${edited.join(', ')}`] : []),
    ...(added.length > 0 ? [`added ${added.join(', ')}`] : []),
    ...(removed.length > 0 ? [`removed ${removed.join(', ')}`] : []),
  ];
  return `the project's specifications changed since they were analysed (${parts.join('; ') || 'the project changed'})`;
}

/**
 * A planned task's description: its marker, the agent's description, then the plan's
 * metadata about it. Below the marker it must hold no task metadata of any workflow,
 * which a document title could still carry in; the plan's own text was checked already.
 */
export function intakeTaskDescription(task: PlannedTask, file: IntakePlanFile): string {
  const lot = file.plan.lots.find(entry => entry.key === task.lot);
  const titles = new Map(file.plan.tasks.map(entry => [entry.key, entry.title]));
  const documents = new Map(file.documents.map(document => [document.id, document.title]));
  const dependencies = task.dependencies.map(key => `\`${key}\` ${titles.get(key) ?? ''}`.trim());
  const body = [
    task.description.trim(),
    '',
    `**Lot:** ${lot?.title ?? task.lot} (\`${task.lot}\`)`,
    `**Priority:** ${task.priority}`,
    `**Depends on:** ${dependencies.length === 0 ? 'nothing' : dependencies.join('; ')}`,
    '',
    '**Acceptance criteria**',
    ...task.acceptance_criteria.map(criterion => `- [ ] ${criterion.trim()}`),
    '',
    '**Sources**',
    ...task.source_refs.map(ref => `- ${documents.get(ref.document_id) ?? ref.document_id} (\`${ref.document_id}\`): ${ref.location.trim()}`),
    '',
    '---',
    `Planned by the archon-project-intake workflow from the project's specifications at fingerprint ${file.fingerprint.slice(0, 12)}.`,
  ].join('\n');
  const metadata = taskMetadataIn(body);
  if (metadata.length > 0) {
    throw new ProjectIntakeError(`nothing was written: task ${task.key}'s description would hold ${metadata.join(' and ')} metadata, which would leave it unreadable to a later pass.`);
  }
  return `${intakeMarker(task.key)}\n${body}`;
}

/**
 * Create each planned task the project does not already hold, dependencies first. A task
 * an earlier run created is recovered by its marker, archived or not, and left as it is.
 * Every description is rendered before the first request, so one that would be refused
 * refuses with nothing written.
 */
export async function createPlannedTasks(
  tracker: ArchonTracker,
  file: IntakePlanFile
): Promise<{ created: WrittenTask[]; recovered: WrittenTask[] }> {
  const planned = creationOrder(file.plan.tasks).map(task => ({ task, description: intakeTaskDescription(task, file) }));
  const existing = intakeTasks(await tracker.listProjectTasks());
  const created: WrittenTask[] = [];
  const recovered: WrittenTask[] = [];
  for (const { task, description } of planned) {
    const found = existing.get(task.key);
    if (found !== undefined) {
      recovered.push({ key: task.key, url: tracker.taskUrl(found.id) });
      continue;
    }
    try {
      const id = await tracker.createTask({ title: task.title, description, status: 'todo' });
      created.push({ key: task.key, url: tracker.taskUrl(id) });
    } catch (error) {
      throw creationFailure(task.key, created, error);
    }
  }
  return { created, recovered };
}

/**
 * Why creating `key` stopped the run, and what a rerun does. Only a create the tracker
 * refused before its handler ran is known not to have stored a task; any other failure
 * may have, so the task is named with its marker for the operator to find before running
 * again, since a rerun recovers it only if that marker survived.
 */
function creationFailure(key: string, created: readonly WrittenTask[], error: unknown): ProjectIntakeError {
  const earlier =
    created.length === 0
      ? `${key} was the first task this run tried to create.`
      : `Before ${key}, this run created ${created.map(entry => entry.key).join(', ')}, each read back as sent.`;
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof UnconfirmedTaskError) {
    return new ProjectIntakeError(`creating ${key} was not confirmed: ${message} Its marker is ${intakeMarker(key)}. ${earlier}`, { cause: error });
  }
  return new ProjectIntakeError(
    `the tracker refused to create ${key}: ${message} ${earlier} Running the create step again recovers what this run created and creates the rest.`,
    { cause: error }
  );
}

/** The question the approval gate asks: what was read, what would be written, and what is unsettled. */
export function approvalQuestion(file: IntakePlanFile, existing: ReadonlySet<string>, planPath: string): string {
  const { plan } = file;
  const recovered = plan.tasks.filter(task => existing.has(task.key)).length;
  const blocking = plan.open_questions.filter(question => question.blocking);
  const bullets = (lines: readonly string[]): string[] => (lines.length === 0 ? ['- none'] : lines.map(line => `- ${line}`));
  return [
    `Project intake proposes ${String(plan.tasks.length)} tasks in ${String(plan.lots.length)} lots for Archon project ${file.project_id}: ${String(plan.tasks.length - recovered)} to create as todo, ${String(recovered)} already there from an earlier intake.`,
    '',
    `Objective: ${plan.objective.trim()}`,
    '',
    'Documents analysed:',
    ...bullets(file.documents.map(document => `${document.title} (${document.id})`)),
    '',
    'Lots:',
    ...bullets(plan.lots.map(lot => `${lot.title}: ${String(plan.tasks.filter(task => task.lot === lot.key).length)} tasks`)),
    '',
    'Assumptions the sources state:',
    ...bullets(plan.assumptions.map(assumption => assumption.text.trim())),
    '',
    'Blocking open questions:',
    ...bullets(blocking.map(question => question.text.trim())),
    ...(plan.open_questions.length > blocking.length ? ['', `${String(plan.open_questions.length - blocking.length)} other open questions and ${String(plan.risks.length)} risks are in the plan.`] : []),
    '',
    `The full plan, every task with its dependencies, acceptance criteria and sources: ${planPath}`,
    'Approve to create the tasks, or reject to end the run without writing anything.',
  ].join('\n');
}
