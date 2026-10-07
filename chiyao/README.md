# opencode · 吃药机分支

吃药机「工作」App 背后的 agent。在上游 opencode 上只加了三样东西，改动集中在新文件里，方便合并上游：

| 改动 | 位置 |
|---|---|
| 上下文钩子：每轮请求模型前回调吃药机，取角色设定、记忆、世界书，拼进消息 | `packages/opencode/src/chiyao/hook.ts`，入口在 `src/session/llm/request.ts` |
| `send_to_phone` 工具：把电脑上的文件交给吃药机，手机上预览或下载 | `packages/opencode/src/tool/send-to-phone.ts`，注册在 `src/tool/registry.ts` |
| 发布脚本 | `chiyao/release.sh` |

没有设置 `CHIYAO_HOOK_URL` / `CHIYAO_HOOK_TOKEN` 时，行为与上游完全一致。

## 合并上游

```sh
git fetch upstream
git checkout chiyao
git merge upstream/dev
cd packages/opencode && bun test test/chiyao && bun run typecheck
```

## 发布

```sh
bash chiyao/release.sh 1
```

把最后输出的「<标签> <sha256>」写进吃药机仓库的 `desktop/opencode.version`。
