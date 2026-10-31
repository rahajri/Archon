/**
 * Capture the part of the Archon task tracker's OpenAPI document the SDLC pack's tracker
 * clients (`.archon/workflows/sdlc/.shared/archon-tracker.ts` and `archon-docs.ts`) call:
 * the operations they send and the schemas their request bodies name. `archon-tracker.test.ts` holds every
 * request the clients send against this capture, so a client change that leaves the
 * contract fails there, and `--check` against a running tracker shows when the service
 * moved away from the capture.
 *
 *   ARCHON_TRACKER_BASE_URL=http://127.0.0.1:8181 bun .archon/scripts/archon-tracker-openapi.ts [--check]
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { trackerBaseUrl } from '../workflows/sdlc/.shared/archon-tracker.ts';
import { isObject } from '../workflows/sdlc/.shared/typed.ts';

export const CAPTURE = resolve(import.meta.dir, '__tests__/fixtures/archon-tracker-openapi.json');

/** The operations the clients send, as `[path, method]`. */
const OPERATIONS = [
  ['/api/tasks', 'post'],
  ['/api/tasks/{task_id}', 'get'],
  ['/api/projects/{project_id}/tasks', 'get'],
  ['/api/projects/{project_id}', 'get'],
  ['/api/projects/{project_id}/docs', 'get'],
  ['/api/projects/{project_id}/docs/{doc_id}', 'get'],
] as const;

const SCHEMA_REF = '#/components/schemas/';

function schemaRefs(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(schemaRefs);
  if (!isObject(value)) return [];
  const own = typeof value.$ref === 'string' && value.$ref.startsWith(SCHEMA_REF) ? [value.$ref.slice(SCHEMA_REF.length)] : [];
  return [...own, ...Object.values(value).flatMap(schemaRefs)];
}

function capture(document: unknown): Record<string, unknown> {
  if (!isObject(document) || !isObject(document.paths) || !isObject(document.components)) {
    throw new Error('the tracker did not serve an OpenAPI document');
  }
  const { paths, components } = document;
  const kept: Record<string, Record<string, unknown>> = {};
  for (const [path, method] of OPERATIONS) {
    const operation = isObject(paths[path]) ? paths[path][method] : undefined;
    if (!isObject(operation)) throw new Error(`the tracker has no ${method.toUpperCase()} ${path}`);
    kept[path] = { ...kept[path], [method]: { parameters: operation.parameters ?? [], requestBody: operation.requestBody ?? null } };
  }
  const all = isObject(components.schemas) ? components.schemas : {};
  const schemas: Record<string, unknown> = {};
  const pending = schemaRefs(kept);
  for (let name = pending.pop(); name !== undefined; name = pending.pop()) {
    if (name in schemas) continue;
    if (all[name] === undefined) throw new Error(`the tracker's document has no schema ${name}`);
    schemas[name] = all[name];
    pending.push(...schemaRefs(all[name]));
  }
  return { paths: kept, components: { schemas } };
}

async function main(): Promise<void> {
  const url = new URL('openapi.json', trackerBaseUrl(process.env.ARCHON_TRACKER_BASE_URL));
  const response = await fetch(url);
  if (!response.ok) throw new Error(`GET ${url.pathname} failed with ${String(response.status)}`);
  const text = `${JSON.stringify(capture(await response.json()), null, 2)}\n`;
  if (!process.argv.includes('--check')) {
    writeFileSync(CAPTURE, text);
    return;
  }
  if (readFileSync(CAPTURE, 'utf8') !== text) {
    console.error(`${CAPTURE} differs from the running tracker's contract; run this script without --check and review the change.`);
    process.exit(1);
  }
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
