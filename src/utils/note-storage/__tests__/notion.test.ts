import type { NotionConnection } from "../types"
import { afterEach, describe, expect, it, vi } from "vitest"
import { buildNotionProperties, createNotionProvider, isNotionPageUrl } from "../providers/notion"

const connection: NotionConnection = {
  provider: "notion",
  dataSourceId: "12345678-1234-1234-1234-123456789abc",
  mappings: [
    { localFieldId: "word", propertyId: "title", propertyType: "title" },
    { localFieldId: "definition", propertyId: "desc", propertyType: "rich_text" },
    { localFieldId: "frequency", propertyId: "num", propertyType: "number" },
  ],
}
const fields = [
  { id: "word", name: "Word", type: "string" },
  { id: "definition", name: "Definition", type: "string" },
  { id: "frequency", name: "Frequency", type: "number" },
]
const schema = [
  { id: "title", name: "Renamed title", type: "title" },
  { id: "desc", name: "Definition", type: "rich_text" },
  { id: "num", name: "Frequency", type: "number" },
]
const record = { Word: "frog", Definition: "an amphibian", Frequency: 0 }
const schemaResponse = () =>
  Response.json({
    properties: Object.fromEntries(schema.map((property) => [property.name, property])),
  })
const pageResponse = () => Response.json({ url: "https://www.notion.so/page" })

afterEach(() => vi.useRealTimers())

describe("Notion field mapping", () => {
  it("uses stable property IDs and current output names after renaming", () => {
    const renamed = fields.map((field) =>
      field.id === "word" ? { ...field, name: "Term" } : field,
    )
    expect(buildNotionProperties(connection, renamed, schema, { ...record, Term: "new" })).toEqual({
      title: { title: [{ type: "text", text: { content: "new" } }] },
      desc: { rich_text: [{ type: "text", text: { content: "an amphibian" } }] },
      num: { number: 0 },
    })
  })
  it("splits long Unicode text without breaking surrogate pairs", () => {
    const properties = buildNotionProperties(connection, fields, schema, {
      ...record,
      Definition: "🐸".repeat(2001),
    })
    expect(properties.desc).toEqual({
      rich_text: [
        { type: "text", text: { content: "🐸".repeat(2000) } },
        { type: "text", text: { content: "🐸" } },
      ],
    })
  })
  it.each([
    { ...record, Word: " " },
    { ...record, Frequency: NaN },
    { ...record, Frequency: "3" },
    { ...record, Definition: "x".repeat(200001) },
  ])("rejects invalid output before writing", (invalid) => {
    expect(() => buildNotionProperties(connection, fields, schema, invalid)).toThrow(
      /Notion|numeric/,
    )
  })
  it("rejects removed fields, changed types, duplicate properties and missing title", () => {
    expect(() => buildNotionProperties(connection, fields.slice(1), schema, record)).toThrow(
      "fields changed",
    )
    expect(() =>
      buildNotionProperties(
        connection,
        fields,
        schema.map((property) => ({ ...property, type: "number" })),
        record,
      ),
    ).toThrow("fields changed")
    expect(() =>
      buildNotionProperties(
        { ...connection, mappings: [connection.mappings[0]!, connection.mappings[0]!] },
        fields,
        schema,
        record,
      ),
    ).toThrow("only once")
    expect(() =>
      buildNotionProperties(
        { ...connection, mappings: connection.mappings.slice(1) },
        fields,
        schema,
        record,
      ),
    ).toThrow("title")
  })
})

describe("Notion API provider", () => {
  it("loads current schema and writes pages under a data source", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(schemaResponse())
      .mockResolvedValueOnce(pageResponse())
    expect(
      await createNotionProvider("test-token", request).save(connection, fields, [record]),
    ).toEqual({ urls: ["https://www.notion.so/page"] })
    const [url, options] = request.mock.calls[1]!
    expect(url).toBe("https://api.notion.com/v1/pages")
    expect(options?.headers).toMatchObject({
      "Notion-Version": "2026-03-11",
      Authorization: "Bearer test-token",
    })
    expect(JSON.parse(options?.body as string).parent).toEqual({
      type: "data_source_id",
      data_source_id: connection.dataSourceId,
    })
  })
  it("validates the entire batch before any writes", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(schemaResponse())
    await expect(
      createNotionProvider("test-token", request).save(connection, fields, [
        record,
        { ...record, Word: "" },
      ]),
    ).rejects.toThrow("title")
    expect(request).toHaveBeenCalledTimes(1)
  })
  it("honors Retry-After on 429", async () => {
    vi.useFakeTimers()
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 429, headers: { "Retry-After": "2" } }))
      .mockResolvedValueOnce(schemaResponse())
    const result = createNotionProvider("test-token", request).getProperties(
      connection.dataSourceId,
    )
    await vi.advanceTimersByTimeAsync(1999)
    expect(request).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(await result).toEqual(schema)
  })
  it("does not retry an uncertain page creation and reports confirmed progress", async () => {
    vi.useFakeTimers()
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(schemaResponse())
      .mockResolvedValueOnce(pageResponse())
      .mockRejectedValueOnce(new Error("private token and data"))
    const result = createNotionProvider("test-token", request).save(connection, fields, [
      record,
      record,
    ])
    // Attach a rejection handler before advancing fake timers.
    const settled = result.catch((error) => error)
    await vi.runAllTimersAsync()
    expect(await settled).toMatchObject({
      savedCount: 1,
      message: expect.stringContaining("1 of 2 saved"),
    })
    expect(request).toHaveBeenCalledTimes(3)
  })
  it("does not retry server errors or expose raw error bodies", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(schemaResponse())
      .mockResolvedValueOnce(Response.json({ message: "sensitive content" }, { status: 500 }))
    await expect(
      createNotionProvider("test-token", request).save(connection, fields, [record]),
    ).rejects.toThrow("Notion request failed (500)")
    expect(request).toHaveBeenCalledTimes(2)
  })
})

describe("Notion page URLs", () => {
  it.each([
    "https://app.notion.com/p/page",
    "https://www.notion.so/page",
    "https://notion.so/page",
    "https://www.notion.com/page",
    "https://notion.com/page",
  ])("accepts official URL %s", (url) => {
    expect(isNotionPageUrl(url)).toBe(true)
  })
  it.each([
    "http://app.notion.com/p/page",
    "https://www.notion.so.evil.example/page",
    "https://evil.example/",
    "https://user@app.notion.com/p/page",
    "https://app.notion.com:8080/p/page",
    "invalid",
    null,
  ])("rejects unsafe URL %s", (url) => {
    expect(isNotionPageUrl(url)).toBe(false)
  })
  it("accepts the current API page URL after creating a page", async () => {
    const url = "https://app.notion.com/p/page"
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(schemaResponse())
      .mockResolvedValueOnce(Response.json({ url }))
    expect(
      await createNotionProvider("test-token", request).save(connection, fields, [record]),
    ).toEqual({ urls: [url] })
  })
})
