import { createReadToolDefinition, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const DISABLED_BY_DEFAULT = new Set(["read", "write"]);
const VIEW_IMAGE_PARAMETERS = Type.Object({
  path: Type.String({ description: "Path to the image to view (relative or absolute)" }),
});

export default function toolTweaks(pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    const readTool = createReadToolDefinition(ctx.cwd);

    pi.registerTool({
      name: "view_image",
      label: "View Image",
      description: "View an image file and send it to the model as an image attachment.",
      promptSnippet: "View an image file",
      promptGuidelines: ["Use view_image to inspect image files."],
      parameters: VIEW_IMAGE_PARAMETERS,
      execute(toolCallId, params, signal, onUpdate, toolContext) {
        return readTool.execute(toolCallId, params, signal, onUpdate, toolContext);
      },
    });

    const activeTools = pi
      .getActiveTools()
      .filter((toolName) => !DISABLED_BY_DEFAULT.has(toolName));

    pi.setActiveTools([...new Set([...activeTools, "view_image"])]);
  });
}
