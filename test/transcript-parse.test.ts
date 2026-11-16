import { describe, expect, it } from "vitest";
import { usageFromLine } from "../src/transcript-parse.js";

const line = (o: unknown) => JSON.stringify(o);

describe("usageFromLine", () => {
  it("reads usage, model and id from an assistant line", () => {
    const u = usageFromLine(
      line({
        type: "assistant",
        message: {
          id: "msg_1",
          model: "claude-sonnet-5-5",
          usage: { input_tokens: 5, output_tokens: 7, cache_read_input_tokens: 9 },
        },
      }),
    );
    expect(u).toEqual({
      id: "msg_1",
      model: "claude-sonnet-5-5",
      usage: { input: 5, output: 7, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 9 },
    });
  });

  it("ignores non-assistant lines", () => {
    expect(usageFromLine(line({ type: "user", message: { usage: { output_tokens: 1 } } }))).toBe(
      undefined,
    );
  });

  it("falls back to the uuid when the message has no id", () => {
    const u = usageFromLine(
      line({ type: "assistant", uuid: "abc", message: { usage: { output_tokens: 1 } } }),
    );
    expect(u?.id).toBe("uuid:abc");
    expect(u?.model).toBe("unknown");
  });

  it("returns undefined for garbage", () => {
    for (const g of ["", "not json", '"usage" "assistant" {', "null", '{"usage":"assistant"}']) {
      expect(usageFromLine(g)).toBeUndefined();
    }
  });
});
