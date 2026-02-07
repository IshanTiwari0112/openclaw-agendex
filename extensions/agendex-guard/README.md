# Agendex Guard (OpenClaw Extension)

Single-tool guard that routes all external actions through an Agendex guard service.

## What it does
- Exposes one tool: `agendex_guard`
- Forwards the action + params to a guard service (`/invoke`)
- Guard service performs policy checks and only executes when allowed

## Config
Add this extension and configure the guard URL:

```json
{
  "plugins": {
    "agendex-guard": {
      "guardUrl": "http://guard:8080",
      "defaultTask": "openclaw_social",
      "timeoutMs": 15000,
      "contextDefaults": {
        "agent_identity": "openclaw-bot"
      }
    }
  },
  "tools": {
    "allow": ["agendex_guard"]
  }
}
```

## Tool params
- `action` (string, required)
- `params` (object, optional)
- `task` (string, optional; defaults to plugin config `defaultTask`)
- `context` (object, optional)
- `user_prompt` (string, optional)
- `reasoning` (string, optional)

## Common actions
Agendex executes the action using its own credentials (no local API keys required).

- `x.read` → read mentions for the configured X user
- `x.post` → publish a post
- `web.search` → search the web
- `web.fetch` → fetch a URL
- `message.send` → send an outbound message (for channel interception)

Example (publish to X):

```
agendex_guard(action="x.post", params={ "text": "Clawhaunt live — #Agendex" })
```

## Notes
- Keep the agent tool allowlist restricted to `agendex_guard` to avoid bypass.
- Run the agent in a network-restricted container that can only reach the guard service.

Sample config: `config.sample.json`
### Outbound channel interception

Set `interceptOutbound: true` to run all outbound channel messages through the guard.
Use `outboundAction` to control the action name sent to the guard (default: `message.send`).
### WhatsApp allowlist

For WhatsApp, set `channels.whatsapp.dmPolicy` to `allowlist` and add your E.164 number in `channels.whatsapp.allowFrom` (e.g., `+15555550123`).
