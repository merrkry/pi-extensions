import { describe, expect, it } from "vitest";

import { transformActiveTools } from "./index.js";

describe("transformActiveTools", () => {
  it("replaces shell-redundant tools and adds image viewing when bash is active", () => {
    expect(transformActiveTools(["read", "bash", "edit", "write", "grep", "find", "ls"])).toEqual([
      "bash",
      "edit",
      "view_image",
    ]);
  });

  it("reduces the built-in Explore and Plan tool set to bash and image viewing", () => {
    expect(transformActiveTools(["read", "bash", "grep", "find", "ls"])).toEqual([
      "bash",
      "view_image",
    ]);
  });

  it("preserves restricted tools exactly when bash is unavailable", () => {
    expect(transformActiveTools(["read", "grep", "find", "ls"])).toEqual([
      "read",
      "grep",
      "find",
      "ls",
    ]);
  });

  it("does not grant a tool to an agent with no active tools", () => {
    expect(transformActiveTools([])).toEqual([]);
  });

  it("deduplicates the resulting active set", () => {
    expect(transformActiveTools(["bash", "view_image", "view_image"])).toEqual([
      "bash",
      "view_image",
    ]);
  });
});
