import type { Config } from "@/types/config/config"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { browser, storage } from "#imports"
import { DEFAULT_CONFIG } from "@/utils/constants/config"
import { getBuiltInDictionaryAction, replaceSelectionToolbarAction } from "@/utils/custom-actions"

const mocks = vi.hoisted(() => ({
  writeConfig: vi.fn<(...args: any[]) => Promise<void>>(),
  onMessage: vi.fn<(...args: any[]) => any>(),
  getConfig: vi.fn<() => Promise<Config | null>>(),
  listDatabases: vi.fn<(...args: any[]) => any>(),
  getProperties: vi.fn<(...args: any[]) => any>(),
  save: vi.fn<(...args: any[]) => any>(),
  provider: vi.fn<(...args: any[]) => any>(),
}))
vi.mock("jotai", () => ({ getDefaultStore: () => ({ set: mocks.writeConfig }) }))
vi.mock("@/utils/atoms/config", () => ({ writeConfigAtom: "config-writer" }))
vi.mock("@/utils/message", () => ({ onMessage: mocks.onMessage }))
vi.mock("@/utils/config/storage", () => ({ getLocalConfig: mocks.getConfig }))
vi.mock("@/utils/note-storage/providers/notion", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/utils/note-storage/providers/notion")>()
  return { ...actual, createNotionProvider: mocks.provider }
})

function handler(name: string) {
  const registration = mocks.onMessage.mock.calls.find(([key]) => key === name)
  if (!registration) throw new Error(`Missing handler ${name}`)
  return registration[1] as (message: {
    data: unknown
    sender?: { url: string }
  }) => Promise<unknown>
}

beforeEach(async () => {
  vi.clearAllMocks()
  mocks.getConfig.mockResolvedValue(structuredClone(DEFAULT_CONFIG))
  mocks.writeConfig.mockImplementation(async (_atom, patch) => {
    const config = await mocks.getConfig()
    mocks.getConfig.mockResolvedValue({
      ...config!,
      ...(typeof patch === "function" ? patch(config!) : patch),
    })
  })
  await storage.removeItem("local:notion-integration-token")
  const { setupNotionStorageHandlers } = await import("../notion-storage")
  setupNotionStorageHandlers()
  mocks.provider.mockReturnValue({
    listDatabases: mocks.listDatabases,
    getProperties: mocks.getProperties,
    save: mocks.save,
  })
  mocks.getProperties.mockResolvedValue([])
  mocks.save.mockResolvedValue({ urls: ["https://www.notion.so/saved"] })
})

describe("Notion background handlers", () => {
  it("uses credentials restored from configuration instead of legacy storage", async () => {
    mocks.getConfig.mockResolvedValue({
      ...structuredClone(DEFAULT_CONFIG),
      notion: { apiKey: "imported-token" },
    })
    await storage.setItem("local:notion-integration-token", "outdated-token")
    mocks.listDatabases.mockResolvedValue([])
    expect(await handler("notionListDatabases")({ data: undefined })).toMatchObject({ ok: true })
    expect(mocks.provider).toHaveBeenCalledWith("imported-token")
  })
  it("migrates legacy credentials into configuration and removes the separate secret", async () => {
    await storage.setItem("local:notion-integration-token", "legacy-token")
    mocks.listDatabases.mockResolvedValue([])
    await handler("notionListDatabases")({ data: undefined })
    expect((await mocks.getConfig())?.notion?.apiKey).toBe("legacy-token")
    expect(await storage.getItem("local:notion-integration-token")).toBeNull()
  })
  it("discovers databases with the background credential and returns no token", async () => {
    expect(await handler("notionListDatabases")({ data: undefined })).toMatchObject({ ok: false })
    await storage.setItem("local:notion-integration-token", "background-secret")
    const databases = [
      { id: "database", name: "Library", dataSources: [{ id: "source", name: "Words" }] },
    ]
    mocks.listDatabases.mockResolvedValue(databases)
    expect(await handler("notionListDatabases")({ data: undefined })).toEqual({
      ok: true,
      value: databases,
    })
    expect(mocks.provider).toHaveBeenCalledWith("background-secret")
  })
  it("rejects credential changes from content scripts", async () => {
    await expect(
      handler("notionSetToken")({
        data: { token: "private" },
        sender: { url: "https://example.com/" },
      }),
    ).rejects.toThrow("extension settings")
    expect(await storage.getItem("local:notion-integration-token")).toBeNull()
  })
  it("stores credentials in Config without returning them in credential replies", async () => {
    const sender = { url: browser.runtime.getURL("/options.html") }
    expect(
      await handler("notionSetToken")({ data: { token: " private " }, sender }),
    ).toBeUndefined()
    expect((await mocks.getConfig())?.notion?.apiKey).toBe("private")
    expect(await storage.getItem("local:notion-integration-token")).toBeNull()
    await handler("notionSetToken")({ data: { token: "" }, sender })
    expect((await mocks.getConfig())?.notion?.apiKey).toBeUndefined()
    expect(await storage.getItem("local:notion-integration-token")).toBeNull()
  })
  it("fails without a local token and rejects arbitrary target URLs", async () => {
    expect(
      await handler("notionGetProperties")({
        data: { dataSourceId: "12345678-1234-1234-1234-123456789abc" },
      }),
    ).toMatchObject({ ok: false, error: expect.stringContaining("token") })
    expect(
      await handler("notionGetProperties")({ data: { dataSourceId: "https://example.com/" } }),
    ).toMatchObject({ ok: false })
    expect(mocks.provider).not.toHaveBeenCalled()
  })
  it("resolves built-in connections in the background and ignores caller-supplied credentials", async () => {
    const config = structuredClone(DEFAULT_CONFIG)
    const action = getBuiltInDictionaryAction(config.selectionToolbar)
    const connection = {
      provider: "notion" as const,
      dataSourceId: "12345678-1234-1234-1234-123456789abc",
      mappings: [
        {
          localFieldId: action.outputSchema[0]!.id,
          propertyId: "title",
          propertyType: "title" as const,
        },
      ],
    }
    config.selectionToolbar = replaceSelectionToolbarAction(config.selectionToolbar, {
      ...action,
      notionConnection: connection,
    })
    mocks.getConfig.mockResolvedValue(config)
    await storage.setItem("local:notion-integration-token", "background-secret")
    const records = [{ [action.outputSchema[0]!.name]: "frog" }]
    expect(
      await handler("notionSave")({
        data: { actionId: action.id, records, token: "caller-secret" },
      }),
    ).toMatchObject({ ok: true })
    expect(mocks.provider).toHaveBeenCalledWith("background-secret")
    expect(mocks.save).toHaveBeenCalledWith(connection, action.outputSchema, records)
  })
  it("rejects empty batches and missing connections", async () => {
    mocks.getConfig.mockResolvedValue(DEFAULT_CONFIG)
    expect(
      await handler("notionSave")({ data: { actionId: "default-dictionary", records: [] } }),
    ).toMatchObject({ ok: false })
    expect(
      await handler("notionSave")({
        data: { actionId: "default-dictionary", records: [{ Word: "frog" }] },
      }),
    ).toMatchObject({ ok: false, error: expect.stringContaining("connection") })
    expect(mocks.save).not.toHaveBeenCalled()
  })
})
