## Config AINexus plugin

In openclaw.json, we must have these items:

```json
  "plugins": {
    "load": {
      "paths": [
        "/home/leaz/workspace/openclaw/extensions/ai-nexus"
      ]
    },
    "entries": {
      "ai-nexus": {
        "enabled": true
      }
    },
    "installs": {
      "ai-nexus": {
        "source": "path",
        "spec": "ai-nexus",
        "sourcePath": "/home/leaz/workspace/openclaw/extensions/ai-nexus",
        "installPath": "/home/leaz/workspace/openclaw/extensions/ai-nexus",
        "installedAt": "2026-03-29T02:34:26.505Z"
      }
    },
    "allow": ["ai-nexus"]
  },
  "channels": {
    "ai-nexus": {
      "enabled": true,
      "webhookPath": "/webhook/ainexus",
      "token": "a",
      "dmPolicy": "open",
      // Optional key for AI Nexus external API (file, mcp, etc.). Overrides envronment variable AINEXUS_API_KEY.
      "aiNexusApiKey": "...",
      // If we want to send exec approval to ai-nexus, add this section:
      "execApprovals": {
        "enabled": true,
        "target": "dm"
      }
    }
  },
  // If we want to send exec approval to ai-nexus, add this section:
  "approvals": {
    "exec": {
      "enabled": true,
      "mode": "session",
      "agentFilter": ["main"],
      "sessionFilter": ["ai-nexus"],
      "targets": [
        { "channel": "ai-nexus", "to": "tenny" }
      ],
    },
  },
```

Then we could call this plugin like:

```
curl -X POST http://localhost:18789/webhook/ainexus --data '{"webhookToken": "a", "senderId": "tenny", "stream": true, "text": "hi"}'
```

- URL `webhook/ainexus` is the `channels.ai-nexus.webhookPath` in openclaw.json
- Post data `a` is the `channels.ai-nexus.token` in openclaw.json
- If set `stream` to true, OpenClaw will send SSE chunks back. If set `sync` to true, OpenClaw will send every chunks back at once.
- If set `signalrGroupId` and `signalrToken`, OpenClaw will post response back to signalr group.

We will get this response data in SSE:

```
data: {"type":"tool","text":"read"}

data: {"type":"tool","text":"read"}

data: {"type":"tool","text":"memory_search"}

data: {"type":"tool","text":"read"}

data: {"type":"media","url":"http://example-image.jpg"}

data: {"type":"chunk","text":"Hey—hi tenny 👋\n\nI’m up and ready. What do you want to do first?"}

data: {"type":"done"}

```

If there is error calling webhook, we get SSE data like:
```
data: {"type":"error","status":401,"message":"{ \"error\": \"Invalid token\" }"}
```


## Health probe

A lightweight HTTP health endpoint is registered alongside the webhook, at
`GET <webhookPath>/health`. It returns a small JSON snapshot without invoking
the agent, reading any request body, or emitting outbound traffic, so it is
safe to hit frequently from uptime monitors, Kubernetes liveness probes, or
load balancers.

- Method: `GET` (anything else returns `405` with `Allow: GET`)
- Auth: `Authorization: Bearer <token>` using the same `channels.ai-nexus.token`
  (or per-account `token`) from `openclaw.json`. The token is compared in
  constant time. There is no `?token=` query fallback and no custom header,
  so the token is never written to access logs, referrers, or shell history,
  and OpenClaw's built-in log scrubber automatically redacts probe traffic.
- Failure modes: `401 Unauthorized` with a `WWW-Authenticate: Bearer` challenge
  when the header is missing, uses a non-Bearer scheme, is empty, or does not
  match the configured token.

Example:

```
curl -fsS -H "Authorization: Bearer a" \
  http://localhost:18789/webhook/ainexus/health
```

Response:

```json
{
  "ok": true,
  "channel": "ai-nexus",
  "accountId": "default",
  "enabled": true,
  "signalrConnected": false,
  "ts": 1761300000000
}
```

`signalrConnected` is `true` only when the inbound SignalR client (see
"Call OpenClaw using signalr server" below) is currently in the `Connected`
state; it is always `false` for accounts that do not run the SignalR client.

Kubernetes liveness probe equivalent:

```yaml
livenessProbe:
  httpGet:
    path: /webhook/ainexus/health
    port: 18789
    httpHeaders:
      - name: Authorization
        value: Bearer a
```


## Call OpenClaw using signalr server

We use the signalr server URL http://192.168.41.173:5246

You can also set environment variable AINEXUS_SIGNALR_URL to override this URL.

Docs see: http://192.168.41.173:5246/swagger/index.html

1. Prepare a group for openclaw to receive message
   You either:
   - Call `POST /groups` to create a new group
   - Or call `GET /groups` to find a existing group to use.

   **A group must only have 1 openclaw gateway. 2 openclaw gateways cannot share a same group.**

2. Ensure members in a group

   You (the user) and openclaw gateway must be in the same group.
   You create a unique id for openclaw gateway to join a group. Like `openclaw-xxxxxx`.
   Call `POST /groups/{groupId}/members` to add id to the group, or check for members using `GET /groups/{groupId}`.

3. Config openclaw environment

   You need to config these environment variables:
   - AINEXUS_TOKEN
     Optional token location for webhook api. If `channels.ai-nexus.token` is set in openclaw.json (default is `a`), ignore this environment.
   - AINEXUS_API_KEY
     Token to call AI nexus external API (file, mcp, etc.). Can be obtained from https://ainexus.phison.com/settings/api-key
   - AINEXUS_SIGNALR_GROUP_ID
     Group id for openclaw to communicate to. Messages not from this group id are ignored.
   - AINEXUS_SIGNALR_TOKEN
     Token (id) for openclaw to send reply to `POST /groups/{groupId}/messages` to signalr server. Should use the same for your openclaw id `openclaw-xxxxxx`.

## OpenClaw's signalr response

We listen to signalr server's `OnMessage` event.
The event argment object syntax is:

```js
interface MessageDto {
  messageId: string;
  groupId: string;
  senderId: string;
  kind: "text" | "file" | "tool" | "approval";
  text?: string;
  fileId?: string;
  createdAtUtc: string;
}
```

1. kind: text

   The `text` field contains the text message.

2. kind: tool

   The `text` field contains the tool call name.

3. kind: file

   The `fileId` field contains the file id in AI Nexus `/api/external/v1/Files` API.

4. kind: approval

   The `text` field contains the exec approval data, which is a serialized JSON text:

   ```json
   {
     "approvalId": "ed67c77e-8d3e-4e7d-8e6a-fd21b81e11b8",
     "command": "{
        command: 'docker ps -a',
        cwd: '/home/tenny/.openclaw/workspace',
        host: 'gateway',
        nodeId: undefined,
        agentId: 'main',
        allowedDecisions: [ 'allow-once', 'deny' ],
        expiresAtMs: 1776154737260
      }"
   }
   ```
