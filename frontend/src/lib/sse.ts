export type SseEvent = { event: string; data: string };

// Incremental UTF-8 and line decoding: neither bytes nor SSE lines align with chunks.
export async function* readSse(
  stream: ReadableStream<Uint8Array>,
  onChunk?: () => void,
): AsyncGenerator<SseEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "",
    event = "",
    data: string[] = [],
    frameSize = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (!chunk.done) onChunk?.();
      buffer += chunk.done ? decoder.decode() : decoder.decode(chunk.value, { stream: true });
      if (buffer.length + frameSize > 8 * 1024 * 1024)
        throw new Error("流式事件过大，请重新读取运行状态。");
      while (true) {
        const index = buffer.search(/[\r\n]/);
        if (index < 0 || (!chunk.done && buffer[index] === "\r" && index === buffer.length - 1))
          break;
        const line = buffer.slice(0, index);
        const length = buffer[index] === "\r" && buffer[index + 1] === "\n" ? 2 : 1;
        buffer = buffer.slice(index + length);
        if (!line) {
          if (data.length) yield { event: event || "message", data: data.join("\n") };
          event = "";
          data = [];
          frameSize = 0;
          continue;
        }
        if (line.startsWith(":")) continue;
        const colon = line.indexOf(":");
        const field = colon < 0 ? line : line.slice(0, colon);
        let value = colon < 0 ? "" : line.slice(colon + 1);
        if (value.startsWith(" ")) value = value.slice(1);
        if (field === "event") event = value;
        else if (field === "data") {
          data.push(value);
          frameSize += value.length;
        }
      }
      // An unfinished event at EOF is a disconnect, never a fabricated terminal event.
      if (chunk.done) break;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
