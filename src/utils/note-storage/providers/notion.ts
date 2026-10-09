import type {
  NotionDatabase,
  NoteStorageField,
  NoteStorageProperty,
  NoteStorageProvider,
  NotionConnection,
} from "../types"

export class NotionSaveError extends Error {
  constructor(
    message: string,
    public savedCount: number,
  ) {
    super(message)
  }
}

function textFragments(value: unknown) {
  if (typeof value !== "string")
    throw new Error("Notion text properties require text output fields.")
  // Notion permits at most 100 rich-text elements of 2,000 characters each.
  const characters = Array.from(value)
  if (characters.length > 200_000) throw new Error("Notion text exceeds 200,000 characters.")
  const fragments = []
  for (let i = 0; i < characters.length; i += 2000) {
    fragments.push({ type: "text", text: { content: characters.slice(i, i + 2000).join("") } })
  }
  return fragments
}

export function buildNotionProperties(
  connection: NotionConnection,
  fields: NoteStorageField[],
  schema: NoteStorageProperty[],
  record: Record<string, unknown>,
) {
  const properties: Record<string, unknown> = {}
  const seenFields = new Set<string>()
  const seenProperties = new Set<string>()
  let hasTitle = false
  for (const mapping of connection.mappings) {
    const field = fields.find((candidate) => candidate.id === mapping.localFieldId)
    const property = schema.find((candidate) => candidate.id === mapping.propertyId)
    if (!field || !property || property.type !== mapping.propertyType)
      throw new Error("Notion fields changed. Refresh the schema and repair the mappings.")
    if (seenFields.has(field.id) || seenProperties.has(property.id))
      throw new Error("Notion mappings must use each field and property only once.")
    seenFields.add(field.id)
    seenProperties.add(property.id)
    const value = record[field.name]
    if (property.type === "number") {
      if (field.type !== "number" || typeof value !== "number" || !Number.isFinite(value))
        throw new Error(`Invalid numeric output: ${field.name}`)
      properties[property.id] = { number: value }
    } else {
      if (field.type !== "string")
        throw new Error(`Notion text mapping requires a text field: ${field.name}`)
      if (property.type === "title") {
        if (typeof value !== "string" || !value.trim())
          throw new Error("Notion requires a non-empty title.")
        hasTitle = true
      }
      properties[property.id] = { [property.type]: textFragments(value) }
    }
  }
  if (!hasTitle) throw new Error("Map a text output field to the Notion title property.")
  return properties
}

export function isNotionPageUrl(value: unknown): value is string {
  if (typeof value !== "string") return false
  try {
    const url = new URL(value)
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.port &&
      ["app.notion.com", "www.notion.com", "notion.com", "www.notion.so", "notion.so"].includes(
        url.hostname,
      )
    )
  } catch {
    return false
  }
}

