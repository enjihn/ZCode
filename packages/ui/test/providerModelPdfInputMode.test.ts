import assert from "node:assert/strict";
import test from "node:test";
import type { ProviderSettingsFormModel } from "../src/lib/providerSettingsFormTypes.js";
import { clearManualModelConfig, manualModelConfigSchema } from "@zcode/provider";
import {
  createProviderModelDraftValues,
  resolveProviderModelDraftCommit,
} from "../src/settings/model-provider-section/ProviderModelMetadata.js";

const baseConfig = {
  enabled: true,
  properties: {
    contextWindow: 1_048_576,
    inputFormat: {
      supportsText: true,
      supportsImage: true,
      supportsVideo: true,
      supportsAudio: false,
      supportsPdf: true,
    },
    supportsJsonSchemaOutput: true,
    supportsNativeWebSearch: false,
    supportsMidConversationSystem: true,
  },
  optionSpecs: {
    reasoningLevel: { values: ["low", "high", "max"], map: "{}" },
    maxOutputTokens: { max: 128_000, map: "{}" },
  },
} as const;

function localModel(): ProviderSettingsFormModel {
  return {
    kind: "candidate",
    modelId: "glm-5.3-flash",
    builtin: false,
    inheritedConfig: baseConfig,
    config: {
      ...baseConfig,
      properties: { ...baseConfig.properties, pdfInputMode: "rendered-pages" },
    },
    personalConfig: { properties: { pdfInputMode: "rendered-pages" } },
    useRecommendedConfig: true,
    hasPersonalConfig: true,
    executable: true,
    selectable: true,
  } as ProviderSettingsFormModel;
}

for (const recommended of [true, false]) {
  test(`model settings save preserves hidden PDF mode in ${recommended ? "recommended" : "fixed"} mode`, () => {
    const model = localModel();
    const draft = createProviderModelDraftValues(model);
    draft.useRecommendedConfigValue = recommended;
    if (!recommended) {
      draft.contextWindowValue = "1048576";
      draft.maxOutputTokensValue = "128000";
      draft.reasoningLevelMapValue = "{}";
    }
    const result = resolveProviderModelDraftCommit({ currentModel: model, draft });
    assert.equal(result.status, "commit");
    if (result.status !== "commit") return;
    assert.equal(result.model.config.properties?.pdfInputMode, "rendered-pages");
    assert.equal(result.model.personalConfig.properties?.pdfInputMode, "rendered-pages");
    if (!recommended) {
      assert.equal(manualModelConfigSchema.safeParse(result.model.personalConfig).success, true);
    }
  });
}

test("clearing fixed settings retains the hidden PDF mode", () => {
  const model = localModel();
  const cleared = clearManualModelConfig({
    ...model.config,
    properties: { ...model.config.properties, pdfInputMode: "rendered-pages" },
  });
  assert.equal(cleared.properties?.pdfInputMode, "rendered-pages");
});
