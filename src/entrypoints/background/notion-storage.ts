import { z } from "zod"
import { browser, storage } from "#imports"
import { getLocalConfig } from "@/utils/config/storage"
import { findSelectionToolbarAction } from "@/utils/custom-actions"
import { onMessage } from "@/utils/message"
import { createNotionProvider, NotionSaveError } from "@/utils/note-storage/providers/notion"
import { notionConnectionSchema } from "@/utils/note-storage/types"

// Deliberately outside Config: never exported, synced or backed up with it.
const TOKEN_KEY = "local:notion-integration-token" as const

export function setupNotionStorageHandlers() {
  onMessage("notionSetToken", async ({ data, sender }) => {
    // Credential mutations are accepted only from our options document.
    const optionsUrl = browser.runtime.getURL("/options.html")
    if (!sender.url || sender.url.split(/[?#]/)[0] !== optionsUrl)
      throw new Error("Open extension settings to manage the Notion token.")
    const token = z.string().trim().max(512).parse(data.token)
    if (token) await storage.setItem(TOKEN_KEY, token)
    else await storage.removeItem(TOKEN_KEY)
  })
  onMessage("notionGetProperties", async ({ data }) => {
    try {
      const id = notionConnectionSchema.shape.dataSourceId.parse(data.dataSourceId)
      const token = await storage.getItem<string>(TOKEN_KEY)
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
        const token = await storage.getItem<string>(TOKEN_KEY)
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
