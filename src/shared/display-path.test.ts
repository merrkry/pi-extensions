import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

import { formatHomePath } from "./display-path.js";

describe("shared display paths", () => {
  it("shortens the home directory and its descendants", () => {
    const home = homedir();
    expect(formatHomePath(home)).toBe("~");
    expect(formatHomePath(join(home, "project", "src"))).toBe(join("~", "project", "src"));
  });

  it("does not confuse a sibling sharing the home prefix for a descendant", () => {
    const home = homedir();
    const sibling = join(dirname(home), `${home.slice(dirname(home).length + 1)}-other`);
    expect(formatHomePath(sibling)).toBe(sibling);
  });
});
