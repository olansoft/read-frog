import type { SaveToNotebaseRequest, SaveToNotebaseOutcome } from "./use-save-to-notebase"
import { useRef, useState } from "react"
import { toastManager } from "@/components/ui/base-ui/toast"
import { sendMessage } from "@/utils/message"

export function useSaveToNotion() {
  const [isSaving, setIsSaving] = useState(false)
  const busy = useRef(false)
  // Retain confirmed successes after a partial batch to prevent resubmitting them.
  const progress = useRef<{ actionId: string; records: string; count: number } | null>(null)
  const save = async ({
    action,
    results,
  }: SaveToNotebaseRequest): Promise<SaveToNotebaseOutcome> => {
    if (busy.current || !results.length) return "failed"
    busy.current = true
    setIsSaving(true)
    try {
      const fingerprint = JSON.stringify({ connection: action.notionConnection, results })
      const previous = progress.current
      const offset =
        previous?.actionId === action.id && previous.records === fingerprint ? previous.count : 0
      if (offset === results.length) return "saved"
      const reply = await sendMessage("notionSave", {
        actionId: action.id,
        records: results.slice(offset),
      })
      if (!reply.ok) {
        progress.current = {
          actionId: action.id,
          records: fingerprint,
          count: offset + (reply.savedCount ?? 0),
        }
        throw new Error(reply.error)
      }
      progress.current = { actionId: action.id, records: fingerprint, count: results.length }
      const url = reply.value.urls[0]
      const id = toastManager.add({
        type: "success",
        title: "Saved to Notion",
        actionProps: url
          ? {
              children: "Open in Notion",
              onClick: () => {
                toastManager.close(id)
                void sendMessage("openPage", { url, active: true })
              },
            }
          : undefined,
      })
      return "saved"
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not save to Notion",
        description:
          error instanceof Error ? error.message : "Check the database before saving again.",
      })
      return "failed"
    } finally {
      busy.current = false
      setIsSaving(false)
    }
  }
  return { save, isSaving }
}
