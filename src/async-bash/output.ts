import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@earendil-works/pi-coding-agent";
import { Effect, FileSystem, Option } from "effect";

const NEWLINE = 0x0a;
const MAX_UTF8_SEQUENCE_BYTES = 4;
const isContinuation = (byte: number) => (byte & 0xc0) === 0x80;

export type Page = {
  output: string;
  output_start_bytes: number;
  cursor_bytes: number;
  total_bytes: number;
};

/** Length of the UTF-8 sequence that `byte` leads; 1 for every byte that leads none. */
function sequenceLength(byte: number) {
  if (byte >= 0xc2 && byte <= 0xdf) return 2;
  if (byte >= 0xe0 && byte <= 0xef) return 3;
  if (byte >= 0xf0 && byte <= 0xf4) return 4;
  return 1;
}

/**
 * Index of the lead byte of the UTF-8 sequence that reaches `data[index]`. Output need not be
 * UTF-8: a byte that no sequence reaches stands for itself.
 */
function characterStart(data: Uint8Array, index: number): number {
  for (let start = index; start >= 0 && index - start < MAX_UTF8_SEQUENCE_BYTES; start--) {
    const byte = data[start]!;
    if (isContinuation(byte)) continue;
    return sequenceLength(byte) > index - start ? start : index;
  }
  return index;
}

/** Bytes at the end of `data` that begin a character whose remaining bytes are not written yet. */
function partialCharacterBytes(data: Uint8Array): number {
  if (data.length === 0) return 0;
  const start = characterStart(data, data.length - 1);
  const written = data.length - start;
  return sequenceLength(data[start]!) > written ? written : 0;
}

/**
 * A command's combined stdout and stderr: a file that the command's own descriptors append to and
 * that Pi only reads. Everything a command wrote before it exited is in the log in the order it
 * was written, and processes the command left running keep appending.
 *
 * Offsets count the log's bytes. While the command runs, a character still being written at the
 * end of the log is left out of the length until it is whole, so pages hold whole characters.
 */
export class Output {
  constructor(
    private readonly fs: FileSystem.FileSystem,
    readonly path: string,
    private readonly commandExited: () => boolean,
  ) {}

  /** Opens the log and measures it: its length, and when it last grew, in epoch milliseconds. */
  private open() {
    return Effect.gen({ self: this }, function* () {
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

      const info = yield* file.stat;
      const size = Number(info.size);
      const tailLength = Math.min(size, MAX_UTF8_SEQUENCE_BYTES - 1);
      const tail = yield* read(size - tailLength, tailLength);
      return {
        read,
        totalBytes: this.commandExited() ? size : size - partialCharacterBytes(tail),
        modifiedAt: Option.getOrElse(info.mtime, () => new Date()).getTime(),
      };
    });
  }

  status() {
    return Effect.scoped(
      this.open().pipe(Effect.map(({ totalBytes, modifiedAt }) => ({ totalBytes, modifiedAt }))),
    );
  }

  /** Fails unless `cursor` is a byte offset within the log. */
  checkCursor(cursor: number) {
    return this.status().pipe(
      Effect.flatMap(({ totalBytes }) => {
        if (Number.isSafeInteger(cursor) && cursor >= 0 && cursor <= totalBytes) return Effect.void;
        return Effect.fail(
          new Error(`cursor_bytes must be an integer between 0 and ${totalBytes}`),
        );
      }),
    );
  }

  /**
   * Reads at most one display page of the logged bytes at or after `cursor`, which must be within
   * the log. `from: "cursor"` pages forward from the cursor; `from: "end"` returns the latest
   * bytes. A cursor inside a character moves back to its first byte. Bytes that are not UTF-8
   * show as replacement characters.
   */
  page(cursor: number, from: "cursor" | "end") {
    return Effect.scoped(
      Effect.gen({ self: this }, function* () {
        const { read, totalBytes: total } = yield* this.open();
        cursor = Math.min(cursor, total);

        if (cursor < total) {
          const before = Math.max(0, cursor - (MAX_UTF8_SEQUENCE_BYTES - 1));
          const head = yield* read(before, cursor - before + 1);
          cursor = before + characterStart(head, head.length - 1);
        }

        const pageOf = (maxBytes: number) =>
          Effect.gen(function* () {
            let start = from === "end" ? Math.max(cursor, total - maxBytes) : cursor;
            const length =
              from === "end"
                ? total - start
                : Math.min(total - start, maxBytes + MAX_UTF8_SEQUENCE_BYTES);
            let data = yield* read(start, length);
            if (from === "end") {
              let skip = 0;
              // A page that starts after the cursor was cut out of the log, possibly inside a
              // character.
              const cut = start > cursor;
              while (cut && skip < MAX_UTF8_SEQUENCE_BYTES - 1 && isContinuation(data[skip] ?? 0)) {
                skip++;
              }
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
              let end = Math.min(maxBytes, data.length);
              if (end < data.length) end = characterStart(data, end);
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
          });

        const page = yield* pageOf(DEFAULT_MAX_BYTES);
        if (Buffer.byteLength(page.output) <= DEFAULT_MAX_BYTES) return page;
        // A replacement character takes three bytes, so a third of the bytes always fits.
        return yield* pageOf(Math.floor(DEFAULT_MAX_BYTES / 3));
      }),
    );
  }
}
