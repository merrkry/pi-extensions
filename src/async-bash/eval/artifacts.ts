import { constants } from "node:fs";
import { open, readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";

const openDirectory = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY;
const MAX_ARTIFACT_BYTES = 32 * 1024 * 1024;

function relativeParts(root: string, path: string): string[] {
  const parts = relative(root, path).split(sep);
  if (parts.includes("..")) throw new Error(`Path leaves the attempt directory: ${path}`);
  return parts.filter(Boolean);
}

// Node has no openat. An open directory descriptor anchors each lookup while O_NOFOLLOW
// rejects a symlink even if the agent replaces that path between two calls.
async function withDirectory<A>(
  directory: string,
  parts: string[],
  use: (directoryFdPath: string) => Promise<A>,
): Promise<A> {
  const handle = await open(directory, openDirectory);
  try {
    const anchor = `/proc/self/fd/${handle.fd}`;
    const [next, ...rest] = parts;
    return next === undefined
      ? await use(anchor)
      : await withDirectory(join(anchor, next), rest, use);
  } finally {
    await handle.close();
  }
}

export async function readAttemptFile(root: string, path: string): Promise<string> {
  const parts = relativeParts(root, path);
  const name = parts.pop();
  if (!name) throw new Error(`Expected an artifact file: ${path}`);
  return withDirectory(root, parts, async (anchor) => {
    const file = await open(
      join(anchor, name),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const info = await file.stat();
      if (!info.isFile()) throw new Error(`Artifact is not a regular file: ${path}`);
      if (info.size > MAX_ARTIFACT_BYTES) throw new Error(`Artifact exceeds 32 MiB: ${path}`);
      const buffer = Buffer.alloc(info.size);
      let offset = 0;
      while (offset < buffer.length) {
        const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset);
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      return buffer.toString("utf8", 0, offset);
    } finally {
      await file.close();
    }
  });
}

export async function onlyTranscript(root: string, directory: string): Promise<string> {
  const files: string[] = [];
  const scan = (parts: string[]): Promise<void> =>
    withDirectory(root, parts, async (anchor) => {
      for (const entry of await readdir(anchor, { withFileTypes: true })) {
        const child = [...parts, entry.name];
        if (entry.isDirectory()) await scan(child);
        else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(join(root, ...child));
      }
    });
  await scan(relativeParts(root, directory));
  if (files.length !== 1) {
    throw new Error(`Expected one session in ${directory}, found ${files.length}`);
  }
  return files[0]!;
}
