import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@earendil-works/pi-coding-agent";
import { Effect, FileSystem, Scope } from "effect";

const NEWLINE = 0x0a;
// A page may end inside a character; read enough to finish the longest UTF-8 sequence.
const MAX_UTF8_SEQUENCE_BYTES = 4;
const isContinuation = (byte: number) => (byte & 0xc0) === 0x80;

export type Page = {
  output: string;
  output_start_bytes: number;
  cursor_bytes: number;
  total_bytes: number;
};

/**
 * Combined stdout and stderr, decoded to UTF-8 and logged in capture order.
 *
 * Every command logs to a file, with no in-memory stage for short output: a single storage path
 * keeps one page reader and one cursor rule, and the file costs about 0.1 ms against several
 * milliseconds to spawn the shell. The log has no size cap, like the full-output file of Pi's
 * own bash.
 */
export class Output {
  // Each channel starts its own decoder, so a byte order mark is output like any other character.
  private readonly decoders = {
    stdout: new TextDecoder("utf-8", { ignoreBOM: true }),
    stderr: new TextDecoder("utf-8", { ignoreBOM: true }),
  };
  private bytes = 0;

  private constructor(
    private readonly fs: FileSystem.FileSystem,
    readonly path: string,
    private readonly file: FileSystem.File,
  ) {}

  static make(fs: FileSystem.FileSystem, path: string, scope: Scope.Scope) {
    return fs.open(path, { flag: "wx", mode: 0o600 }).pipe(
      Scope.provide(scope),
      Effect.map((file) => new Output(fs, path, file)),
    );
  }

  get totalBytes() {
    return this.bytes;
  }

  append(data: Uint8Array, channel: "stdout" | "stderr") {
    return Effect.suspend(() =>
      this.appendText(this.decoders[channel].decode(data, { stream: true })),
    );
  }

  finish() {
    return Effect.gen({ self: this }, function* () {
      for (const decoder of Object.values(this.decoders)) yield* this.appendText(decoder.decode());
    });
  }

  private appendText(text: string) {
    return Effect.gen({ self: this }, function* () {
      if (!text) return;
      const data = Buffer.from(text);
      yield* this.file.writeAll(data);
      // Count bytes only once written, so readers never see a range beyond the log.
      this.bytes += data.length;
    });
  }

  /** Fails unless `cursor` is a byte offset within the log. */
  checkCursor(cursor: number) {
    return Effect.suspend(() =>
      Number.isSafeInteger(cursor) && cursor >= 0 && cursor <= this.bytes
        ? Effect.void
        : Effect.fail(new Error(`cursor_bytes must be an integer between 0 and ${this.bytes}`)),
    );
  }

  /**
   * Reads at most one display page of the logged bytes at or after `cursor`.
   * `from: "cursor"` pages forward from the cursor; `from: "end"` returns the latest bytes.
   * A cursor inside a character moves back to its first byte, since the log holds only whole characters.
   */
  page(cursor: number, from: "cursor" | "end") {
    return Effect.scoped(
      Effect.gen({ self: this }, function* () {
        const total = this.bytes;
        yield* this.checkCursor(cursor);
        const file = yield* this.fs.open(this.path, { flag: "r" });
        const read = (start: number, length: number) =>
          Effect.gen(function* () {
            const buffer = Buffer.alloc(length);
            yield* file.seek(BigInt(start), "start");
            let filled = 0;
            while (filled < length) {
              const count = yield* file.read(buffer.subarray(filled));
              if (count === 0) break;
              filled += count;
            }
            return buffer.subarray(0, filled);
          });

        if (cursor < total) {
          const before = Math.max(0, cursor - (MAX_UTF8_SEQUENCE_BYTES - 1));
          const head = yield* read(before, cursor - before + 1);
          let index = head.length - 1;
          while (index > 0 && isContinuation(head[index]!)) index--;
          cursor = before + index;
        }

        let start = from === "end" ? Math.max(cursor, total - DEFAULT_MAX_BYTES) : cursor;
        const length =
          from === "end"
            ? total - start
            : Math.min(total - start, DEFAULT_MAX_BYTES + MAX_UTF8_SEQUENCE_BYTES);
        let data = yield* read(start, length);
        if (from === "end") {
          let skip = 0;
          while (skip < data.length && isContinuation(data[skip]!)) skip++;
          // Keep the last DEFAULT_MAX_LINES lines; a final newline does not start another line.
          let lines = 0;
          for (let index = data.length - 2; index >= skip; index--) {
            if (data[index] === NEWLINE && ++lines === DEFAULT_MAX_LINES) {
              skip = index + 1;
              break;
            }
          }
          data = data.subarray(skip);
          start += skip;
        } else {
          let end = Math.min(DEFAULT_MAX_BYTES, data.length);
          while (end < data.length && isContinuation(data[end]!)) end--;
          for (let index = 0, lines = 0; index < end; index++) {
            if (data[index] === NEWLINE && ++lines === DEFAULT_MAX_LINES) {
              end = index + 1;
              break;
            }
          }
          data = data.subarray(0, end);
        }
        return {
          output: data.toString("utf8"),
          output_start_bytes: start,
          cursor_bytes: start + data.length,
          total_bytes: total,
        } satisfies Page;
      }),
    );
  }
}
