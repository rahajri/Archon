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
import { type ArchonDocument, type ArchonProject, ArchonProjectDocs } from './archon-docs.ts';
import { type ArchonTask, ArchonTracker, trackerBaseUrl } from './archon-tracker.ts';
import { mentionsDiscoveryMetadata } from './discoveries.ts';
import { type QualifiedPr, sameRepo } from './forge.ts';
import { PROJECT_FILE, readProjectContext } from './project-context.ts';
import { findRemote } from './remote.ts';
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

// --- the sources ------------------------------------------------------------------------

/** A specification as intake analyses it: the document, its markdown, and their fingerprint. */
export interface IntakeSource {
  readonly id: string;
  readonly title: string;
  readonly document_type: string;
  readonly metadata: Readonly<Record<string, unknown>>;
  /** SHA-256 of the id, title, type and content, so any change to what was analysed changes it. */
  readonly sha256: string;
  readonly content: string;
}

/** `intake/sources.json`: what one intake run analyses, and where it came from. */
export interface IntakeSources {
  readonly project: ArchonProject;
  readonly repo: Repo;
  readonly tracker_base_url: string;
  /** SHA-256 over the project id and every source's fingerprint. */
  readonly fingerprint: string;
  readonly documents: readonly IntakeSource[];
  /** The project's other documents, which are not specifications and are not analysed. */
  readonly set_aside: readonly { readonly id: string; readonly title: string; readonly document_type: string | null }[];
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

const KEY = /^[a-z0-9][a-z0-9-]{2,80}$/;
const MARKER_OPEN = '<!-- archon-project-intake ';
const MARKER_CLOSE = ' -->';
/**
 * Text that opens an intake comment in any spacing or case. A description holding one
 * anywhere but its canonical first line is corrupt metadata, never an unrelated task:
 * read as no intake task, its planned task would be created a second time.
 */
const INTAKE_METADATA = /<!--\s*archon-project-intake/i;

export function isIntakeKey(value: unknown): value is string {
  return typeof value === 'string' && KEY.test(value);
}

/** The first line of a task intake created for the planned task `key`. */
export function intakeMarker(key: string): string {
  if (!isIntakeKey(key)) throw new ProjectIntakeError(`"${key}" is not a planned task key`);
  return `${MARKER_OPEN}${key}${MARKER_CLOSE}`;
}

/** The planned task key a task's description records, or null when it holds no intake metadata. */
function intakeKeyOf(task: ArchonTask): string | null {
  const description = task.description ?? '';
  if (!INTAKE_METADATA.test(description)) return null;
  const [first = '', ...rest] = description.split(/\r?\n/);
  const key = first.startsWith(MARKER_OPEN) && first.endsWith(MARKER_CLOSE) ? first.slice(MARKER_OPEN.length, -MARKER_CLOSE.length) : '';
  if (!isIntakeKey(key) || rest.some(line => INTAKE_METADATA.test(line))) {
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

// --- the plan ---------------------------------------------------------------------------

/** The plan agent's statuses; the workflow's plan schema must admit exactly these. */
export const PLAN_STATUSES = ['ready', 'insufficient'] as const;
/** The task priorities; the workflow's plan schema must admit exactly these. */
export const PRIORITIES = ['critical', 'high', 'medium', 'low'] as const;

export interface SourceRef {
  readonly document_id: string;
  /** Where in the document: a section heading, a numbered requirement, or a short quote. */
  readonly location: string;
}

export interface SourcedStatement {
  readonly text: string;
  readonly source_refs: readonly SourceRef[];
}

export interface OpenQuestion extends SourcedStatement {
  readonly blocking: boolean;
}

export interface PlannedLot {
  readonly key: string;
  readonly title: string;
  readonly summary: string;
}

export interface PlannedTask {
  readonly key: string;
  readonly lot: string;
  readonly title: string;
  readonly description: string;
  readonly priority: (typeof PRIORITIES)[number];
  readonly dependencies: readonly string[];
  readonly acceptance_criteria: readonly string[];
  readonly source_refs: readonly SourceRef[];
}

/** The plan agent's output, as the workflow's plan schema admits it. */
export interface IntakePlan {
  readonly status: (typeof PLAN_STATUSES)[number];
  readonly reason: string;
  readonly objective: string;
  readonly scope: { readonly included: readonly string[]; readonly excluded: readonly string[] };
  readonly assumptions: readonly SourcedStatement[];
  readonly constraints: readonly SourcedStatement[];
  readonly lots: readonly PlannedLot[];
  readonly tasks: readonly PlannedTask[];
  readonly open_questions: readonly OpenQuestion[];
  readonly risks: readonly SourcedStatement[];
}

/** Collects every way a value is not a plan, so one refusal names them all. */
class PlanReader {
  readonly problems: string[] = [];

  constructor(private readonly documentIds: ReadonlySet<string>) {}

  text(value: unknown, at: string, required = true): string {
    if (typeof value !== 'string' || (required && value.trim() === '')) {
      this.problems.push(`${at} is not ${required ? 'a non-empty' : 'a'} string`);
      return '';
    }
    if (INTAKE_METADATA.test(value) || mentionsDiscoveryMetadata(value)) {
      this.problems.push(`${at} holds tracker metadata, which would leave its task unreadable to a later pass`);
    }
    return value;
  }

  line(value: unknown, at: string): string {
    const text = this.text(value, at);
    if (/[\r\n]/.test(text)) this.problems.push(`${at} is not one line`);
    return text;
  }

  list<T>(value: unknown, at: string, item: (entry: unknown, at: string) => T, minimum = 0): T[] {
    if (!Array.isArray(value)) {
      this.problems.push(`${at} is not a list`);
      return [];
    }
    if (value.length < minimum) this.problems.push(`${at} has fewer than ${String(minimum)} entries`);
    return value.map((entry, index) => item(entry, `${at}[${String(index)}]`));
  }

  object(value: unknown, at: string): Record<string, unknown> {
    if (isObject(value)) return value;
    this.problems.push(`${at} is not an object`);
    return {};
  }

  key(value: unknown, at: string): string {
    if (isIntakeKey(value)) return value;
    this.problems.push(`${at} is not a key (lowercase letters, digits and dashes, 3 to 81 characters)`);
    return '';
  }

  ref = (value: unknown, at: string): SourceRef => {
    const entry = this.object(value, at);
    const document_id = this.text(entry.document_id, `${at}.document_id`);
    if (document_id !== '' && !this.documentIds.has(document_id)) this.problems.push(`${at} cites ${document_id}, which is not an analysed source`);
    return { document_id, location: this.text(entry.location, `${at}.location`) };
  };

  statement = (value: unknown, at: string, minimumRefs: number): SourcedStatement => {
    const entry = this.object(value, at);
    return { text: this.text(entry.text, `${at}.text`), source_refs: this.list(entry.source_refs, `${at}.source_refs`, this.ref, minimumRefs) };
  };

  oneOf<T extends string>(value: unknown, at: string, allowed: readonly T[]): T {
    if (allowed.includes(value as T)) return value as T;
    this.problems.push(`${at} is not one of ${allowed.join(', ')}`);
    return allowed[0] as T;
  }
}

function lotOf(reader: PlanReader, value: unknown, at: string): PlannedLot {
  const entry = reader.object(value, at);
  return { key: reader.key(entry.key, `${at}.key`), title: reader.line(entry.title, `${at}.title`), summary: reader.text(entry.summary, `${at}.summary`) };
}

function taskOf(reader: PlanReader, value: unknown, at: string): PlannedTask {
  const entry = reader.object(value, at);
  return {
    key: reader.key(entry.key, `${at}.key`),
    lot: reader.key(entry.lot, `${at}.lot`),
    title: reader.line(entry.title, `${at}.title`),
    description: reader.text(entry.description, `${at}.description`),
    priority: reader.oneOf(entry.priority, `${at}.priority`, PRIORITIES),
    dependencies: reader.list(entry.dependencies, `${at}.dependencies`, (dependency, where) => reader.key(dependency, where)),
    acceptance_criteria: reader.list(entry.acceptance_criteria, `${at}.acceptance_criteria`, (criterion, where) => reader.text(criterion, where), 1),
    source_refs: reader.list(entry.source_refs, `${at}.source_refs`, reader.ref, 1),
  };
}

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

/**
 * The plan in `value`, every source it cites one of the analysed documents. Anything
 * else refuses, naming every problem: a plan that does not hold together is not shown
 * to the operator for approval.
 */
export function parsePlan(value: unknown, sources: { readonly documents: readonly { readonly id: string }[] }): IntakePlan {
  const reader = new PlanReader(new Set(sources.documents.map(document => document.id)));
  const plan = reader.object(value, 'plan');
  const status = reader.oneOf(plan.status, 'status', PLAN_STATUSES);
  const scope = reader.object(plan.scope, 'scope');
  const parsed: IntakePlan = {
    status,
    reason: reader.text(plan.reason, 'reason', status === 'insufficient'),
    objective: reader.text(plan.objective, 'objective', status === 'ready'),
    scope: {
      included: reader.list(scope.included, 'scope.included', (entry, at) => reader.text(entry, at)),
      excluded: reader.list(scope.excluded, 'scope.excluded', (entry, at) => reader.text(entry, at)),
    },
    assumptions: reader.list(plan.assumptions, 'assumptions', (entry, at) => reader.statement(entry, at, 1)),
    constraints: reader.list(plan.constraints, 'constraints', (entry, at) => reader.statement(entry, at, 1)),
    lots: reader.list(plan.lots, 'lots', (entry, at) => lotOf(reader, entry, at), status === 'ready' ? 1 : 0),
    tasks: reader.list(plan.tasks, 'tasks', (entry, at) => taskOf(reader, entry, at), status === 'ready' ? 1 : 0),
    open_questions: reader.list(plan.open_questions, 'open_questions', (entry, at) => {
      const question = reader.object(entry, at);
      if (typeof question.blocking !== 'boolean') reader.problems.push(`${at}.blocking is not true or false`);
      return { ...reader.statement(entry, at, 0), blocking: question.blocking === true };
    }),
    risks: reader.list(plan.risks, 'risks', (entry, at) => reader.statement(entry, at, 0)),
  };
  const problems = [...reader.problems, ...(reader.problems.length === 0 ? graphProblems(parsed.lots, parsed.tasks) : [])];
  if (problems.length > 0) throw new ProjectIntakeError(`the plan does not hold together: ${problems.join('; ')}`);
  return parsed;
}

// --- the approved plan and its writes -----------------------------------------------------

/** `intake/plan.json`: a ready plan, with the identity and sources it was made from. */
export interface IntakePlanFile {
  readonly project_id: string;
  readonly repo: Repo;
  readonly tracker_base_url: string;
  readonly fingerprint: string;
  readonly documents: readonly { readonly id: string; readonly title: string; readonly sha256: string }[];
  readonly plan: IntakePlan;
}

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
  if (
    !isObject(value) ||
    typeof value.project_id !== 'string' ||
    !isObject(value.repo) ||
    typeof value.repo.host !== 'string' ||
    typeof value.repo.path !== 'string' ||
    typeof value.tracker_base_url !== 'string' ||
    typeof value.fingerprint !== 'string' ||
    !Array.isArray(value.documents) ||
    !value.documents.every(document => isObject(document) && typeof document.id === 'string' && typeof document.title === 'string' && typeof document.sha256 === 'string')
  ) {
    throw new ProjectIntakeError('intake/plan.json is not a plan file this workflow wrote.');
  }
  const documents = value.documents as IntakePlanFile['documents'];
  return {
    project_id: value.project_id,
    repo: { host: value.repo.host, path: value.repo.path },
    tracker_base_url: value.tracker_base_url,
    fingerprint: value.fingerprint,
    documents,
    plan: parsePlan(value.plan, { documents }),
  };
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

/** A planned task's description: its marker, the agent's description, then the plan's metadata about it. */
export function intakeTaskDescription(task: PlannedTask, file: IntakePlanFile): string {
  const lot = file.plan.lots.find(entry => entry.key === task.lot);
  const titles = new Map(file.plan.tasks.map(entry => [entry.key, entry.title]));
  const documents = new Map(file.documents.map(document => [document.id, document.title]));
  const dependencies = task.dependencies.map(key => `\`${key}\` ${titles.get(key) ?? ''}`.trim());
  return [
    intakeMarker(task.key),
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
}

export interface WrittenTask {
  readonly key: string;
  readonly url: string;
}

/**
 * Create each planned task the project does not already hold, dependencies first. A task
 * an earlier run created is recovered by its marker, archived or not, and left as it is.
 * A failure partway names what this run created; running again recovers those.
 */
export async function createPlannedTasks(
  tracker: ArchonTracker,
  file: IntakePlanFile
): Promise<{ created: WrittenTask[]; recovered: WrittenTask[] }> {
  const existing = intakeTasks(await tracker.listProjectTasks());
  const created: WrittenTask[] = [];
  const recovered: WrittenTask[] = [];
  for (const task of creationOrder(file.plan.tasks)) {
    const found = existing.get(task.key);
    if (found !== undefined) {
      recovered.push({ key: task.key, url: tracker.taskUrl(found.id) });
      continue;
    }
    try {
      const id = await tracker.createTask({ title: task.title, description: intakeTaskDescription(task, file), status: 'todo' });
      created.push({ key: task.key, url: tracker.taskUrl(id) });
    } catch (error) {
      const done = created.length === 0 ? 'no task' : created.map(entry => entry.key).join(', ');
      throw new ProjectIntakeError(
        `creating ${task.key} failed after this run created ${done}; running the intake's create step again recovers what was created: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error }
      );
    }
  }
  return { created, recovered };
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
