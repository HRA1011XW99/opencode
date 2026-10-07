import { describe, expect, test, afterEach } from "bun:test"
import type { ModelMessage } from "ai"
import { ChiyaoHook } from "../../src/chiyao/hook"

const sys = (c: string): ModelMessage => ({ role: "system", content: c })
const user = (c: string): ModelMessage => ({ role: "user", content: c })
const asst = (c: string): ModelMessage => ({ role: "assistant", content: c })

describe("chiyao hook merge", () => {
  test("leading system head goes after opencode system, rest follows", () => {
    const out = ChiyaoHook.merge([sys("oc"), user("hi")], {
      head: [
        { role: "system", content: "char" },
        { role: "system", content: "memory" },
        { role: "assistant", content: "ok" },
        { role: "system", content: "late" },
      ],
      depth: [],
    })
    expect(out.map((m) => m.role)).toEqual(["system", "system", "system", "assistant", "user", "user"])
    expect(out[1].content).toBe("char")
    expect(out[4].content).toBe("<system-note>\nlate\n</system-note>")
    expect(out[5].content).toBe("hi")
  })

  test("depth counts back from the end and becomes a note", () => {
    const out = ChiyaoHook.merge([sys("oc"), user("a"), asst("b"), user("c")], {
      head: [],
      depth: [{ depth: 1, role: "system", content: "wb" }],
    })
    expect(out.map((m) => m.content)).toEqual(["oc", "a", "b", "<system-note>\nwb\n</system-note>", "c"])
  })

  test("depth larger than history stops after head", () => {
    const out = ChiyaoHook.merge([sys("oc"), user("a")], {
      head: [{ role: "system", content: "char" }],
      depth: [{ depth: 99, role: "user", content: "wb" }],
    })
    expect(out.map((m) => m.content)).toEqual(["oc", "char", "wb", "a"])
  })

  test("never splits a tool call from its result", () => {
    const call: ModelMessage = {
      role: "assistant",
      content: [{ type: "tool-call", toolCallId: "1", toolName: "read", input: {} }],
    }
    const result: ModelMessage = {
      role: "tool",
      content: [{ type: "tool-result", toolCallId: "1", toolName: "read", output: { type: "text", value: "x" } }],
    }
    const out = ChiyaoHook.merge([sys("oc"), user("a"), call, result, asst("done")], {
      head: [],
      depth: [{ depth: 2, role: "user", content: "wb" }],
    })
    expect(out.map((m) => m.role)).toEqual(["system", "user", "assistant", "tool", "user", "assistant"])
  })

  test("same position: deeper first, then original order", () => {
    const out = ChiyaoHook.merge([user("a")], {
      head: [],
      depth: [
        { depth: 5, role: "user", content: "x" },
        { depth: 9, role: "user", content: "y" },
        { depth: 5, role: "user", content: "z" },
      ],
    })
    expect(out.map((m) => m.content)).toEqual(["y", "x", "z", "a"])
  })

  test("recent keeps text only, oldest first", () => {
    const msgs: ModelMessage[] = [
      user("one"),
      { role: "assistant", content: [{ type: "text", text: "two" }, { type: "reasoning", text: "hidden" }] },
      { role: "tool", content: [] },
      user("three"),
    ]
    expect(ChiyaoHook.recent(msgs, 2)).toEqual([
      { role: "assistant", text: "two" },
      { role: "user", text: "three" },
    ])
  })
})

describe("chiyao hook inject", () => {
  const saved = { url: process.env.CHIYAO_HOOK_URL, token: process.env.CHIYAO_HOOK_TOKEN }
  afterEach(() => {
    process.env.CHIYAO_HOOK_URL = saved.url
    process.env.CHIYAO_HOOK_TOKEN = saved.token
    if (saved.url === undefined) delete process.env.CHIYAO_HOOK_URL
    if (saved.token === undefined) delete process.env.CHIYAO_HOOK_TOKEN
  })

  test("no env: untouched", async () => {
    delete process.env.CHIYAO_HOOK_URL
    const msgs = [user("a")]
    expect(await ChiyaoHook.inject({ sessionID: "s", userMessageID: "u0", messages: msgs })).toBe(msgs)
  })

  test("calls hook once per user message with token, falls back on failure", async () => {
    let calls = 0
    let token = ""
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        calls++
        token = req.headers.get("x-chiyao-token") ?? ""
        const body = (await req.json()) as any
        if (body.sessionID === "bad") return new Response("{}", { status: 500 })
        return Response.json({ head: [{ role: "system", content: "char" }], depth: [] })
      },
    })
    process.env.CHIYAO_HOOK_URL = `http://127.0.0.1:${server.port}/api/work/hook`
    process.env.CHIYAO_HOOK_TOKEN = "t0k"
    try {
      const a = await ChiyaoHook.inject({ sessionID: "s", userMessageID: "u1", messages: [sys("oc"), user("a")] })
      const b = await ChiyaoHook.inject({ sessionID: "s", userMessageID: "u1", messages: [sys("oc"), user("a")] })
      expect(a.map((m) => m.content)).toEqual(["oc", "char", "a"])
      expect(b.map((m) => m.content)).toEqual(["oc", "char", "a"])
      expect(calls).toBe(1)
      expect(token).toBe("t0k")
      const msgs = [user("x")]
      expect(await ChiyaoHook.inject({ sessionID: "bad", userMessageID: "u2", messages: msgs })).toBe(msgs)
    } finally {
      server.stop(true)
    }
  })
})
