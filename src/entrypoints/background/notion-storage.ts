import { getDefaultStore } from "jotai"
import { z } from "zod"
import { browser, storage } from "#imports"
import { writeConfigAtom } from "@/utils/atoms/config"
import { getLocalConfig } from "@/utils/config/storage"
import { findSelectionToolbarAction } from "@/utils/custom-actions"
import { onMessage } from "@/utils/message"
import { createNotionProvider, NotionSaveError } from "@/utils/note-storage/providers/notion"
import { notionConnectionSchema } from "@/utils/note-storage/types"

// Legacy credential storage is migrated into Config on first use.
const TOKEN_KEY = "local:notion-integration-token" as const

async function getNotionToken() {
  const config = await getLocalConfig()
  if (config?.notion !== undefined) {
    await storage.removeItem(TOKEN_KEY)
    return config.notion.apiKey || null
  }
  const legacy = await storage.getItem<string>(TOKEN_KEY)
  if (legacy && config) {
    await getDefaultStore().set(writeConfigAtom, (current) =>
      current.notion === undefined ? { notion: { apiKey: legacy } } : {},
    )
    await storage.removeItem(TOKEN_KEY)
  }
  return legacy
}

export function setupNotionStorageHandlers() {
  // Existing installations include their saved credential in the next export.
  const ready = getNotionToken().catch(() => null)
  onMessage("notionSetToken", async ({ data, sender }) => {
    // Credential mutations are accepted only from our options document.
    const optionsUrl = browser.runtime.getURL("/options.html")
    if (!sender.url || sender.url.split(/[?#]/)[0] !== optionsUrl)
      throw new Error("Open extension settings to manage the Notion token.")
    await ready
    const token = z.string().trim().max(512).parse(data.token)
    await getDefaultStore().set(writeConfigAtom, () => ({ notion: { apiKey: token || undefined } }))
    await storage.removeItem(TOKEN_KEY)
  })
  onMessage("notionListDatabases", async () => {
    try {
      await ready
      const token = await getNotionToken()
      if (!token) throw new Error("Set your Notion integration token in extension settings.")
      return { ok: true as const, value: await createNotionProvider(token).listDatabases() }
    } catch (error) {
      return {
        ok: false as const,
        error: error instanceof Error ? error.message : "Notion databases unavailable.",
      }
    }
  })
  onMessage("notionGetProperties", async ({ data }) => {
    try {
      await ready
      const id = notionConnectionSchema.shape.dataSourceId.parse(data.dataSourceId)
      const token = await getNotionToken()
      if (!token) throw new Error("Set your Notion integration token in extension settings.")
      return { ok: true as const, value: await createNotionProvider(token).getProperties(id) }
    } catch (error) {
      return {
        ok: false as const,
        error: error instanceof Error ? error.message : "Notion schema unavailable.",
      }
    }
  })
  // One queue for all actions and tabs; concurrent saves must not burst the API.
  let queue: Promise<unknown> = Promise.resolve()
  onMessage("notionSave", ({ data }) => {
    const operation = queue.then(async () => {
      try {
        await ready
        const request = z
          .object({
            actionId: z.string().min(1),
            records: z.array(z.record(z.string(), z.unknown())).min(1).max(100),
          })
          .parse(data)
        const config = await getLocalConfig()
        const action =
          config && findSelectionToolbarAction(config.selectionToolbar, request.actionId)
        if (!action?.notionConnection)
          throw new Error("Configure a Notion connection for this action first.")
        const token = await getNotionToken()
        if (!token) throw new Error("Set your Notion integration token in extension settings.")
        const value = await createNotionProvider(token).save(
          action.notionConnection,
          action.outputSchema,
          request.records,
        )
        return { ok: true as const, value }
      } catch (error) {
        return {
          ok: false as const,
          error: error instanceof Error ? error.message : "Notion save failed.",
          savedCount: error instanceof NotionSaveError ? error.savedCount : 0,
        }
      }
    })
    queue = operation
    return operation
  })
}
