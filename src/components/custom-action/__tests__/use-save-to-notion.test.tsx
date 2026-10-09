// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { DEFAULT_CONFIG } from "@/utils/constants/config"
import { getBuiltInDictionaryAction } from "@/utils/custom-actions"
import { useSaveToNotion } from "../use-save-to-notion"

const mocks = vi.hoisted(() => ({
  send: vi.fn<(...args: any[]) => any>(),
  toast: vi.fn<(...args: any[]) => any>(),
}))
vi.mock("@/utils/message", () => ({ sendMessage: mocks.send }))
vi.mock("@/components/ui/base-ui/toast", () => ({
  toastManager: { add: mocks.toast, close: vi.fn<() => void>() },
}))
const action = {
  ...getBuiltInDictionaryAction(DEFAULT_CONFIG.selectionToolbar),
  notionConnection: {
    provider: "notion" as const,
    dataSourceId: "12345678-1234-1234-1234-123456789abc",
    mappings: [{ localFieldId: "word", propertyId: "title", propertyType: "title" as const }],
  },
}
const results = [{ Word: "frog" }, { Word: "pond" }]

beforeEach(() => vi.clearAllMocks())

describe("Notion save orchestration", () => {
  it("skips confirmed successes when retrying the same partially saved batch", async () => {
    mocks.send
      .mockResolvedValueOnce({ ok: false, error: "1 of 2 saved", savedCount: 1 })
      .mockResolvedValueOnce({ ok: true, value: { urls: ["https://www.notion.so/pond"] } })
    const { result } = renderHook(useSaveToNotion)
    await act(async () => {
      expect(await result.current.save({ action, results })).toBe("failed")
    })
    await act(async () => {
      expect(await result.current.save({ action, results })).toBe("saved")
    })
    expect(mocks.send).toHaveBeenNthCalledWith(2, "notionSave", {
      actionId: action.id,
      records: [results[1]],
    })
    await act(async () => {
      expect(await result.current.save({ action, results })).toBe("saved")
    })
    expect(mocks.send).toHaveBeenCalledTimes(2)
  })
  it("does not skip records when the destination changes", async () => {
    mocks.send.mockResolvedValue({ ok: true, value: { urls: ["https://www.notion.so/page"] } })
    const { result } = renderHook(useSaveToNotion)
    await act(async () => {
      await result.current.save({ action, results })
    })
    const nextAction = {
      ...action,
      notionConnection: {
        ...action.notionConnection,
        dataSourceId: "22345678-1234-1234-1234-123456789abc",
      },
    }
    await act(async () => {
      await result.current.save({ action: nextAction, results })
    })
    expect(mocks.send).toHaveBeenCalledTimes(2)
    expect(mocks.send).toHaveBeenLastCalledWith("notionSave", {
      actionId: action.id,
      records: results,
    })
  })
  it("rejects duplicate clicks while a request is pending", async () => {
    let resolve: (value: unknown) => void = () => {}
    mocks.send.mockReturnValue(
      new Promise((done) => {
        resolve = done
      }),
    )
    const { result } = renderHook(useSaveToNotion)
    await act(async () => {
      const first = result.current.save({ action, results })
      expect(await result.current.save({ action, results })).toBe("failed")
      resolve({ ok: true, value: { urls: [] } })
      expect(await first).toBe("saved")
    })
    expect(mocks.send).toHaveBeenCalledTimes(1)
  })
})
