import assert from "node:assert/strict";
import test from "node:test";
import { modelPropertiesDataSchema } from "@zcode/shared/model-config";
import {
  createRegistryModelConfig,
  ModelConfig,
  ModelPropertiesConfig,
  serializeRegistryModelConfig,
} from "../src/index.js";

const completeModel = {
  enabled: true,
  properties: {
    requiresMfjsToolSchema: false,
    contextWindow: 1_048_576,
    inputFormat: {
      supportsText: true,
      supportsImage: true,
      supportsVideo: true,
      supportsAudio: false,
      supportsPdf: true,
    },
    outputFormat: { supportsText: true },
    supportsToolCall: true,
    supportsJsonSchemaOutput: true,
    supportsNativeWebSearch: false,
    supportsMidConversationSystem: true,
  },
  optionSpecs: {
    reasoningLevel: { values: ["low", "high", "max"], map: "{}" },
    maxOutputTokens: { max: 128_000, map: "{}" },
  },
} as const;

test("pdfInputMode accepts only native and rendered-pages", () => {
  assert.equal(modelPropertiesDataSchema.safeParse({ pdfInputMode: "native" }).success, true);
  assert.equal(
    modelPropertiesDataSchema.safeParse({ pdfInputMode: "rendered-pages" }).success,
    true,
  );
  assert.equal(modelPropertiesDataSchema.safeParse({ pdfInputMode: "other" }).success, false);
});

test("pdfInputMode overlay survives unrelated model settings and registry serialization", () => {
  const properties = new ModelPropertiesConfig({ pdfInputMode: "rendered-pages" }).overlay(
    new ModelPropertiesConfig({ contextWindow: 1_048_576 }),
  );
  assert.equal(properties.pdfInputMode, "rendered-pages");
  assert.equal(properties.toJSON().pdfInputMode, "rendered-pages");

  const config = ModelConfig.fromData({
    ...completeModel,
    properties: { ...completeModel.properties, pdfInputMode: "rendered-pages" },
  });
  const result = createRegistryModelConfig(config);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(
    serializeRegistryModelConfig(result.config).properties.pdfInputMode,
    "rendered-pages",
  );
});

test("existing complete models with no pdfInputMode remain valid as native", () => {
  const result = createRegistryModelConfig(ModelConfig.fromData(completeModel));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(serializeRegistryModelConfig(result.config).properties.pdfInputMode, "native");
});
