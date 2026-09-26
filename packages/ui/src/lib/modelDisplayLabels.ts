/** Presentation only: provider requests and saved selections keep the original IDs. */
export function modelIdDisplayLabel(modelId: string): string {
  return modelId === "glm-5.3-flash" ? "GLM-5.3-Flash" : modelId;
}

export function reasoningEffortDisplayLabel(value: string): string {
  switch (value) {
    case "low":
      return "Low";
    case "high":
      return "High";
    case "max":
      return "Max";
    default:
      return value;
  }
}
