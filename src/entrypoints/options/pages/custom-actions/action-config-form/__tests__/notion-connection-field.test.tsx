// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, expect, it, vi } from "vitest"
import { NotionConnectionField } from "../notion-connection-field"

const mocks = vi.hoisted(() => ({
  send: vi.fn<(...args: any[]) => Promise<any>>(),
  setFieldValue: vi.fn<(...args: any[]) => void>(),
  values: { outputSchema: [{ id: "word", name: "Word", type: "string" }] },
}))
vi.mock("@tanstack/react-form", () => ({
  useSelector: (_store: unknown, selector: (state: unknown) => unknown) =>
    selector({ values: mocks.values }),
}))
vi.mock("@/utils/message", () => ({ sendMessage: mocks.send }))
vi.mock("../action-editor", () => ({
  useActionEditor: () => ({
    state: {
      form: { store: {}, setFieldValue: mocks.setFieldValue },
      autosave: { edit: (operation: () => void) => operation() },
    },
  }),
}))
const sources = ["12345678-1234-1234-1234-123456789abc", "12345678-1234-1234-1234-123456789def"]
beforeEach(() => {
  vi.clearAllMocks()
  mocks.send.mockImplementation(async (name: string) => {
    if (name === "notionSetToken") return undefined
    if (name === "notionListDatabases")
      return {
        ok: true,
        value: [
          {
            id: "database",
            name: "Library",
            dataSources: sources.map((id, index) => ({ id, name: `Source ${index}` })),
          },
        ],
      }
    return { ok: true, value: [{ id: "title", name: "Title", type: "title" }] }
  })
})
it("discovers after saving a token, selects sibling data sources and clears old mappings", async () => {
  render(<NotionConnectionField />)
  expect(screen.queryByText("Data Source ID")).not.toBeInTheDocument()
  fireEvent.change(screen.getByPlaceholderText("Enter a new token to replace the saved token"), {
    target: { value: "secret" },
  })
  fireEvent.click(screen.getByRole("button", { name: "Save token" }))
  await waitFor(() => expect(screen.getByRole("option", { name: "Library" })).toBeInTheDocument())
  fireEvent.change(screen.getByLabelText("Notion database"), { target: { value: "database" } })
  fireEvent.change(screen.getByLabelText("Notion data source"), { target: { value: sources[0] } })
  fireEvent.click(screen.getByRole("button", { name: "Load / refresh fields" }))
  await waitFor(() => expect(screen.getByLabelText("Notion property for Word")).toBeInTheDocument())
  fireEvent.change(screen.getByLabelText("Notion property for Word"), {
    target: { value: "title" },
  })
  fireEvent.click(screen.getByRole("button", { name: "Enable Notion" }))
  expect(mocks.setFieldValue).toHaveBeenCalledWith(
    "notionConnection",
    expect.objectContaining({
      dataSourceId: sources[0],
      mappings: [{ localFieldId: "word", propertyId: "title", propertyType: "title" }],
    }),
  )
  fireEvent.change(screen.getByLabelText("Notion data source"), { target: { value: sources[1] } })
  expect(screen.queryByLabelText("Notion property for Word")).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole("button", { name: "Load / refresh fields" }))
  await waitFor(() => expect(screen.getByLabelText("Notion property for Word")).toHaveValue(""))
  expect(mocks.send).toHaveBeenLastCalledWith("notionGetProperties", { dataSourceId: sources[1] })
})
