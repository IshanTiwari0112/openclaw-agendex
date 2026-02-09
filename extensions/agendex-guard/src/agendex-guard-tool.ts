import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

type PluginCfg = {
  guardUrl?: string;
  timeoutMs?: number;
  defaultTask?: string;
  contextDefaults?: Record<string, unknown>;
  interceptOutbound?: boolean;
  outboundAction?: string;
  outboundFooter?: string;
};

type GuardPayload = {
  task: string;
  action: string;
  params: Record<string, unknown>;
  context?: Record<string, unknown>;
  user_prompt?: string;
  reasoning?: string;
};

type GuardResponse = {
  result?: unknown;
  [key: string]: unknown;
};

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_OUTBOUND_ACTION = "message.send";
const DEFAULT_OUTBOUND_FOOTER = "— Verified by Agendex";
let lastInboundText: string | undefined;

function recordInboundText(text?: string): void {
  const trimmed = typeof text === "string" ? text.trim() : "";
  if (trimmed) {
    lastInboundText = trimmed;
  }
}

function readRequiredString(params: Record<string, unknown>, key: string, label = key): string {
  const raw = params[key];
  if (typeof raw !== "string" || !raw.trim()) {
    throw new Error(`${label} required`);
  }
  return raw.trim();
}

function readOptionalString(params: Record<string, unknown>, key: string): string | undefined {
  const raw = params[key];
  if (typeof raw !== "string") {
    return undefined;
  }
  const value = raw.trim();
  return value ? value : undefined;
}

function readOptionalRecord(params: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const raw = params[key];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  return raw as Record<string, unknown>;
}

