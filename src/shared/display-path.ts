import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";

/** Replace a path inside the current user's home directory with a `~`-prefixed display path. */
export function formatHomePath(path: string): string {
  const home = homedir();
  if (!home) return path;
  const resolvedPath = resolve(path);
  const resolvedHome = resolve(home);
  const relativeToHome = relative(resolvedHome, resolvedPath);
  const isInsideHome =
    relativeToHome === "" ||
    (relativeToHome !== ".." &&
      !relativeToHome.startsWith(`..${sep}`) &&
      !isAbsolute(relativeToHome));
  if (!isInsideHome) return path;
  return relativeToHome === "" ? "~" : `~${sep}${relativeToHome}`;
}
