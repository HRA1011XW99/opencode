// Chiyao context hook.
//
// When opencode runs inside Chiyao (the phone app), CHIYAO_HOOK_URL and
// CHIYAO_HOOK_TOKEN are set. Before each model request of a top-level session,
// we ask Chiyao for the role context (character, user persona, memory,
// worldbook) and splice it into the message list. Nothing here is persisted
// into opencode's message store: the context is fetched again for every user
// turn, so edits on the phone take effect on the next turn and compaction
// never folds the role context into a summary.
//
// Without the env vars every function here is a no-op.
import type { ModelMessage } from "ai"

export type HeadItem = { role: "system" | "user" | "assistant"; content: string }
export type DepthItem = { depth: number; role: "system" | "user" | "assistant"; content: string }
export type Context = { head: HeadItem[]; depth: DepthItem[]; recentWanted?: number }

const TIMEOUT = 5000
const DEFAULT_RECENT = 6

export function enabled() {
  return !!process.env.CHIYAO_HOOK_URL && !!process.env.CHIYAO_HOOK_TOKEN
}

export async function call(path: string, body: unknown, timeout = TIMEOUT) {
  const res = await fetch(process.env.CHIYAO_HOOK_URL!.replace(/\/+$/, "") + "/" + path, {
    method: "POST",
    headers: { "content-type": "application/json", "x-chiyao-token": process.env.CHIYAO_HOOK_TOKEN! },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  })
  const text = await res.text()
  let data: any = {}
  try {
    data = text ? JSON.parse(text) : {}
  } catch {
    data = { error: text }
  }
  if (!res.ok) throw new Error(data?.error || `chiyao hook ${path} failed: ${res.status}`)
  return data
}

function textOf(content: ModelMessage["content"]): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .map((p: any) => (p && p.type === "text" && typeof p.text === "string" ? p.text : ""))
    .filter(Boolean)
    .join("\n")
}

/** Plain text of the last `n` user/assistant turns, oldest first. Tool calls and reasoning are dropped. */
export function recent(messages: ModelMessage[], n: number) {
  const out: { role: "user" | "assistant"; text: string }[] = []
  for (let i = messages.length - 1; i >= 0 && out.length < n; i--) {
    const m = messages[i]
    if (m.role !== "user" && m.role !== "assistant") continue
    const text = textOf(m.content).trim()
    if (text) out.push({ role: m.role, text })
  }
  return out.reverse()
}

const note = (content: string): ModelMessage => ({ role: "user", content: `<system-note>\n${content}\n</system-note>` })

/**
 * Splice the context into `messages`.
 *
 * - Leading system items of `head` go right after opencode's own system messages.
 * - The rest of `head` follows them; a system item there becomes a user `<system-note>`,
 *   because several providers reject system messages after the first user/assistant one.
 * - `depth` items are inserted counting back from the end of the list, the same rule as
 *   Chiyao's "at depth" worldbook entries. An insertion point never lands in front of a
 *   tool result, so a tool call stays next to its result.
 */
export function merge(messages: ModelMessage[], ctx: Context): ModelMessage[] {
  const out = [...messages]
  let sys = 0
  while (sys < out.length && out[sys].role === "system") sys++

  const head = (ctx.head || []).filter((h) => h && typeof h.content === "string" && h.content.trim())
  let lead = 0
  while (lead < head.length && head[lead].role === "system") lead++
  const inserted: ModelMessage[] = [
    ...head.slice(0, lead).map((h): ModelMessage => ({ role: "system", content: h.content })),
    ...head.slice(lead).map((h): ModelMessage => (h.role === "system" ? note(h.content) : ({ role: h.role, content: h.content } as ModelMessage))),
  ]
  out.splice(sys, 0, ...inserted)
  const floor = sys + inserted.length

  const len = out.length
  const deep = (ctx.depth || [])
    .filter((d) => d && typeof d.content === "string" && d.content.trim())
    .map((d, i) => {
      let at = Math.max(floor, len - Math.max(0, Number(d.depth) || 0))
      while (at < len && out[at].role === "tool") at++
      return { ...d, at, i }
    })
    .sort((a, b) => a.at - b.at || b.depth - a.depth || a.i - b.i)
  for (let i = deep.length - 1; i >= 0; i--) {
    const d = deep[i]
    out.splice(d.at, 0, d.role === "system" ? note(d.content) : ({ role: d.role, content: d.content } as ModelMessage))
  }
  return out
}

/* One context per user message: every step of a turn sees the same prefix, which keeps
   prompt caching useful and avoids a round trip per tool call. */
const cache = new Map<string, Context>()
let wanted = DEFAULT_RECENT

export async function inject(input: {
  sessionID: string
  userMessageID: string
  messages: ModelMessage[]
}): Promise<ModelMessage[]> {
  if (!enabled()) return input.messages
  let ctx = cache.get(input.userMessageID)
  if (!ctx) {
    try {
      ctx = (await call("context", {
        sessionID: input.sessionID,
        recent: recent(input.messages, wanted),
      })) as Context
    } catch (e) {
      console.error("[chiyao] context hook failed:", e instanceof Error ? e.message : e)
      return input.messages
    }
    if (typeof ctx.recentWanted === "number" && ctx.recentWanted > 0) wanted = Math.min(50, ctx.recentWanted)
    cache.set(input.userMessageID, ctx)
    if (cache.size > 200) cache.delete(cache.keys().next().value!)
  }
  return merge(input.messages, ctx)
}

export * as ChiyaoHook from "./hook"
