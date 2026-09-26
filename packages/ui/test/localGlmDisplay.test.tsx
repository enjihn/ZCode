import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ZCODE_AGENT_PROVIDER } from "@zcode/shared";
import type { ModelSelectionView } from "@zcode/services";
import { buildRegistryModelSelectGroups } from "../src/lib/modelSelectionGroups.js";
import { ProviderModelReasoningLevelEditor } from "../src/settings/model-provider-section/ProviderModelReasoningLevelEditor.js";
import { formatProviderModelLabel } from "../src/v4/composer/modelTriggerDisplay.js";

test("Local GLM model selector displays the requested casing without changing its selection value", () => {
  const view = {
    providers: [
      {
        providerId: "local-personal",
        providerName: "Local",
        config: {
          api: { type: "openai-chat-completions" },
          access: { type: "api-key", apiKey: "test-only" },
        },
        models: [{ modelId: "glm-5.3-flash", config: { properties: {} } }],
      },
    ],
  } as unknown as ModelSelectionView;

  const [group] = buildRegistryModelSelectGroups(ZCODE_AGENT_PROVIDER, view);
  assert.equal(group?.label, "Local");
  assert.equal(group?.items[0]?.name, "GLM-5.3-Flash");
  assert.equal(group?.items[0]?.value, "custom:local-personal:glm-5.3-flash");
  assert.equal(
    formatProviderModelLabel("local-personal", "Local", "glm-5.3-flash"),
    "Local/GLM-5.3-Flash",
  );
});

test("reasoning settings display lowercase effort values as Low, High, and Max", () => {
  const html = renderToStaticMarkup(
    createElement(ProviderModelReasoningLevelEditor, {
      values: ["low", "high", "max"],
      overridden: false,
      addLabel: "Add",
      deleteLabel: "Delete",
      onChange: () => undefined,
    }),
  );
  assert.match(html, />Low<\/button>/);
  assert.match(html, />High<\/button>/);
  assert.match(html, />Max<\/button>/);
  assert.doesNotMatch(html, />low<\/button>|>high<\/button>|>max<\/button>/);
});
