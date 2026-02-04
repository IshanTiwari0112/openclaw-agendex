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
  const fromParams = readOptionalString(params, "task");
  if (fromParams) {
    return fromParams;
  }
  const fromCfg = typeof cfg.defaultTask === "string" ? cfg.defaultTask.trim() : "";
  if (fromCfg) {
    return fromCfg;
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
  return new Error(`guard request failed (${status}): ${msg}`);
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
  const params = (result as { params?: unknown }).params;
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

export function registerAgendexMessageGuard(api: OpenClawPluginApi) {
  const cfg = (api.pluginConfig ?? {}) as PluginCfg;
  if (!cfg.interceptOutbound) {
    return;
  }
  const outboundFooter = resolveOutboundFooter(cfg);
  if (api.logger?.info) {
    api.logger.info("agendex_guard outbound intercept enabled");
  }

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
      "Route a proposed action through the Agendex guard service. Use this tool for ALL external actions.",
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

      const action = readRequiredString(params, "action");
      const task = resolveTask(params, cfg);
      const payloadParams = readOptionalRecord(params, "params") ?? {};
      const context = mergeContext(cfg.contextDefaults, readOptionalRecord(params, "context"));
      const userPrompt = readOptionalString(params, "user_prompt");
      const reasoning = readOptionalString(params, "reasoning");

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

      const data = await requestGuard(api, payload);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(data ?? { ok: true }, null, 2),
          },
        ],
        details: data ?? { ok: true },
      };
    },
  };
}
