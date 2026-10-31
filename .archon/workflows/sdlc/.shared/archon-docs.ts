/**
 * The documents attached to one Archon project: what the operator uploads in the
 * project's Docs tab, on the same service as its tasks (./archon-tracker.ts).
 *
 * Every read names the context's `archonProjectId` in its path, and every response is
 * checked to be the project or document it was asked for, so a tracker that answers for
 * another project or document is refused rather than read. The tracker's OpenAPI document
 * leaves these response bodies untyped; the fields read here are the ones it returns.
 */

import { ArchonTrackerError, trackerRequest } from './archon-tracker.ts';
import type { ArchonProjectContext } from './project-context.ts';
import { isObject } from './typed.ts';

export interface ArchonProject {
  readonly id: string;
  readonly title: string;
}

/** A project document as the tracker stores it. */
export interface ArchonDocument {
  readonly id: string;
  readonly title: string;
  /** The type the operator gave it in the Docs tab, such as `spec`; null when the tracker returns none. */
  readonly document_type: string | null;
  /** The tracker's `content` object, unread: what it holds depends on how the document was written. */
  readonly content: unknown;
  /** Every other field the tracker returns, such as its status, version, tags and author. */
  readonly metadata: Readonly<Record<string, unknown>>;
}

export class ArchonProjectDocs {
  constructor(
    readonly context: ArchonProjectContext,
    /** As `trackerBaseUrl` accepted it, so it may be printed and carried. */
    readonly baseUrl: URL,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  /** The project itself, refused when the tracker answers with another one. */
  async readProject(): Promise<ArchonProject> {
    const body = await this.get(this.projectPath(''));
    if (!isObject(body) || body.id !== this.projectId || typeof body.title !== 'string') {
      throw new ArchonTrackerError(`the tracker does not read back project ${this.projectId}: ${shape(body)}`, null);
    }
    return { id: body.id, title: body.title };
  }

  /**
   * Every document attached to the project, each read in full: the listing carries only
   * metadata, so each listed document is then read by its id in this project.
   */
  async readDocuments(): Promise<ArchonDocument[]> {
    const listing = await this.get(this.projectPath('/docs'));
    if (!isObject(listing) || listing.project_id !== this.projectId || !Array.isArray(listing.documents)) {
      throw new ArchonTrackerError(`the tracker's document list is not project ${this.projectId}'s: ${excerpt(listing)}`, null);
    }
    if (listing.total_count !== listing.documents.length) {
      throw new ArchonTrackerError(
        `the tracker lists ${String(listing.documents.length)} of project ${this.projectId}'s ${String(listing.total_count)} documents.`,
        null
      );
    }
    const documents: ArchonDocument[] = [];
    for (const entry of listing.documents) {
      if (!isObject(entry) || typeof entry.id !== 'string') {
        throw new ArchonTrackerError(`the tracker lists something that is not a document: ${excerpt(entry)}`, null);
      }
      documents.push(await this.readDocument(entry.id));
    }
    return documents;
  }

  private async readDocument(id: string): Promise<ArchonDocument> {
    const body = await this.get(this.projectPath(`/docs/${encodeURIComponent(id)}`));
    if (!isObject(body) || body.id !== id) {
      throw new ArchonTrackerError(`the tracker does not read back document ${id} of project ${this.projectId}: ${shape(body)}`, null);
    }
    const { id: _, title, document_type, content, ...metadata } = body;
    if (typeof title !== 'string' || (document_type !== undefined && document_type !== null && typeof document_type !== 'string')) {
      throw new ArchonTrackerError(`the tracker reads back document ${id} without a title or with a malformed type: ${shape(body)}`, null);
    }
    return { id, title, document_type: document_type ?? null, content: content ?? null, metadata };
  }

  private get projectId(): string {
    return this.context.archonProjectId;
  }

  private projectPath(rest: string): URL {
    return new URL(`api/projects/${encodeURIComponent(this.projectId)}${rest}`, this.baseUrl);
  }

  private get(url: URL): Promise<unknown> {
    return trackerRequest(this.fetchImpl, 'GET', url);
  }
}

/** A listing response, which carries metadata only, as a short excerpt. */
function excerpt(value: unknown): string {
  return JSON.stringify(value)?.slice(0, 500) ?? String(value);
}

/**
 * A response that may hold document content, by its shape alone: the content is the
 * operator's data and stays out of diagnostics.
 */
function shape(value: unknown): string {
  if (!isObject(value)) return `a ${value === null ? 'null' : typeof value} value`;
  const id = typeof value.id === 'string' ? `id ${value.id}, ` : '';
  return `an object with ${id}fields ${Object.keys(value).join(', ')}`;
}
