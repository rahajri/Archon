/**
 * The subset of JSON Schema a node's `output_format` declares, as values a script can both
 * hand the workflow and check a value against. A schema built here is one owner for three
 * things: what the workflow asks a node for, the TypeScript type a script reads it as
 * (`Infer`), and the runtime check that the value is that (`conforms`). A test holds the
 * workflow YAML equal to the schema, so neither side can drift.
 *
 * Objects are closed and require every property they declare, which is also what
 * strict structured-output providers demand.
 */

import { isObject } from './typed.ts';

export type Schema =
  | { readonly type: 'string'; readonly pattern?: string; readonly enum?: readonly string[] }
  | NullableString
  | { readonly type: 'boolean' }
  | { readonly type: 'integer' }
  | { readonly type: 'array'; readonly items: Schema; readonly minItems?: number }
  | ObjectSchema<Readonly<Record<string, Schema>>>
  /** Any object: a record whose fields belong to someone else, such as a tracker's metadata. */
  | { readonly type: 'object'; readonly properties?: never };

export interface NullableString {
  readonly type: readonly ['string', 'null'];
}

export interface ObjectSchema<P extends Readonly<Record<string, Schema>>> {
  readonly type: 'object';
  readonly additionalProperties: false;
  readonly properties: P;
  readonly required: readonly (keyof P & string)[];
}

/** The value a schema admits. */
export type Infer<S> = S extends { readonly type: 'string'; readonly enum: readonly (infer E)[] }
  ? E
  : S extends { readonly type: 'string' }
    ? string
    : S extends NullableString
      ? string | null
      : S extends { readonly type: 'boolean' }
        ? boolean
        : S extends { readonly type: 'integer' }
          ? number
          : S extends { readonly type: 'array'; readonly items: infer I }
            ? readonly Infer<I>[]
            : S extends ObjectSchema<infer P>
              ? { readonly [K in keyof P]: Infer<P[K]> }
              : S extends { readonly type: 'object' }
                ? Readonly<Record<string, unknown>>
                : never;

/** A closed object schema requiring every property it declares. */
export function object<const P extends Readonly<Record<string, Schema>>>(properties: P): ObjectSchema<P> {
  return { type: 'object', additionalProperties: false, properties, required: Object.keys(properties) };
}

/**
 * Whether `value` is what `schema` admits. Every departure is appended to `problems`,
 * named by its path from `at`, so one refusal can name them all.
 */
export function conforms<S extends Schema>(schema: S, value: unknown, at: string, problems: string[]): value is Infer<S> {
  const before = problems.length;
  check(schema, value, at, problems);
  return problems.length === before;
}

function isNullableString(schema: Schema): schema is NullableString {
  return Array.isArray(schema.type);
}

type Of<T extends Schema['type']> = Extract<Schema, { readonly type: T }>;

function check(schema: Schema, value: unknown, at: string, problems: string[]): void {
  if (isNullableString(schema)) {
    if (typeof value !== 'string' && value !== null) problems.push(`${at} is not a string or null`);
    return;
  }
  switch (schema.type) {
    case 'string':
      return checkString(schema, value, at, problems);
    case 'boolean':
      if (typeof value !== 'boolean') problems.push(`${at} is not true or false`);
      return;
    case 'integer':
      if (!Number.isInteger(value)) problems.push(`${at} is not an integer`);
      return;
    case 'array':
      return checkArray(schema, value, at, problems);
    case 'object':
      return checkObject(schema, value, at, problems);
    default:
      schema satisfies never;
  }
}

function checkString(schema: Of<'string'>, value: unknown, at: string, problems: string[]): void {
  if (typeof value !== 'string') problems.push(`${at} is not a string`);
  else if (schema.enum !== undefined && !schema.enum.includes(value)) problems.push(`${at} is not one of ${schema.enum.join(', ')}`);
  else if (schema.pattern !== undefined && !new RegExp(schema.pattern, 'u').test(value)) problems.push(`${at} does not match ${schema.pattern}`);
}

function checkArray(schema: Of<'array'>, value: unknown, at: string, problems: string[]): void {
  if (!Array.isArray(value)) {
    problems.push(`${at} is not a list`);
    return;
  }
  if (value.length < (schema.minItems ?? 0)) problems.push(`${at} has fewer than ${String(schema.minItems)} entries`);
  value.forEach((entry, index) => check(schema.items, entry, `${at}[${String(index)}]`, problems));
}

function checkObject(schema: Of<'object'>, value: unknown, at: string, problems: string[]): void {
  if (!isObject(value)) {
    problems.push(`${at} is not an object`);
    return;
  }
  if (schema.properties === undefined) return;
  for (const field of schema.required) if (!Object.hasOwn(value, field)) problems.push(`${at}.${field} is missing`);
  for (const [field, entry] of Object.entries(value)) {
    if (Object.hasOwn(schema.properties, field)) check(schema.properties[field] as Schema, entry, `${at}.${field}`, problems);
    else problems.push(`${at}.${field} is not a field it declares`);
  }
}
