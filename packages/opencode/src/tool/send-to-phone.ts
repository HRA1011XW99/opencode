// Chiyao: hand a file on this computer to the phone. Only registered when the
// Chiyao hook is configured (see src/chiyao/hook.ts).
import { Effect, Schema } from "effect"
import * as path from "path"
import * as Tool from "./tool"
import { FSUtil } from "@opencode-ai/core/fs-util"
import DESCRIPTION from "./send-to-phone.txt"
import { InstanceState } from "@/effect/instance-state"
import { assertExternalDirectoryEffect } from "./external-directory"
import { ChiyaoHook } from "@/chiyao/hook"

export const Parameters = Schema.Struct({
  filePath: Schema.String.annotate({ description: "The absolute path to the file to send" }),
  note: Schema.optional(Schema.String).annotate({ description: "One-line description shown with the file" }),
})

type Metadata = { name?: string; size?: number; fileID?: string }

export const SendToPhoneTool = Tool.define<typeof Parameters, Metadata, never>(
  "send_to_phone",
  Effect.succeed({
    description: DESCRIPTION,
    parameters: Parameters,
    execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
      Effect.gen(function* () {
        const instance = yield* InstanceState.context
        let filepath = params.filePath
        if (!path.isAbsolute(filepath)) filepath = path.resolve(instance.directory, filepath)
        if (process.platform === "win32") filepath = FSUtil.normalizePath(filepath)

        yield* assertExternalDirectoryEffect(ctx, filepath, { kind: "file" })
        yield* ctx.ask({
          permission: "read",
          patterns: [path.relative(instance.worktree, filepath)],
          always: ["*"],
          metadata: {},
        })

        const res = yield* Effect.tryPromise({
          try: () =>
            ChiyaoHook.call(
              "file",
              { sessionID: ctx.sessionID, path: filepath, note: params.note ?? "" },
              120_000,
            ) as Promise<{ name: string; size: number; id: string }>,
          catch: (e) => new Error(e instanceof Error ? e.message : String(e)),
        })
        return {
          title: res.name,
          output: `Sent ${res.name} (${res.size} bytes) to the phone.`,
          metadata: { name: res.name, size: res.size, fileID: res.id },
        }
      }).pipe(Effect.orDie),
  }),
)
