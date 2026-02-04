import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { createAgendexGuardTool, registerAgendexMessageGuard } from "./src/agendex-guard-tool.ts";

export default function register(api: OpenClawPluginApi) {
  registerAgendexMessageGuard(api);
  api.registerTool(createAgendexGuardTool(api), { optional: true });
}
