import type { SaveToNotebaseRequest } from "./use-save-to-notebase"
import { useSaveToNotebase } from "./use-save-to-notebase"
import { useSaveToNotion } from "./use-save-to-notion"

/** Additive provider dispatch keeps upstream authentication and save flow intact. */
export function useSaveToNoteStorage() {
  const notebase = useSaveToNotebase()
  const notion = useSaveToNotion()
  return {
    ...notebase,
    isSaving: notebase.isSaving || notion.isSaving,
    save: (request: SaveToNotebaseRequest) =>
      request.action.notionConnection ? notion.save(request) : notebase.save(request),
  }
}
