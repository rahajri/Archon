/**
 * The metadata families Factory workflows write into an Archon project's task
 * descriptions, and the one guard every writer into that shared task space applies.
 *
 * Each family belongs to one workflow, which alone parses it: archon-discovery to
 * ./discoveries.ts, archon-project-intake to ./project-intake.ts. Each parser reads
 * any opening of its family's comment, in any spacing or case, outside its canonical
 * header as corrupt and refuses the whole read rather than skipping the task. So text a
 * writer copies into a description must hold no opening of any family, its own or
 * another workflow's: one quoted marker would wedge every later run of the owner.
 * HTML comments outside these families are not metadata and pass.
 */

export const TASK_METADATA_FAMILIES = ['archon-discovery', 'archon-project-intake'] as const;

export type TaskMetadataFamily = (typeof TASK_METADATA_FAMILIES)[number];

/** Whether `text` opens a comment of `family`, in any spacing or case. */
export function opensTaskMetadata(family: TaskMetadataFamily, text: string): boolean {
  return new RegExp(`<!--\\s*${family}`, 'i').test(text);
}

/** The families whose comments `text` opens; empty when a writer may copy it into a task. */
export function taskMetadataIn(text: string): TaskMetadataFamily[] {
  return TASK_METADATA_FAMILIES.filter(family => opensTaskMetadata(family, text));
}