export function createNotionProvider(
  token: string,
  requestFetch: typeof fetch = fetch,
): NoteStorageProvider<NotionConnection> & { listDatabases: () => Promise<NotionDatabase[]> } {
  async function request(path: string, body?: unknown): Promise<unknown> {
    for (let attempt = 0; attempt < 3; attempt++) {
      let response: Response
      try {
        response = await requestFetch(`https://api.notion.com/v1/${path}`, {
          method: body === undefined ? "GET" : "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Notion-Version": "2026-03-11",
            "Content-Type": "application/json",
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(30_000),
          redirect: "error",
        })
      } catch {
        // A failed create may already have succeeded; never retry it automatically.
        throw new Error("Notion request interrupted. Check the database before saving again.")
      }
      if (response.status === 429 && attempt < 2) {
        const seconds = Number(response.headers.get("Retry-After") ?? "1")
        if (!Number.isFinite(seconds) || seconds < 0 || seconds > 30)
          throw new Error("Notion is rate limited. Try again later.")
        await new Promise((resolve) => setTimeout(resolve, Math.max(seconds, 1) * 1000))
        continue
      }
      if (!response.ok) {
        // Do not surface raw API bodies, which can echo submitted private data.
        const reasons: Record<number, string> = {
          401: "Invalid Notion token.",
          403: "Notion integration lacks permission.",
          404: "Notion data source unavailable. Share the database with your integration.",
          400: "Notion rejected the properties. Refresh your schema and mappings.",
          429: "Notion is rate limited. Try again later.",
        }
        throw new Error(
          reasons[response.status] ??
            `Notion request failed (${response.status}). Check the database before saving again.`,
        )
      }
      try {
        return await response.json()
      } catch {
        throw new Error("Invalid Notion response. Check the database before saving again.")
      }
    }
    throw new Error("Notion is rate limited.")
  }
  const getProperties = async (id: string): Promise<NoteStorageProperty[]> => {
    const result = (await request(`data_sources/${encodeURIComponent(id)}`)) as {
      properties: Record<string, NoteStorageProperty>
    }
    return Object.entries(result.properties).map(([name, property]) => ({
      id: property.id,
      name,
      type: property.type,
    }))
  }
  return {
    getProperties,
    async listDatabases() {
      const databases = new Map<string, NotionDatabase>()
      const currentSources = new Map<string, { id: string; name: string }[]>()
      let cursor: string | undefined
      const seenCursors = new Set<string>()
      do {
        const result = (await request("search", {
          filter: { property: "object", value: "data_source" },
          page_size: 100,
          ...(cursor ? { start_cursor: cursor } : {}),
        })) as {
          results: {
            id: string
            in_trash?: boolean
            archived?: boolean
            title: { plain_text: string }[]
            parent: { database_id?: string }
          }[]
          has_more: boolean
          next_cursor: string | null
        }
        for (const source of result.results) {
          const id = source.parent.database_id
          if (!id || source.in_trash || source.archived) continue
          let database = databases.get(id)
          if (!database) {
            const metadata = (await request(`databases/${encodeURIComponent(id)}`)) as {
              title: { plain_text: string }[]
              data_sources: { id: string; name: string }[]
              in_trash?: boolean
            }
            currentSources.set(id, metadata.in_trash ? [] : metadata.data_sources)
            database = {
              id,
              name: metadata.title.map((text) => text.plain_text).join("") || "Untitled database",
              dataSources: [],
            }
            databases.set(id, database)
          }
          const currentSource = currentSources.get(id)?.find((item) => item.id === source.id)
          if (currentSource && !database.dataSources.some((item) => item.id === source.id))
            database.dataSources.push({
              id: source.id,
              name:
                currentSource.name ||
                source.title.map((text) => text.plain_text).join("") ||
                "Untitled data source",
            })
        }
        cursor = result.has_more ? (result.next_cursor ?? undefined) : undefined
        if (result.has_more && (!cursor || seenCursors.has(cursor)))
          throw new Error("Invalid Notion search pagination.")
        if (cursor) seenCursors.add(cursor)
      } while (cursor)
      return [...databases.values()].filter((database) => database.dataSources.length > 0)
    },
    async save(connection, fields, records) {
      const schema = await getProperties(connection.dataSourceId)
      // Validate every record before creating the first page.
      const properties = records.map((record) =>
        buildNotionProperties(connection, fields, schema, record),
      )
      const urls: string[] = []
      try {
        for (const [index, property] of properties.entries()) {
          if (index > 0) await new Promise((resolve) => setTimeout(resolve, 350))
          const page = (await request("pages", {
            parent: { type: "data_source_id", data_source_id: connection.dataSourceId },
            properties: property,
          })) as { url: string }
          if (!isNotionPageUrl(page.url))
            throw new Error(
              "Unexpected Notion page response. Check the database before saving again.",
            )
          urls.push(page.url)
        }
      } catch (error) {
        throw new NotionSaveError(
          `${urls.length} of ${records.length} saved. ${error instanceof Error ? error.message : "Save failed."}`,
          urls.length,
        )
      }
      return { urls }
    },
  }
}
