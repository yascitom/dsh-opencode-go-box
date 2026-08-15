// Host half of the dsh-opencode-go-usage plugin.
// Publishes the "opencodeUsage" Cordis service (a Typert Remote) with three
// methods callable from the browser over the /api RPC carrier:
//   usage()                 — the official quota windows (5h / weekly / monthly),
//                             plus fetch freshness (fetchedAt / httpStatus), the
//                             parse version, credential provenance, and a bounded
//                             ring of raw request snapshots for diagnostics
//   dshUsage()              — per-session token usage from DeepSeek Harness
//                             session persistence (sessions on opencode-go)
//   dshSessionMessages(id)  — per-step (per model call) usage of one session
// Strict-mode dispatch is driven by typert.host.js, so no @Remote decorator
// is required here.
import z from "@deepseek-ai/schemastery";
import { TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { settingsNamespace } from "@deepseek-ai/dsh-settings";
import { homedir } from "node:os";
import { join } from "node:path";
import { readFile } from "node:fs/promises";

const DEFAULT_BASE_URL = "https://opencode.ai/zen/go/v1/usage";
const DEFAULT_TIMEOUT_MS = 15000;
const PROVIDER_ID = "opencode-go";
const DEFAULT_CREDENTIAL_REF = "OPENCODE_GO_API_KEY";
const DEFAULT_WARN_PERCENT = 60;
const DEFAULT_DANGER_PERCENT = 85;
const MAX_SESSIONS = 30;
const MAX_STEPS_PER_SESSION = 400;
const READ_CONCURRENCY = 4;
// Version of the usage-response parsing logic. Bump whenever pickWindow or
// the response-shape handling changes, so diagnostics can tell "our parser
// changed" apart from "the endpoint changed".
const PARSE_VERSION = 1;
// How many raw fetch-attempt snapshots to keep in memory for diagnostics.
const SNAPSHOT_LIMIT = 3;
// Serialized bytes after which a snapshot body is truncated to a preview.
const SNAPSHOT_BODY_MAX = 4000;

export const Config = z.object({
  baseUrl: z.string().default(DEFAULT_BASE_URL),
  timeoutMs: z.number().default(DEFAULT_TIMEOUT_MS),
  warnPercent: z.number().default(DEFAULT_WARN_PERCENT),
  dangerPercent: z.number().default(DEFAULT_DANGER_PERCENT),
  maxSessions: z.number().default(MAX_SESSIONS),
});

function asString(value) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Discover the credential reference (environment-variable name) that the
 * opencode-go provider profile declares as its apiKeyEnv, so a renamed
 * credential keeps working without a plugin change. Falls back to the
 * conventional OPENCODE_GO_API_KEY.
 */
async function resolveCredentialRefName(ctx) {
  try {
    const llm = ctx.get("llm");
    if (llm && typeof llm.listConfigurableProviders === "function") {
      const entries = llm.listConfigurableProviders() ?? [];
      for (const entry of entries) {
        if (!entry || entry.provider !== PROVIDER_ID) continue;
        if (typeof entry.settingsNs !== "string") continue;
        const section = ctx.settings.get(settingsNamespace(entry.settingsNs));
        let profile = section;
        if (Array.isArray(entry.settingsPath)) {
          for (const part of entry.settingsPath) {
            if (!profile || typeof profile !== "object" || Array.isArray(profile)) {
              profile = undefined;
              break;
            }
            profile = profile[part];
          }
        }
        if (
          profile
          && typeof profile === "object"
          && typeof profile.apiKeyEnv === "string"
          && profile.apiKeyEnv.length > 0
        ) {
          return profile.apiKeyEnv;
        }
      }
    }
  } catch {
    /* fall through */
  }
  return DEFAULT_CREDENTIAL_REF;
}

/**
 * Resolve the OpenCode Go API key together with its provenance, most-trusted
 * first:
 *   1. The credential reference the opencode-go provider profile declares
 *      (covers $DSH_HOME/.credentials.yaml and the process environment)
 *   2. The conventional DSH credentials / env reference OPENCODE_GO_API_KEY
 *   3. OpenCode's own auth.json: opencode-go (fallback opencode) type=api key
 * Returns `{ key, source }` or undefined; `source` names the store the key
 * came from so the diagnostics view can show it (masked) to the user and
 * multi-key mix-ups can be spotted.
 */
async function resolveApiKey(ctx) {
  try {
    const refName = await resolveCredentialRefName(ctx);
    const cred = await ctx.credentials.resolve(credentialRef(refName));
    if (cred && cred.value) return { key: String(cred.value), source: "provider:" + refName };
  } catch {
    /* fall through */
  }
  try {
    const cred = await ctx.credentials.resolve(credentialRef(DEFAULT_CREDENTIAL_REF));
    if (cred && cred.value) return { key: String(cred.value), source: "credential:" + DEFAULT_CREDENTIAL_REF };
  } catch {
    /* fall through */
  }
  try {
    const authPath = join(homedir(), ".local", "share", "opencode", "auth.json");
    const raw = JSON.parse(await readFile(authPath, "utf8"));
    for (const name of ["opencode-go", "opencode"]) {
      const entry = raw[name];
      if (entry && entry.type === "api" && typeof entry.key === "string" && entry.key.length > 0) {
        return { key: entry.key, source: "auth:" + name };
      }
    }
  } catch {
    /* fall through */
  }
  return undefined;
}

/** Mask a credential for display: first 4 chars + ellipsis + last 4. */
function maskKey(key) {
  if (typeof key !== "string" || key.length === 0) return null;
  if (key.length <= 8) return "***";
  return key.slice(0, 4) + "…" + key.slice(-4);
}

/**
 * Shrink a parsed response body for the in-memory snapshot ring. Bodies are
 * tiny in practice; when one exceeds SNAPSHOT_BODY_MAX serialized bytes, a
 * truncated preview is kept instead so diagnostics stay bounded.
 */
function snapshotBody(body) {
  if (body === undefined || body === null) return null;
  try {
    const text = JSON.stringify(body);
    if (text.length <= SNAPSHOT_BODY_MAX) return body;
    return { truncated: true, preview: text.slice(0, SNAPSHOT_BODY_MAX) };
  } catch {
    return null;
  }
}

/** Best-effort JSON read of a response body; null when it is not JSON. */
async function tryJson(res) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

function pickWindow(w) {
  if (!w || typeof w !== "object") return null;
  const percent = typeof w.percent === "number" ? w.percent : Number(w.percent);
  return {
    status: typeof w.status === "string" ? w.status : null,
    percent: Number.isFinite(percent) ? percent : null,
    resetsAt: typeof w.resetsAt === "string" ? w.resetsAt : null,
  };
}

/**
 * Session-level usage fold from one raw DSH session log.
 *
 * Session events wrap their payload in `data` (`{ type, seq, time, data }`),
 * so every read below goes through `event.data`.
 *
 * Provider attribution is PER STEP: each assistant/message carries the
 * provenance of the model call that produced it (`message.source.provider`),
 * so a session that switched providers mid-way still accounts every step to
 * the provider that actually served it. Steps whose provenance is missing
 * (older or imported logs) fall back to the latest request header seen so
 * far. Only opencode-go steps are kept in the returned totals/steps; a
 * session matches when at least one step is attributed to opencode-go, or
 * when no usage was recorded at all but the latest header route is
 * opencode-go (model selected, nothing billed yet).
 *
 * `steps` keeps the LATEST MAX_STEPS_PER_SESSION calls (a sliding tail), so
 * the detail view shows the most recent activity of long sessions; totals
 * and messageCount always cover every matched step. The latest
 * `session/title` event is folded locally from the same events, sparing a
 * second corpus read per session. `reasoningTokens` is reported as recorded:
 * the pi-ai adapter behind opencode-go folds reasoning into outputTokens, so
 * it is normally absent (shown as "—" by the client); adapters that do
 * report a reasoning breakdown flow through unchanged.
 */
function foldSessionLog(sessionId, createdAt, events) {
  let headerProvider = null;
  let headerModel = null;
  let matchedModel = null;
  let sawAnyUsage = false;
  let messageCount = 0;
  let title = null;
  const totals = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
  };
  const steps = [];
  for (const event of events) {
    if (event === null || typeof event !== "object") continue;
    const data = event.data;
    if (data === null || typeof data !== "object") continue;
    if (event.type === "session/title") {
      const text = asString(data.title);
      if (text !== undefined) title = text;
      continue;
    }
    if (event.type === "request/header") {
      const config = data.header && typeof data.header === "object" ? data.header.config : undefined;
      if (config && typeof config === "object") {
        const p = asString(config.provider);
        if (p !== undefined) headerProvider = p;
        const m = asString(config.model);
        if (m !== undefined) headerModel = m;
      }
      continue;
    }
    if (event.type !== "assistant/message") continue;
    const usage = data.usage;
    if (usage === undefined || usage === null || typeof usage !== "object") continue;
    sawAnyUsage = true;
    const message = data.message && typeof data.message === "object" ? data.message : undefined;
    const source = message && message.source && typeof message.source === "object" ? message.source : undefined;
    const stepProvider = asString(source && source.provider) ?? headerProvider;
    const stepModel = asString(source && source.model) ?? headerModel;
    if (stepProvider !== PROVIDER_ID) continue;
    const step = {
      turn: typeof data.turn === "number" ? data.turn : 0,
      step: typeof data.step === "number" ? data.step : 0,
      time: typeof event.time === "number" && Number.isFinite(event.time) && event.time > 0 ? event.time : null,
      model: stepModel,
      inputTokens: Number(usage.inputTokens) || 0,
      outputTokens: Number(usage.outputTokens) || 0,
      cacheReadTokens: Number(usage.cacheReadTokens) || 0,
      cacheWriteTokens: Number(usage.cacheWriteTokens) || 0,
      reasoningTokens: Number(usage.reasoningTokens) || 0,
    };
    messageCount += 1;
    if (stepModel !== null) matchedModel = stepModel;
    totals.inputTokens += step.inputTokens;
    totals.outputTokens += step.outputTokens;
    totals.cacheReadTokens += step.cacheReadTokens;
    totals.cacheWriteTokens += step.cacheWriteTokens;
    totals.reasoningTokens += step.reasoningTokens;
    steps.push(step);
    if (steps.length > MAX_STEPS_PER_SESSION) steps.shift();
  }
  const matched = messageCount > 0 || (!sawAnyUsage && headerProvider === PROVIDER_ID);
  return {
    sessionId: String(sessionId),
    provider: matched ? PROVIDER_ID : null,
    model: matchedModel ?? (matched ? headerModel : null),
    createdAt: new Date(typeof createdAt === "number" && createdAt > 0 ? createdAt : Date.now()).toISOString(),
    messageCount,
    title,
    totals,
    steps,
  };
}

