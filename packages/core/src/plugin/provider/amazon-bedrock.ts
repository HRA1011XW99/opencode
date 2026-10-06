import { Effect } from "effect"
import path from "node:path"
import { define } from "@opencode/plugin/effect/plugin"
import { FSUtil } from "@opencode/util/fs-util"
import { Global } from "@opencode/util/global"
import { Credential } from "../../credential.js"
import { Integration } from "../../integration.js"
import { Provider } from "../../provider.js"

// Ambient inputs the AWS default credential chain can turn into credentials
// without any key stored in opencode. Mirrors the presence checks the AWS CLI
// and SDK use before consulting shared config.
const CHAIN_ENV = [
  "AWS_PROFILE",
  "AWS_ACCESS_KEY_ID",
  "AWS_WEB_IDENTITY_TOKEN_FILE",
  "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
  "AWS_CONTAINER_CREDENTIALS_FULL_URI",
]

const isBedrock = (item: { readonly package: string }) =>
  item.package.startsWith("@opencode/ai/providers/amazon-bedrock")

export const AmazonBedrockPlugin = define({
  id: "opencode.provider.amazon.bedrock",
  effect: Effect.fn(function* (ctx) {
    const fs = yield* FSUtil.Service
    const paths = [
      process.env.AWS_CONFIG_FILE ?? path.join(Global.Path.home, ".aws", "config"),
      process.env.AWS_SHARED_CREDENTIALS_FILE ?? path.join(Global.Path.home, ".aws", "credentials"),
    ]
    const files = yield* Effect.all(
      paths.map((file) => fs.readFileStringSafe(file).pipe(Effect.orElseSucceed(() => undefined))),
    )
    // Discover names only. Resolving every profile here could run credential helpers or contact AWS.
    const profiles = Array.from(
      new Set(
        files.flatMap((content, index) =>
          Array.from((content ?? "").matchAll(/^\s*\[([^\]\r\n]+)\]/gm)).flatMap((match) => {
            const section = match[1].trim()
            if (index === 1) return [section]
            if (section === "default") return [section]
            return section.startsWith("profile ") ? [section.slice(8).trim()] : []
          }),
        ),
      ),
    )
      .filter(Boolean)
      .toSorted()
    const sources = paths
      .filter((_, index) => profiles.length === 0 || files[index] !== undefined)
      .map((file) =>
        file.startsWith(Global.Path.home + path.sep) ? `~${file.slice(Global.Path.home.length)}` : file,
      )
      .join(" and ")
    yield* ctx.integration.transform((editor) => {
      // models.dev advertises AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, and
      // AWS_REGION alongside the bearer token. Only the bearer token is a key;
      // the rest feed the SigV4 credential chain and must not become one.
      editor.method.update({
        integrationID: Provider.ID.amazonBedrock,
        method: { type: "env", names: ["AWS_BEARER_TOKEN_BEDROCK"] },
      })
      editor.method.update({
        integrationID: Provider.ID.amazonBedrock,
        method: { type: "key", label: "Bedrock API key", order: -3 },
      })
      editor.method.update({
        integrationID: Provider.ID.amazonBedrock,
        method: {
          id: "aws-credentials",
          type: "form",
          label: "AWS profile (SSO or named profile)",
          order: -2,
          form: [
            {
              key: "profile",
              type: "string",
              title: "AWS profile",
              description: profiles.length
                ? `Found ${profiles.length} profile${profiles.length === 1 ? "" : "s"} in ${sources} on the server.`
                : `No AWS profiles found in ${sources} on the server.`,
              required: true,
              minLength: 1,
              pattern: "\\S",
              placeholder: "Profile name",
              custom: true,
              options: profiles.map((profile) => ({ value: profile, label: profile })),
            },
          ],
        },
        connect: (answer) =>
          Effect.succeed(
            Credential.External.make({
              type: "external",
              methodID: Integration.MethodID.make("aws-credentials"),
              metadata: { auth: "sigv4", profile: String(answer.profile).trim() },
            }),
          ),
      })
      editor.method.update({
        integrationID: Provider.ID.amazonBedrock,
        method: {
          id: "aws-access-keys",
          type: "form",
          label: "AWS access key + secret",
          order: -1,
          form: [
            { key: "accessKeyId", type: "string", title: "Access key ID", required: true },
            { key: "secretAccessKey", type: "string", format: "password", title: "Secret access key", required: true },
            {
              key: "sessionToken",
              type: "string",
              format: "password",
              title: "Session token (optional)",
              description:
                "Required for temporary credentials. These pasted credentials cannot renew themselves when they expire.",
            },
          ],
        },
        connect: (answer) =>
          Effect.succeed(
            Credential.Key.make({
              type: "key",
              key: String(answer.secretAccessKey).trim(),
              configuration: {
                auth: "sigv4",
                accessKeyId: String(answer.accessKeyId).trim(),
                ...(answer.sessionToken ? { sessionToken: String(answer.sessionToken).trim() } : {}),
              },
            }),
          ),
      })
    })
    yield* ctx.provider.transform((evt) => {
      for (const item of evt.list()) {
        if (!isBedrock(item.provider)) continue
        evt.update(item.provider.id, (provider) => {
          const settings = provider.settings ?? {}
          const chain = typeof settings.profile === "string" || CHAIN_ENV.some((name) => process.env[name])
          // SigV4 authenticates through the AWS default chain rather than a key
          // credential, so ambient AWS configuration is what makes Bedrock usable.
          if (chain && provider.activation === "auto") provider.activation = "enabled"
          // Same default the native package uses, made explicit here so catalog
          // `${AWS_REGION}` URLs resolve without any region configured.
          const region = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? "us-east-1"
          provider.settings = {
            ...settings,
            ...(typeof settings.region !== "string" ? { region } : {}),
            // Users configure Bedrock private/VPC endpoints as `endpoint`; move it
            // into the catalog base URL once.
            ...(typeof settings.baseURL !== "string" && typeof settings.endpoint === "string"
              ? { baseURL: settings.endpoint }
              : {}),
          }
          delete provider.settings.endpoint
        })
      }
    })
  }),
})
