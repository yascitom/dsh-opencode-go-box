// Hand-written Typert host manifest for the opencodeUsage Remote.
// The typert-loader imports this via package.json exports["./typert"] and
// registers it into ctx.typert.local, which the Host gateway uses to claim
// and dispatch the opencodeUsage/* endpoints in strict mode.
import { z } from "zod";

const windowSchema = z.object({
  status: z.string().nullable(),
  percent: z.number().nullable(),
  resetsAt: z.string().nullable(),
});

const usageSchema = z.object({
  rolling: windowSchema.nullable(),
  weekly: windowSchema.nullable(),
  monthly: windowSchema.nullable(),
});

const thresholdsSchema = z.object({
  warn: z.number(),
  danger: z.number(),
});

const limitsSchema = z.object({
  rolling: z.string(),
  weekly: z.string(),
  monthly: z.string(),
});

const snapshotSchema = z.object({
  attemptAt: z.number(),
  httpStatus: z.number().nullable(),
  parseVersion: z.number(),
  error: z.string().nullable(),
  body: z.unknown().nullable(),
});

const credentialSchema = z.object({
  source: z.string().nullable(),
  keyHint: z.string().nullable(),
});

const usageResultSchema = z.object({
  configured: z.boolean(),
  reason: z.string().nullable(),
  error: z.string().nullable(),
  fetchedAt: z.number().nullable(),
  httpStatus: z.number().nullable(),
  parseVersion: z.number().nullable(),
  credential: credentialSchema.nullable(),
  snapshots: z.array(snapshotSchema),
  usage: usageSchema.nullable(),
  thresholds: thresholdsSchema.nullable(),
  limits: limitsSchema.nullable(),
});

const stepUsageSchema = z.object({
  turn: z.number(),
  step: z.number(),
  time: z.number().nullable(),
  model: z.string().nullable(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadTokens: z.number(),
  cacheWriteTokens: z.number(),
  reasoningTokens: z.number(),
});

const sessionTotalsSchema = z.object({
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadTokens: z.number(),
  cacheWriteTokens: z.number(),
  reasoningTokens: z.number(),
});

const sessionUsageSchema = z.object({
  sessionId: z.string(),
  title: z.string().nullable(),
  cwd: z.string().nullable(),
  agentPreset: z.string().nullable(),
  provider: z.string().nullable(),
  model: z.string().nullable(),
  createdAt: z.string(),
  messageCount: z.number(),
  totals: sessionTotalsSchema,
});

const dshUsageResultSchema = z.object({
  ok: z.boolean(),
  error: z.string().nullable(),
  message: z.string().nullable(),
  fetchedAt: z.number().nullable(),
  scanned: z.number(),
  totals: sessionTotalsSchema.nullable(),
  sessions: z.array(sessionUsageSchema),
});

const dshSessionMessagesResultSchema = z.object({
  ok: z.boolean(),
  error: z.string().nullable(),
  message: z.string().nullable(),
  sessionId: z.string().nullable(),
  model: z.string().nullable(),
  provider: z.string().nullable(),
  createdAt: z.string().nullable(),
  stepCount: z.number(),
  steps: z.array(stepUsageSchema),
});

export const TYPERT = {
  package: "dsh-opencode-go-usage",
  face: "host",
  schemas: [],
  invocations: [
    {
      id: "dsh-opencode-go-usage#opencodeUsage/usage",
      service: "opencodeUsage",
      namespace: "opencodeUsage",
      method: "usage",
      invocation: { kind: "direct" },
      parameters: [],
      result: {
        mode: "strict",
        typeSymbol: "dsh-opencode-go-usage#UsageResult",
        schema: usageResultSchema,
      },
    },
    {
      id: "dsh-opencode-go-usage#opencodeUsage/dshUsage",
      service: "opencodeUsage",
      namespace: "opencodeUsage",
      method: "dshUsage",
      invocation: { kind: "direct" },
      parameters: [],
      result: {
        mode: "strict",
        typeSymbol: "dsh-opencode-go-usage#DshUsageResult",
        schema: dshUsageResultSchema,
      },
    },
    {
      id: "dsh-opencode-go-usage#opencodeUsage/dshSessionMessages",
      service: "opencodeUsage",
      namespace: "opencodeUsage",
      method: "dshSessionMessages",
      invocation: { kind: "direct" },
      parameters: [
        {
          name: "sessionId",
          wire: "sessionId",
          source: "json",
          codec: {
            mode: "strict",
            typeSymbol: "dsh-opencode-go-usage#opencodeUsage/dshSessionMessages:sessionId",
            schema: z.string(),
          },
        },
      ],
      result: {
        mode: "strict",
        typeSymbol: "dsh-opencode-go-usage#DshSessionMessagesResult",
        schema: dshSessionMessagesResultSchema,
      },
    },
  ],
  model: { services: [], events: [], objects: [] },
};