/** Run `fn` over `items` with a bounded worker pool; failures yield null. */
async function mapPool(items, size, fn) {
  const out = new Array(items.length).fill(null);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next;
      next += 1;
      try {
        out[index] = await fn(items[index]);
      } catch {
        out[index] = null;
      }
    }
  }
  const workers = [];
  for (let i = 0; i < Math.min(size, items.length); i += 1) workers.push(worker());
  await Promise.all(workers);
  return out;
}

export class OpencodeUsageGateway extends TypertRemoteService {
  static inject = ["credentials", "settings", "sessionQuery"];
  static Config = Config;

  constructor(ctx, config) {
    super(ctx, "opencodeUsage");
    this.config = config ?? {};
    this.snapshots = [];
  }

  /** Push one fetch-attempt snapshot into the bounded in-memory ring. */
  recordSnapshot(snapshot) {
    if (!Array.isArray(this.snapshots)) this.snapshots = [];
    this.snapshots.push(snapshot);
    if (this.snapshots.length > SNAPSHOT_LIMIT) this.snapshots = this.snapshots.slice(-SNAPSHOT_LIMIT);
  }

  async usage() {
    const baseUrl = this.config.baseUrl || DEFAULT_BASE_URL;
    const timeoutMs = this.config.timeoutMs || DEFAULT_TIMEOUT_MS;
    const warn = typeof this.config.warnPercent === "number" ? this.config.warnPercent : DEFAULT_WARN_PERCENT;
    const danger = typeof this.config.dangerPercent === "number" ? this.config.dangerPercent : DEFAULT_DANGER_PERCENT;

    // Precondition: opencode-go must be present in Settings -> Models
    // (the llm-pi-ai provider namespace keyed by the route id "opencode-go").
    let configured = false;
    try {
      const pi = this.ctx.settings.get(settingsNamespace("llm-pi-ai"));
      configured = !!(pi && pi.providers && pi.providers["opencode-go"]);
    } catch {
      configured = false;
    }
    if (!configured) {
      return {
        configured: false, reason: "not-in-models", error: null,
        fetchedAt: null, httpStatus: null, parseVersion: PARSE_VERSION,
        credential: null, snapshots: [],
        usage: null, thresholds: null, limits: null,
      };
    }

    const resolved = await resolveApiKey(this.ctx);
    const apiKey = resolved ? resolved.key : undefined;
    if (!apiKey) {
      return {
        configured: false, reason: "no-api-key", error: null,
        fetchedAt: null, httpStatus: null, parseVersion: PARSE_VERSION,
        credential: null, snapshots: [],
        usage: null, thresholds: null, limits: null,
      };
    }

    const attemptAt = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
      res = await fetch(baseUrl, {
        headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
        signal: controller.signal,
      });
    } catch {
      this.recordSnapshot({ attemptAt, httpStatus: null, parseVersion: PARSE_VERSION, error: "network", body: null });
      return {
        configured: true, reason: null, error: "network",
        fetchedAt: attemptAt, httpStatus: null, parseVersion: PARSE_VERSION,
        credential: null, snapshots: this.snapshots.slice(),
        usage: null, thresholds: null, limits: null,
      };
    } finally {
      clearTimeout(timer);
    }

