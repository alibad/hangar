# Hosted mode

Hangar has one codebase with two honest runtime modes.

## Local mode

Run Hangar on the machine whose services and files it operates. Local mode can
read mounted disks, local access logs, Codex and Claude task history, installed
model files, persistent generated-image output, and the stdio MCP server path.

## Hosted mode

Vercel builds publish `NEXT_PUBLIC_HANGAR_RUNTIME=hosted`. The hosted console can
use services that have an explicitly configured authenticated public route.
Machine-owned experiences do not attempt to inspect Vercel's ephemeral Linux
filesystem and do not present zero-filled results as if they were the user's
machine.

The hosted UI replaces these experiences with a **Local machine required**
surface:

- Storage Manager
- Image Studio's persistent queue and gallery
- Requests and local access-log history
- Codex, Claude, and durable router usage
- model installation and router configuration
- stdio MCP agent access

The placeholder names what becomes available locally and includes the three
commands needed to run the same checkout on port 8003.

`hangar.humanquest.net` is the canonical hosted URL.
`console.humanquest.net` is an additional entry point to the same deployment.
The hosted metadata is `noindex` because this is an operational console rather
than duplicate marketing content.