function coerceString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function extractQuotedText(hint: string): string | undefined {
  const directMatch =
    hint.match(/text\s*=\s*["“]([^"”]+)["”]/i) ||
    hint.match(/text\s*=\s*'([^']+)'/i);
  if (directMatch?.[1]) {
    return directMatch[1].trim();
  }
  const quoteMatch = hint.match(/["“]([^"”]+)["”]/);
  if (quoteMatch?.[1]) {
    return quoteMatch[1].trim();
  }
  return undefined;
}

function extractSearchQuery(hint: string): string | undefined {
  const quoted = extractQuotedText(hint);
  if (quoted) {
    return quoted;
  }
  const lowered = hint.toLowerCase();
  const tokens = ["search for", "search", "find", "lookup", "query"];
  for (const token of tokens) {
    const idx = lowered.indexOf(token);
    if (idx >= 0) {
      const candidate = hint.slice(idx + token.length).trim();
      if (candidate) {
        return candidate;
      }
    }
  }
  return hint.trim() || undefined;
}

function normalizeActionParams(
  action: string,
  payloadParams: Record<string, unknown>,
  rawParams: Record<string, unknown>,
): void {
  if (action === "x.post" && !coerceString(payloadParams.text)) {
    const body = payloadParams.body;
    if (body && typeof body === "object" && !Array.isArray(body)) {
      const bodyText = coerceString((body as { text?: unknown }).text);
      if (bodyText) {
        payloadParams.text = bodyText;
      }
    }
  }
  if (action === "x.post" && !coerceString(payloadParams.text)) {
    const fallback = coerceString(rawParams.text);
    if (fallback) {
      payloadParams.text = fallback;
    }
  }
  if (action === "x.post" && !coerceString(payloadParams.text)) {
    const taskHint = coerceString(rawParams.task);
    if (taskHint) {
      const extracted = extractQuotedText(taskHint);
      if (extracted) {
        payloadParams.text = extracted;
      }
    }
  }
  if (action === "x.post" && !coerceString(payloadParams.text)) {
    const promptHint = coerceString(rawParams.user_prompt) ?? coerceString(rawParams.reasoning);
    if (promptHint) {
      const extracted = extractQuotedText(promptHint);
      if (extracted) {
        payloadParams.text = extracted;
      }
    }
  }
  if (action === "web_search" || action === "web.search") {
    const query = coerceString(payloadParams.query) ?? coerceString(payloadParams.q);
    if (!query) {
      const rawQuery = coerceString(rawParams.query) ?? coerceString(rawParams.q);
      if (rawQuery) {
        payloadParams.query = rawQuery;
      }
    }
    if (!coerceString(payloadParams.query)) {
      const hint =
        coerceString(rawParams.task) ??
        coerceString(rawParams.user_prompt) ??
        coerceString(rawParams.reasoning);
      if (hint) {
        const extracted = extractSearchQuery(hint);
        if (extracted) {
          payloadParams.query = extracted;
        }
      }
    }
  }
  if (action === "x.search") {
    const query = coerceString(payloadParams.query) ?? coerceString(payloadParams.q);
    if (!query) {
      const rawQuery = coerceString(rawParams.query) ?? coerceString(rawParams.q);
      if (rawQuery) {
        payloadParams.query = rawQuery;
      }
    }
    if (!coerceString(payloadParams.query)) {
      const hint =
        coerceString(rawParams.task) ??
        coerceString(rawParams.user_prompt) ??
        coerceString(rawParams.reasoning);
      if (hint) {
        const extracted = extractSearchQuery(hint);
        if (extracted) {
          payloadParams.query = extracted;
        }
      }
    }
  }
}

function requireActionParams(action: string, payloadParams: Record<string, unknown>): void {
  if (action === "x.post" && !coerceString(payloadParams.text)) {
    throw new Error("x.post requires params.text");
  }
  if (action === "x.search" && !coerceString(payloadParams.query)) {
    throw new Error("x.search requires params.query");
  }
  if ((action === "web_search" || action === "web.search") && !coerceString(payloadParams.query)) {
    throw new Error("web_search requires params.query");
  }
}

function resolveGuardUrl(cfg: PluginCfg): string {
  const fromCfg = typeof cfg.guardUrl === "string" ? cfg.guardUrl.trim() : "";
  const fromEnv = typeof process.env.AGENDEX_GUARD_URL === "string" ? process.env.AGENDEX_GUARD_URL.trim() : "";
  const resolved = fromCfg || fromEnv;
  if (!resolved) {
    throw new Error("guardUrl required (plugin config guardUrl or AGENDEX_GUARD_URL env)");
  }
  return resolved.replace(/\/+$/, "");
}

function resolveTimeoutMs(cfg: PluginCfg): number {
  return typeof cfg.timeoutMs === "number" && cfg.timeoutMs > 0 ? cfg.timeoutMs : DEFAULT_TIMEOUT_MS;
}

function resolveTask(params: Record<string, unknown>, cfg: PluginCfg): string {
  const fromCfg = typeof cfg.defaultTask === "string" ? cfg.defaultTask.trim() : "";
  if (fromCfg) {
    return fromCfg;
  }
  const fromParams = readOptionalString(params, "task");
  if (fromParams) {
    return fromParams;
  }
  const fromEnv = typeof process.env.AGENDEX_TASK === "string" ? process.env.AGENDEX_TASK.trim() : "";
  if (fromEnv) {
    return fromEnv;
  }
  throw new Error("task required (tool param task or plugin config defaultTask)");
}

function mergeContext(
  defaults: Record<string, unknown> | undefined,
  provided: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!defaults && !provided) {
    return undefined;
  }
  return { ...(defaults ?? {}), ...(provided ?? {}) };
}

function resolveEndpoint(baseUrl: string, path: string): string {
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return `${baseUrl}${suffix}`;
}

function resolveOutboundFooter(cfg: PluginCfg): string {
  const fromCfg = typeof cfg.outboundFooter === "string" ? cfg.outboundFooter.trim() : "";
  if (fromCfg) {
    return fromCfg;
  }
  const fromEnv =
    typeof process.env.AGENDEX_OUTBOUND_FOOTER === "string"
      ? process.env.AGENDEX_OUTBOUND_FOOTER.trim()
      : "";
  if (fromEnv) {
    return fromEnv;
  }
  return DEFAULT_OUTBOUND_FOOTER;
}

function appendFooter(text: string, footer: string): string {
  const trimmedFooter = footer.trim();
  if (!trimmedFooter) {
    return text;
  }
  const base = text.trimEnd();
  if (base.endsWith(trimmedFooter)) {
    return base;
  }
  if (!base) {
    return trimmedFooter;
  }
  return `${base}\n\n${trimmedFooter}`;
}

function toErrorPayload(status: number, bodyText: string): Error {
  const msg = bodyText.trim() ? bodyText.trim() : "guard request failed";
  const trimmed = msg.length > 2000 ? `${msg.slice(0, 2000)}…` : msg;
  return new Error(`guard request failed (${status}): ${trimmed}`);
}

