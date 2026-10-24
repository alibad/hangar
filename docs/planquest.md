# Connect projects to PlanQuest

Open a project in Hangar's world, select **Connect PlanQuest**, then **Continue to
PlanQuest**. Approve read access in PlanQuest. Hangar returns to the same project
and opens the plan picker. Search titles, descriptions or folders; select a plan
to preview its milestones and key results, then choose **Link plan**.

This is an OAuth connection to `https://my.plans.quest/mcp`. No API-key copying or
manual title/URL entry is needed. Hangar requests only `plans:read`. Linking
changes Atlas's local project association; it never changes a plan, completes a
milestone or infers progress from coding activity. Existing manual links remain
readable and can be replaced through the picker.

Use **Connection & agent access** in the picker to reconnect, disconnect, or
unlink a project. Disconnecting keeps existing links. If remote revocation fails,
Hangar clears its local credentials and asks you to revoke the connection in
PlanQuest as well.

## Agent access

The existing `scripts/mcp-hangar.mjs` server exposes four additional tools. Restart
or reload that MCP connection in Claude/Codex after pulling the update. If your
client restricts tools with an allowlist, add these names:

| Tool | Purpose |
| --- | --- |
| `planquest_status` | Check the local connection without exposing credentials |
| `planquest_plans` | List or search accessible active plans |
| `planquest_plan` | Read a plan and its active milestones/key results |
| `planquest_link` | Save an explicitly authorized project/plan association |

For example: “Find plans about the desktop experience. Suggest which one belongs
to this Atlas project, show the milestones, and wait for my choice before linking.”

The agent must look up real project and plan IDs. The server re-reads the chosen
plan before saving its canonical title and URL, so an agent cannot invent a plan
URL or substitute a title. Plan descriptions are untrusted content, never agent
instructions. OAuth credentials stay server-side and are not returned by tools.

## Local storage and connected machines

OAuth credentials are stored outside the checkout in
`~/.hangar/planquest/connection.json`. On Windows the directory's inherited ACL is
removed and access granted to the current OS user and SYSTEM; on Unix newly
created directories/files use modes 700/600. Keep this directory private and out
of backups you publish. The app currently supports one PlanQuest account per
Hangar host, with automatically refreshed access tokens.

Only local loopback requests and approved SSH-forwarded Hangar ports are used.
The browser's Hangar host reads PlanQuest. Linking a project on another machine
sends only its project ID and the verified plan title/URL to that machine's Atlas.
No PlanQuest credentials are transferred between machines. Disconnecting the
tunnel makes saving fail visibly without silently selecting a different machine.

Public/hosted Hangar deployments cannot access this connection. OAuth callbacks
validate state, a short-lived HttpOnly browser cookie, PKCE, the callback origin
and a ten-minute expiry. The callback is consumed before exchanging the code.
PlanQuest API requests are omitted from Hangar's traffic feed. Development-server
access logs may contain short-lived OAuth callback query parameters; keep all
runtime logs private. Tokens never appear in browser URLs or client JSON.

## Validation limits

`node --test scripts/planquest.test.mjs` exercises the authorization lifecycle and
MCP contracts without real credentials. Browser fixture checks cover the picker;
they do not replace signing in and testing an actual account or remote machine.
