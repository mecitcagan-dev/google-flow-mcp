# flow-pool: one MCP server for many Flow accounts

`dist/pool.js` is a second entry point beside the single-account server (`dist/index.js`, unchanged). It spreads
video scenes over several Google accounts, each in its own Chrome profile, and returns named files.

## Register it (any MCP client: Claude Code, Antigravity, Codex, Cursor)

```json
{ "mcpServers": { "flow": { "command": "node", "args": ["/Users/<you>/flow-mcp/dist/pool.js"] } } }
```

No environment variables are needed. Build first with `npm run build`.

## Accounts: `~/.flow-mcp-pool/accounts.json`

Created on first start from the existing `~/.flow-mcp-<letter>` profiles. One entry per account:

```json
{ "id": "a", "home": "/Users/<you>/.flow-mcp-a", "cdp_port": 9333, "email": "x@gmail.com",
  "project_url": "https://flow.google.com/project/<id>", "enabled": true, "note": "" }
```

- New account: add an entry with a free port, then sign in once with
  `FLOW_MCP_HOME=<home> FLOW_MCP_CDP_PORT=<port> npm run login`, open a project and put its address in `project_url`.
- `enabled: false` keeps an account closed and unspent; `note` says why.
- Two profiles signed in to the same Google account share one balance and are counted once (the address is read
  from Flow itself, so a wrong `email` here does no harm).

## Tools

| Tool | What it does |
|---|---|
| `flow_accounts` | Every account's credits and state; total usable credits. Reloads each tab, about 13 s for 12 accounts, reused for 30 minutes |
| `flow_generate` | Scenes in, files out: splits by credits, generates in parallel, saves `<output_dir>/<file_prefix><name>.mp4`. `dry_run` shows the split only |
| `flow_wait` | Status per scene; returns within 40 s, call until `finished` |
| `flow_retry` | Redoes scenes that cost nothing, on other accounts first |
| `flow_recover` | Downloads clips Flow already holds, free |

## What it guarantees

- A quote above the scene's cap (default: the known price) is never approved; an unreadable quote is refused too.
- State is on disk (`~/.flow-mcp-pool/runs`): workers are separate processes, so a restarted client loses nothing.
- A scene whose error starts with `paid_not_saved` is in Flow already; `flow_retry` skips it, `flow_recover` fetches it.
- An existing file is moved to `<output_dir>/_replaced/`, never overwritten.

## Checked live (13 Nov 2026)

- Balances on 12 accounts in 13 s.
- One 4 s clip: 7 credits, file saved, balance 8 → 1.
- A refusal by Flow's agent: reported in 15 s with nothing spent, retried on another account.
- Recovery download: byte-identical to the generated file.
- Three 4 s scenes with a character over two accounts at once (two scenes in one, one in the other): all three
  saved under the right names in about 2 minutes, 21 credits, balances 15 → 1 and 15 → 8.

Each account draws its own portrait from the same description, so a character split over two accounts is close
but not identical; keep a character's scenes within one account's balance when the look matters.

Tests: `npm run build && node --test test/*.test.mjs`.
