export interface CollectedOutput {
  readonly bytes: Uint8Array;
  readonly totalBytes: number;
  readonly omittedBytes: number;
}

export interface TailSnapshot extends CollectedOutput {
  readonly startOffset: number;
  readonly endOffset: number;
}

/**
 * A fixed-allocation byte ring retaining only the newest bytes.
 *
 * Absolute offsets make reads non-destructive: callers can snapshot from a
 * committed offset and advance that offset only after a poll succeeds.
 */
export class TailByteRing {
  readonly maxBytes: number;
  private readonly storage: Uint8Array;
  private writeIndex = 0;
  private retainedBytesInternal = 0;
  private totalBytesInternal = 0;

  constructor(maxBytes: number) {
    if (!Number.isFinite(maxBytes) || maxBytes < 0) {
      throw new Error(`maxBytes must be a non-negative finite number (got ${maxBytes})`);
    }
    this.maxBytes = Math.floor(maxBytes);
    this.storage = new Uint8Array(this.maxBytes);
  }

  get retainedBytes(): number {
    return this.retainedBytesInternal;
  }

  get totalBytes(): number {
    return this.totalBytesInternal;
  }

  append(chunk: Uint8Array): void {
    if (chunk.length === 0) return;
    this.totalBytesInternal += chunk.length;
    if (this.maxBytes === 0) return;

    const source =
      chunk.length > this.maxBytes ? chunk.subarray(chunk.length - this.maxBytes) : chunk;
    const firstLength = Math.min(source.length, this.maxBytes - this.writeIndex);
    this.storage.set(source.subarray(0, firstLength), this.writeIndex);
    const remaining = source.length - firstLength;
    if (remaining > 0) this.storage.set(source.subarray(firstLength), 0);
    this.writeIndex = (this.writeIndex + source.length) % this.maxBytes;
    this.retainedBytesInternal = Math.min(this.maxBytes, this.retainedBytesInternal + chunk.length);
  }

  snapshotFrom(requestedOffset: number): TailSnapshot {
    const endOffset = this.totalBytesInternal;
    const normalizedOffset = Math.min(endOffset, Math.max(0, Math.floor(requestedOffset)));
    const retainedStart = endOffset - this.retainedBytesInternal;
    const startOffset = Math.max(normalizedOffset, retainedStart);
    const omittedBytes = startOffset - normalizedOffset;
    const length = endOffset - startOffset;
    const bytes = new Uint8Array(length);

    if (length > 0 && this.maxBytes > 0) {
      const oldestIndex =
        (this.writeIndex - this.retainedBytesInternal + this.maxBytes) % this.maxBytes;
      const offsetInRetained = startOffset - retainedStart;
      const readIndex = (oldestIndex + offsetInRetained) % this.maxBytes;
      const firstLength = Math.min(length, this.maxBytes - readIndex);
      bytes.set(this.storage.subarray(readIndex, readIndex + firstLength), 0);
      if (firstLength < length) {
        bytes.set(this.storage.subarray(0, length - firstLength), firstLength);
      }
    }

    return {
      bytes,
      startOffset,
      endOffset,
      totalBytes: endOffset - normalizedOffset,
      omittedBytes,
    };
  }

  snapshotTail(): Uint8Array {
    return this.snapshotFrom(this.totalBytesInternal - this.retainedBytesInternal).bytes;
  }
}
