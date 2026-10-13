import { test, expect } from "./test";
import { readSse } from "../src/lib/sse";

test("UTF-8 逐字节、CRLF 跨块、多行 data 与心跳正确解析", async () => {
  const source = new TextEncoder().encode(
    ': 心跳\r\nevent: run.snapshot\r\ndata: {\r\ndata: "正文": "星图中文🌌"\r\ndata: }\r\n\r\nevent: message.delta\ndata: 增量\n\nevent: run.completed\rdata: 最终\r\r',
  );
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const byte of source) controller.enqueue(new Uint8Array([byte]));
      controller.close();
    },
  });
  const events = [];
  for await (const event of readSse(stream)) events.push(event);
  expect(events).toEqual([
    { event: "run.snapshot", data: '{\n"正文": "星图中文🌌"\n}' },
    { event: "message.delta", data: "增量" },
    { event: "run.completed", data: "最终" },
  ]);
});

test("未结束的事件丢弃，损坏的 UTF-8 不冒充完成", async () => {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("event: run.completed\ndata: 未收到空行"));
      controller.close();
    },
  });
  const events = [];
  for await (const event of readSse(stream)) events.push(event);
  expect(events).toEqual([]);
  const broken = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([0xe4, 0xb8]));
      controller.close();
    },
  });
  await expect(async () => {
    for await (const event of readSse(broken)) events.push(event);
  }).rejects.toThrow();
});