async function requestGuard(api: OpenClawPluginApi, payload: GuardPayload): Promise<GuardResponse | string | null> {
  const cfg = (api.pluginConfig ?? {}) as PluginCfg;
  const guardUrl = resolveGuardUrl(cfg);
  const timeoutMs = resolveTimeoutMs(cfg);
  const endpoint = resolveEndpoint(guardUrl, "/invoke");

  if (api.logger?.debug) {
    api.logger.debug(`agendex_guard invoking ${endpoint}`);
  }

  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
  });

  const bodyText = await response.text();
  const data = (() => {
    if (!bodyText.trim()) {
      return null;
    }
    try {
      return JSON.parse(bodyText) as GuardResponse;
    } catch {
      return bodyText;
    }
  })();

  if (!response.ok) {
    throw toErrorPayload(response.status, typeof data === "string" ? data : JSON.stringify(data));
  }

  return data;
}

function extractTextFromGuardResult(data: GuardResponse | string | null): string | undefined {
  if (!data || typeof data === "string") {
    return undefined;
  }
  const result = data.result;
  if (!result || typeof result !== "object") {
    return undefined;
  }
  const resultObj = result as { params?: unknown; result?: unknown };
  const params = resultObj.params ?? (resultObj.result as { params?: unknown } | undefined)?.params;
  if (!params || typeof params !== "object") {
    return undefined;
  }
  const paramsObj = params as { text?: unknown; body?: unknown };
  if (typeof paramsObj.text === "string") {
    return paramsObj.text;
  }
  if (paramsObj.body && typeof paramsObj.body === "object") {
    const bodyText = (paramsObj.body as { text?: unknown }).text;
    if (typeof bodyText === "string") {
      return bodyText;
    }
  }
  return undefined;
}

function buildGuardSummary(data: GuardResponse | string | null, error?: string): string | undefined {
  if (error) {
    return `Agendex error: ${error}`;
  }
  if (!data) {
    return "Agendex: ok";
  }
  if (typeof data === "string") {
    return `Agendex: ${data}`;
  }
  const resultObj = data.result && typeof data.result === "object" ? (data.result as Record<string, unknown>) : {};
  const decision = coerceString((data as { decision?: unknown }).decision);
  const approvalId =
    coerceString((data as { approval_id?: unknown }).approval_id) ??
    coerceString((resultObj as { approval_id?: unknown }).approval_id);
  const action =
    coerceString((data as { action?: unknown }).action) ?? coerceString((resultObj as { action?: unknown }).action);
  const status =
    coerceString((resultObj as { status?: unknown }).status) ??
    (data as { success?: unknown }).success === true
      ? "ok"
      : (data as { success?: unknown }).success === false
        ? "error"
        : undefined;
  const parts: string[] = [];
  if (decision) {
    parts.push(`decision=${decision}`);
  }
  if (status) {
    parts.push(`status=${status}`);
  }
  if (action) {
    parts.push(`action=${action}`);
  }
  if (approvalId) {
    parts.push(`approval_id=${approvalId}`);
  }
  if (!parts.length) {
    return "Agendex: ok";
  }
  return `Agendex: ${parts.join(", ")}`;
}

type AliasToolSpec = {
  name: string;
  action: string;
  description: string;
  parameters: ReturnType<typeof Type.Object>;
};

function buildAliasPayload(
  cfg: PluginCfg,
  action: string,
  params: Record<string, unknown>,
): GuardPayload {
  const enrichedParams: Record<string, unknown> = { ...params };
  if (!readOptionalString(enrichedParams, "user_prompt") && lastInboundText) {
    enrichedParams.user_prompt = lastInboundText;
  }

  const task = resolveTask(enrichedParams, cfg);
  const payloadParams: Record<string, unknown> = { ...enrichedParams };
  delete payloadParams.task;
  delete payloadParams.context;
  delete payloadParams.user_prompt;
  delete payloadParams.reasoning;

  normalizeActionParams(action, payloadParams, enrichedParams);
  requireActionParams(action, payloadParams);

  const context = mergeContext(cfg.contextDefaults, readOptionalRecord(enrichedParams, "context"));
  const payload: GuardPayload = {
    task,
    action,
    params: payloadParams,
  };
  if (context) {
    payload.context = context;
  }
  const userPrompt = readOptionalString(enrichedParams, "user_prompt");
  const reasoning = readOptionalString(enrichedParams, "reasoning");
  if (userPrompt) {
    payload.user_prompt = userPrompt;
  }
  if (reasoning) {
    payload.reasoning = reasoning;
  }
  return payload;
}

