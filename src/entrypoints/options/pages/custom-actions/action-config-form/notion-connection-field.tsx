import type {
  NotionConnection,
  NoteStorageProperty,
  NotionDatabase,
} from "@/utils/note-storage/types"
import { useSelector } from "@tanstack/react-form"
import { useState } from "react"
import { Button } from "@/components/ui/base-ui/button"
import { Input } from "@/components/ui/base-ui/input"
import { sendMessage } from "@/utils/message"
import { notionConnectionSchema } from "@/utils/note-storage/types"
import { useActionEditor } from "./action-editor"

export function NotionConnectionField() {
  const { form, autosave } = useActionEditor().state
  const action = useSelector(form.store, (state) => state.values)
  const [token, setToken] = useState("")
  const [dataSourceId, setDataSourceId] = useState(action.notionConnection?.dataSourceId ?? "")
  const [databases, setDatabases] = useState<NotionDatabase[]>([])
  const [databaseId, setDatabaseId] = useState("")
  const [properties, setProperties] = useState<NoteStorageProperty[]>([])
  const [mappings, setMappings] = useState<NotionConnection["mappings"]>(
    action.notionConnection?.mappings ?? [],
  )
  const [message, setMessage] = useState("")
  const [busy, setBusy] = useState(false)

  const run = async (operation: () => Promise<void>) => {
    setBusy(true)
    setMessage("")
    try {
      await operation()
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Notion request failed.")
    } finally {
      setBusy(false)
    }
  }
  const setConnection = (value: NotionConnection | undefined) => {
    autosave.edit(() => form.setFieldValue("notionConnection", value), { immediate: true })
  }
  const discover = async () => {
    const reply = await sendMessage("notionListDatabases", undefined)
    if (!reply.ok) throw new Error(reply.error)
    setDatabases(reply.value)
    const selected = reply.value.find((database) =>
      database.dataSources.some((source) => source.id === dataSourceId),
    )
    setDatabaseId(selected?.id ?? "")
    if (!selected) {
      setDataSourceId("")
      setProperties([])
      setMappings([])
    }
    setMessage(
      reply.value.length
        ? "Select a database and data source."
        : "No accessible databases. Share a database with this integration, then refresh.",
    )
  }
  return (
    <section className="mt-6 space-y-3 rounded-lg border p-4" aria-label="Notion storage">
      <h3 className="font-semibold">Notion</h3>
      <p className="text-sm text-muted-foreground">
        Connect an internal integration to your database. Enabling Notion makes it this action’s
        save destination. Disconnect to use Notebase.
      </p>
      <label className="block space-y-1 text-sm">
        <span>Integration token (shared by all actions, stored locally)</span>
        <Input
          type="password"
          autoComplete="off"
          value={token}
          onChange={(event) => setToken(event.target.value)}
          placeholder="Enter a new token to replace the saved token"
          disabled={busy}
        />
      </label>
      <div className="flex gap-2">
        <Button
          type="button"
          variant="outline"
          disabled={busy || !token.trim()}
          onClick={() =>
            void run(async () => {
              await sendMessage("notionSetToken", { token })
              setToken("")
              setProperties([])
              setDatabases([])
              await discover()
            })
          }
        >
          Save token
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              await sendMessage("notionSetToken", { token: "" })
              setToken("")
              setDatabases([])
              setProperties([])
              setDatabaseId("")
              setMessage("Saved token removed. All Notion connections now need a token.")
            })
          }
        >
          Remove token
        </Button>
      </div>
      <Button type="button" variant="outline" disabled={busy} onClick={() => void run(discover)}>
        查找 / 刷新数据库
      </Button>
      <label className="block space-y-1 text-sm">
        <span>Database</span>
        <select
          aria-label="Notion database"
          className="w-full rounded border bg-background p-2"
          value={databaseId}
          disabled={busy}
          onChange={(event) => {
            const database = databases.find((item) => item.id === event.target.value)
            setDatabaseId(event.target.value)
            const next = database?.dataSources.length === 1 ? database.dataSources[0]!.id : ""
            if (next !== dataSourceId) {
              setDataSourceId(next)
              setMappings([])
              setProperties([])
            }
          }}
        >
          <option value="">选择 Database</option>
          {databases.map((database) => (
            <option key={database.id} value={database.id}>
              {database.name}
            </option>
          ))}
        </select>
      </label>
      <label className="block space-y-1 text-sm">
        <span>Data Source</span>
        <select
          aria-label="Notion data source"
          className="w-full rounded border bg-background p-2"
          value={dataSourceId}
          disabled={busy || !databaseId}
          onChange={(event) => {
            setDataSourceId(event.target.value)
            setProperties([])
            setMappings([])
          }}
        >
          <option value="">选择 Data Source</option>
          {databases
            .find((database) => database.id === databaseId)
            ?.dataSources.map((source) => (
              <option key={source.id} value={source.id}>
                {source.name} ({source.id.slice(-8)})
              </option>
            ))}
        </select>
      </label>
      <Button
        type="button"
        variant="outline"
        disabled={busy || !databaseId || !dataSourceId.trim()}
        onClick={() =>
          void run(async () => {
            const reply = await sendMessage("notionGetProperties", {
              dataSourceId: dataSourceId.trim(),
            })
            if (!reply.ok) throw new Error(reply.error)
            setProperties(
              reply.value.filter((property) =>
                ["title", "rich_text", "number"].includes(property.type),
              ),
            )
            setMessage("Schema loaded. Map a text field to the title property, then enable Notion.")
          })
        }
      >
        Load / refresh fields
      </Button>
      {properties.length > 0 &&
        action.outputSchema.map((field) => (
          <label key={field.id} className="flex items-center justify-between gap-3 text-sm">
            <span>
              {field.name} ({field.type})
            </span>
            <select
              className="rounded border bg-background p-2"
              aria-label={`Notion property for ${field.name}`}
              disabled={busy}
              value={
                mappings.find((mapping) => mapping.localFieldId === field.id)?.propertyId ?? ""
              }
              onChange={(event) => {
                const property = properties.find((candidate) => candidate.id === event.target.value)
                const remaining = mappings.filter((mapping) => mapping.localFieldId !== field.id)
                setMappings(
                  property
                    ? [
                        ...remaining,
                        {
                          localFieldId: field.id,
                          propertyId: property.id,
                          propertyType:
                            property.type as NotionConnection["mappings"][number]["propertyType"],
                        },
                      ]
                    : remaining,
                )
              }}
            >
              <option value="">Do not save</option>
              {properties
                .filter((property) =>
                  field.type === "number"
                    ? property.type === "number"
                    : field.type === "string" && property.type !== "number",
                )
                .map((property) => (
                  <option key={property.id} value={property.id}>
                    {property.name} ({property.type})
                  </option>
                ))}
            </select>
          </label>
        ))}
      <div className="flex gap-2">
        <Button
          type="button"
          disabled={busy || !properties.length}
          onClick={() => {
            const parsed = notionConnectionSchema.safeParse({
              provider: "notion",
              dataSourceId: dataSourceId.trim(),
              mappings,
            })
            if (
              !parsed.success ||
              !mappings.some((mapping) => mapping.propertyType === "title") ||
              new Set(mappings.map((mapping) => mapping.propertyId)).size !== mappings.length
            ) {
              setMessage("Use unique properties and map a text field to Title.")
              return
            }
            setConnection(parsed.data)
          }}
        >
          Enable Notion
        </Button>
        {action.notionConnection && (
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => setConnection(undefined)}
          >
            Disconnect Notion
          </Button>
        )}
      </div>
      <p role="status" className="text-sm">
        {message ||
          (action.notionConnection ? "Save destination: Notion" : "Save destination: Notebase")}
      </p>
    </section>
  )
}