    if (res.status === 401) {
      this.recordSnapshot({ attemptAt, httpStatus: res.status, parseVersion: PARSE_VERSION, error: "unauthorized", body: await tryJson(res) });
      return {
        configured: true, reason: null, error: "unauthorized",
        fetchedAt: attemptAt, httpStatus: res.status, parseVersion: PARSE_VERSION,
        credential: null, snapshots: this.snapshots.slice(),
        usage: null, thresholds: null, limits: null,
      };
    }
    if (!res.ok) {
      this.recordSnapshot({ attemptAt, httpStatus: res.status, parseVersion: PARSE_VERSION, error: `http-${res.status}`, body: await tryJson(res) });
      return {
        configured: true, reason: null, error: `http-${res.status}`,
        fetchedAt: attemptAt, httpStatus: res.status, parseVersion: PARSE_VERSION,
        credential: null, snapshots: this.snapshots.slice(),
        usage: null, thresholds: null, limits: null,
      };
    }

    let body;
    try {
      body = await res.json();
    } catch {
      this.recordSnapshot({ attemptAt, httpStatus: res.status, parseVersion: PARSE_VERSION, error: "bad-json", body: null });
      return {
        configured: true, reason: null, error: "bad-json",
        fetchedAt: attemptAt, httpStatus: res.status, parseVersion: PARSE_VERSION,
        credential: null, snapshots: this.snapshots.slice(),
        usage: null, thresholds: null, limits: null,
      };
    }