function createAgendexAliasTool(api: OpenClawPluginApi, spec: AliasToolSpec) {
  return {
    name: spec.name,
    description: spec.description,
    parameters: spec.parameters,
    async execute(_id: string, args: Record<string, unknown>) {
      const cfg = (api.pluginConfig ?? {}) as PluginCfg;
      const payload = buildAliasPayload(cfg, spec.action, args ?? {});
      try {
        const data = await requestGuard(api, payload);
        const summary = buildGuardSummary(data);
        const responseBody = data ?? { ok: true };
        return {
          content: [
            {
              type: "text",
              text: summary
                ? `${summary}\n${JSON.stringify(responseBody, null, 2)}`
                : JSON.stringify(responseBody, null, 2),
            },
          ],
          details: summary ? { summary, data: responseBody } : responseBody,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const summary = buildGuardSummary(null, message);
        return {
          content: [
            {
              type: "text",
              text: summary
                ? `${summary}\n${JSON.stringify({ ok: false, error: message }, null, 2)}`
                : JSON.stringify({ ok: false, error: message }, null, 2),
            },
          ],
          details: summary ? { ok: false, error: message, summary } : { ok: false, error: message },
        };
      }
    },
  };
}

export function createAgendexWebSearchTool(api: OpenClawPluginApi) {
  return createAgendexAliasTool(api, {
    name: "web_search",
    action: "web.search",
    description:
      "Search the web via Agendex (Brave Search). Always routes through Agendex governance.",
    parameters: Type.Object({
      query: Type.Optional(Type.String({ description: "Search query." })),
      q: Type.Optional(Type.String({ description: "Search query (alias)." })),
      max_results: Type.Optional(Type.Number({ description: "Max results (1-10)." })),
      freshness: Type.Optional(Type.String({ description: "Freshness window (day/week/month)." })),
      country: Type.Optional(Type.String({ description: "Country code filter." })),
      language: Type.Optional(Type.String({ description: "Language code filter." })),
      task: Type.Optional(Type.String({ description: "Optional task label override." })),
      context: Type.Optional(
        Type.Object({}, { additionalProperties: true, description: "Extra context for policy decisions." }),
      ),
      user_prompt: Type.Optional(Type.String({ description: "Optional user prompt summary." })),
      reasoning: Type.Optional(Type.String({ description: "Optional reasoning for intent scoring." })),
    }),
  });
}

export function createAgendexWebFetchTool(api: OpenClawPluginApi) {
  return createAgendexAliasTool(api, {
    name: "web_fetch",
    action: "web.fetch",
    description:
      "Fetch a URL via Agendex (read-only). Always routes through Agendex governance.",
    parameters: Type.Object({
      url: Type.String({ description: "URL to fetch." }),
      method: Type.Optional(Type.String({ description: "HTTP method (GET/HEAD)." })),
      headers: Type.Optional(
        Type.Object({}, { additionalProperties: true, description: "Optional request headers." }),
      ),
      task: Type.Optional(Type.String({ description: "Optional task label override." })),
      context: Type.Optional(
        Type.Object({}, { additionalProperties: true, description: "Extra context for policy decisions." }),
      ),
      user_prompt: Type.Optional(Type.String({ description: "Optional user prompt summary." })),
      reasoning: Type.Optional(Type.String({ description: "Optional reasoning for intent scoring." })),
    }),
  });
}

export function registerAgendexMessageGuard(api: OpenClawPluginApi) {
  const cfg = (api.pluginConfig ?? {}) as PluginCfg;
  if (!cfg.interceptOutbound) {
    return;
  }
  const outboundFooter = resolveOutboundFooter(cfg);
  if (api.logger?.info) {
    api.logger.info("agendex_guard outbound intercept enabled");
  }

  api.on("message_received", (event) => {
    recordInboundText(event.content);
  });

  api.on("message_sending", async (event, ctx) => {
    if (api.logger?.info) {
      api.logger.info(`agendex_guard intercepting ${ctx.channelId} outbound message`);
    }
    const action = (typeof cfg.outboundAction === "string" && cfg.outboundAction.trim()) || DEFAULT_OUTBOUND_ACTION;
    const task = resolveTask({}, cfg);
    const context = mergeContext(cfg.contextDefaults, {
      channelId: ctx.channelId,
      accountId: ctx.accountId,
      conversationId: ctx.conversationId,
      metadata: event.metadata,
    });

    const payload: GuardPayload = {
      task,
      action,
      params: {
        channel: ctx.channelId,
        to: event.to,
        text: event.content,
        metadata: event.metadata ?? {},
      },
    };
    if (context) {
      payload.context = context;
    }

    try {
      const data = await requestGuard(api, payload);
      const nextText = extractTextFromGuardResult(data);
      return {
        content: appendFooter(nextText ?? event.content, outboundFooter),
      };
    } catch (err) {
      if (api.logger?.warn) {
        api.logger.warn(`agendex_guard outbound blocked: ${String(err)}`);
      }
      return { cancel: true };
    }
  });
}

export function createAgendexGuardTool(api: OpenClawPluginApi) {
  return {
    name: "agendex_guard",
    description:
      "Route a proposed action through the Agendex guard service. Use this tool for ALL external actions. " +
      "Agendex handles external credentials and execution (no local API keys required). " +
      "Common actions include: x.read (mentions), x.post (publish post; requires params.text), " +
      "web.search (requires params.query), web.fetch, message.send.",
    parameters: Type.Object({
      action: Type.String({ description: "Action name to evaluate/execute (e.g. http)." }),
      params: Type.Optional(
        Type.Object({}, { additionalProperties: true, description: "Action params forwarded to guard." }),
      ),
      task: Type.Optional(Type.String({ description: "Task label (fallbacks to plugin config defaultTask)." })),
      context: Type.Optional(
        Type.Object({}, { additionalProperties: true, description: "Extra context for policy decisions." }),
      ),
      user_prompt: Type.Optional(
        Type.String({ description: "Optional user prompt summary for intent scoring." }),
      ),
      reasoning: Type.Optional(Type.String({ description: "Optional reasoning for intent scoring." })),
    }),
    async execute(_id: string, params: Record<string, unknown>) {
      const cfg = (api.pluginConfig ?? {}) as PluginCfg;

      const enrichedParams: Record<string, unknown> = { ...params };
      if (!readOptionalString(enrichedParams, "user_prompt") && lastInboundText) {
        enrichedParams.user_prompt = lastInboundText;
      }

      const action = readRequiredString(enrichedParams, "action");
      const requestedTask = readOptionalString(enrichedParams, "task");
      const task = resolveTask(enrichedParams, cfg);
      if (requestedTask && requestedTask !== task && api.logger?.warn) {
        api.logger.warn(`agendex_guard ignoring task override (${requestedTask} -> ${task})`);
      }
      const payloadParams = readOptionalRecord(enrichedParams, "params") ?? {};
      normalizeActionParams(action, payloadParams, enrichedParams);
      requireActionParams(action, payloadParams);
      const context = mergeContext(cfg.contextDefaults, readOptionalRecord(enrichedParams, "context"));
      const userPrompt = readOptionalString(enrichedParams, "user_prompt");
      const reasoning = readOptionalString(enrichedParams, "reasoning");

      const payload: GuardPayload = {
        task,
        action,
        params: payloadParams,
      };
      if (context) {
        payload.context = context;
      }
      if (userPrompt) {
        payload.user_prompt = userPrompt;
      }
      if (reasoning) {
        payload.reasoning = reasoning;
      }

      try {
        const data = await requestGuard(api, payload);
        const summary = buildGuardSummary(data);
        const responseBody = data ?? { ok: true };
        return {
          content: [
            {
              type: "text",
              text: summary
                ? `${summary}\n${JSON.stringify(responseBody, null, 2)}`
                : JSON.stringify(responseBody, null, 2),
            },
          ],
          details: summary ? { summary, data: responseBody } : responseBody,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const summary = buildGuardSummary(null, message);
        return {
          content: [
            {
              type: "text",
              text: summary
                ? `${summary}\n${JSON.stringify({ ok: false, error: message }, null, 2)}`
                : JSON.stringify({ ok: false, error: message }, null, 2),
            },
          ],
          details: summary ? { ok: false, error: message, summary } : { ok: false, error: message },
        };
      }
    },
  };
}
