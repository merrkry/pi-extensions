import { createReadToolDefinition, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { transformActiveTools } from "./policy.js";

const VIEW_IMAGE_PARAMETERS = Type.Object({
  path: Type.String({ description: "Path to the image to view (relative or absolute)" }),
});

export default function installToolTweaks(pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx) => {
    const initiallyActive = pi.getActiveTools();
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

    // Registering an extension tool can activate it during extension binding. Always
    // restore an explicit transformed set so agents without a shell tool retain exactly
    // their original tools, while agents with bash or exec_command use it in place of
    // redundant file tools.
    pi.setActiveTools(transformActiveTools(initiallyActive));
  });
}
