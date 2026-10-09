import { z } from "zod"

export const notionConnectionSchema = z.object({
  provider: z.literal("notion"),
  dataSourceId: z
    .string()
    .regex(/^[\da-f]{32}$|^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i),
  mappings: z
    .array(
      z.object({
        localFieldId: z.string().min(1),
        propertyId: z.string().min(1),
        propertyType: z.enum(["title", "rich_text", "number"]),
      }),
    )
    .min(1),
})

export type NotionConnection = z.infer<typeof notionConnectionSchema>
export interface NoteStorageField {
  id: string
  name: string
  type: string
}
export interface NoteStorageProperty {
  id: string
  name: string
  type: string
}
export interface NoteStorageSaveResult {
  urls: string[]
}
export type NoteStorageReply<T> =
  | { ok: true; value: T }
  | { ok: false; error: string; savedCount?: number }

/** Backend providers receive credentials only in the extension background. */
export interface NoteStorageProvider<TConnection> {
  getProperties: (targetId: string) => Promise<NoteStorageProperty[]>
  save: (
    connection: TConnection,
    fields: NoteStorageField[],
    records: Record<string, unknown>[],
  ) => Promise<NoteStorageSaveResult>
}