    const usage = body && typeof body === "object" && body.usage ? body.usage : body;
    const credential = { source: resolved.source, keyHint: maskKey(apiKey) };
    this.recordSnapshot({ attemptAt, httpStatus: res.status, parseVersion: PARSE_VERSION, error: null, body: snapshotBody(body) });
    return {
      configured: true,
      reason: null,
      error: null,
      fetchedAt: attemptAt,
      httpStatus: res.status,
      parseVersion: PARSE_VERSION,
      credential,
      snapshots: this.snapshots.slice(),
      usage: {
        rolling: pickWindow(usage && usage.rolling),
        weekly: pickWindow(usage && usage.weekly),
        monthly: pickWindow(usage && usage.monthly),
      },
      thresholds: { warn, danger },
      // Reference plan limits for context only; the endpoint reports
      // percent, and these can drift with plan changes.
      limits: { rolling: "$12", weekly: "$30", monthly: "$60" },
    };
  }

  /**
   * Aggregate per-session usage from DeepSeek Harness session persistence.
   * Every DSH session logs per-step token accounting on its
   * `assistant/message` events, so this works for every deployment —
   * no local OpenCode client required. Sessions are matched per step: only
   * the steps actually served by the opencode-go provider are counted, and
   * any session containing at least one such step is returned.
   * Logs are decoded with a small worker pool so a long history does not
   * serialize on one read at a time.
   */
  async dshUsage() {
    const query = this.ctx.sessionQuery;
    const maxSessions = typeof this.config.maxSessions === "number" && this.config.maxSessions > 0
      ? Math.min(this.config.maxSessions, 100)
      : MAX_SESSIONS;

    let records;
    try {
      records = await query.listSessions();
    } catch (error) {
      return {
        ok: false,
        error: "list-failed",
        message: "读取 DSH 会话列表失败：" + String(error && error.message ? error.message : error),
        fetchedAt: null,
        scanned: 0,
        totals: null,
        sessions: [],
      };
    }

    const sorted = [...records]
      .filter((record) => record && record.header && typeof record.header.id === "string")
      .sort((a, b) => (b.header.createdAt || 0) - (a.header.createdAt || 0))
      .slice(0, maxSessions);

    const folded = await mapPool(sorted, READ_CONCURRENCY, async (record) => {
      const snapshot = await query.readSession(record.header.id);
      const fold = foldSessionLog(record.header.id, record.header.createdAt || 0, snapshot.events || []);
      if (fold.provider !== PROVIDER_ID) return null;
      return {
        sessionId: fold.sessionId,
        title: fold.title,
        cwd: asString(record.header.cwd) ?? null,
        agentPreset: asString(record.header.agentPreset) ?? null,
        provider: fold.provider,
        model: fold.model,
        createdAt: fold.createdAt,
        messageCount: fold.messageCount,
        totals: fold.totals,
        // Per-step rows are deliberately NOT part of the list payload (up to
        // 400 entries per session); the detail view fetches them on demand
        // through dshSessionMessages.
      };
    });
    const sessions = folded.filter((session) => session !== null);

    const totals = sessions.reduce(
      (acc, s) => ({
        inputTokens: acc.inputTokens + s.totals.inputTokens,
        outputTokens: acc.outputTokens + s.totals.outputTokens,
        cacheReadTokens: acc.cacheReadTokens + s.totals.cacheReadTokens,
        cacheWriteTokens: acc.cacheWriteTokens + s.totals.cacheWriteTokens,
        reasoningTokens: acc.reasoningTokens + s.totals.reasoningTokens,
      }),
      { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 },
    );

    return {
      ok: true,
      error: null,
      message: null,
      fetchedAt: Date.now(),
      scanned: sorted.length,
      totals: sessions.length > 0 ? totals : null,
      sessions,
    };
  }

  /** Per-step (per model call) usage of one DSH session. */
  async dshSessionMessages(sessionId) {
    const id = typeof sessionId === "string" && sessionId.length > 0 ? sessionId : undefined;
    if (id === undefined) {
      return { ok: false, error: "missing-session", message: "缺少会话 ID。", sessionId: null, model: null, provider: null, createdAt: null, stepCount: 0, steps: [] };
    }
    try {
      const snapshot = await this.ctx.sessionQuery.readSession(id);
      const folded = foldSessionLog(id, snapshot.session && snapshot.session.createdAt || 0, snapshot.events || []);
      return {
        ok: true,
        error: null,
        message: null,
        sessionId: id,
        model: folded.model,
        provider: folded.provider,
        createdAt: folded.createdAt,
        stepCount: folded.messageCount,
        steps: folded.steps,
      };
    } catch (error) {
      return {
        ok: false,
        error: "read-failed",
        message: "读取会话明细失败：" + String(error && error.message ? error.message : error),
        sessionId: id,
        model: null,
        provider: null,
        createdAt: null,
        stepCount: 0,
        steps: [],
      };
    }
  }
}

export default OpencodeUsageGateway;
