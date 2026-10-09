import { createStore } from "jotai"
import { expect, it } from "vitest"
import { storage } from "#imports"
import { configSchema } from "@/types/config/config"
import { writeConfigAtom } from "@/utils/atoms/config"
import { getObjectWithoutAPIKeys } from "@/utils/config/api"
import { migrateConfig } from "@/utils/config/migration"
import { CONFIG_SCHEMA_VERSION, DEFAULT_CONFIG } from "@/utils/constants/config"
import { getBuiltInDictionaryAction } from "@/utils/custom-actions"

it("round-trips Notion credentials and action connections through the standard config importer", async () => {
  const config = structuredClone(DEFAULT_CONFIG)
  config.notion = { apiKey: "integration-secret" }
  const connection = {
    provider: "notion" as const,
    dataSourceId: "12345678-1234-1234-1234-123456789abc",
    mappings: [
      {
        localFieldId: getBuiltInDictionaryAction(config.selectionToolbar).outputSchema[0]!.id,
        propertyId: "title",
        propertyType: "title" as const,
      },
    ],
  }
  config.selectionToolbar.builtInActions.dictionary.notionConnection = connection
  const exported = JSON.parse(JSON.stringify({ config, schemaVersion: CONFIG_SCHEMA_VERSION }))
  const imported = await migrateConfig(exported.config, exported.schemaVersion)
  expect(imported.notion?.apiKey).toBe("integration-secret")
  expect(imported.selectionToolbar.builtInActions.dictionary.notionConnection).toEqual(connection)
  const withoutSecrets = configSchema.parse(getObjectWithoutAPIKeys(config))
  expect(withoutSecrets.notion?.apiKey).toBeUndefined()
  expect(withoutSecrets.selectionToolbar.builtInActions.dictionary.notionConnection).toEqual(
    connection,
  )
  expect(config.notion.apiKey).toBe("integration-secret")
})
it("still accepts upstream configuration without Notion fields", () => {
  expect(configSchema.parse(DEFAULT_CONFIG).notion).toBeUndefined()
})

it("persists and removes credentials through the shared configuration writer", async () => {
  await storage.setItem("local:config", structuredClone(DEFAULT_CONFIG))
  const store = createStore()
  await store.set(writeConfigAtom, () => ({ notion: { apiKey: "test-token" } }))
  expect(configSchema.parse(await storage.getItem("local:config")).notion?.apiKey).toBe(
    "test-token",
  )
  await store.set(writeConfigAtom, () => ({ notion: { apiKey: undefined } }))
  expect(configSchema.parse(await storage.getItem("local:config")).notion?.apiKey).toBeUndefined()
})
