# Account pool server: design (approved 13 Nov 2026)

## Why
Thirteen single-account servers (`flowa`..`flowm`) expose 260 tool definitions, the AI must pick accounts by hand, and
their generation tools no longer work in Flow's current UI. The logic that does work (agent-panel driver, credit split,
parallel runs) lives in project-specific scripts and cannot move to another MCP client such as Antigravity.

## Goal
One stdio MCP server, `dist/pool.js`, with five tools. The AI hands over scenes; the server reads credits, picks
accounts, generates in parallel browsers, downloads and names the files. Works unchanged in any MCP client.

Non-goals: changing the existing single-account server, Studio panel, captions or assemble tools. They stay as they are.
Anti-goals: paying twice for a clip; losing a paid clip on restart; approving a quote above the cap.

## Approaches considered
1. **Pool server in this repo, one child process per account (chosen).** `chrome.ts` and `flow.ts` read the profile and
   port from the environment at import time, so each account needs its own process anyway; child processes reuse them
   untouched and a crash in one account cannot stop the others.
2. Refactor `chrome.ts`/`flow.ts` to take an account argument: cleaner in theory, but rewrites 1,900 working lines.
3. Patch the 13 servers: keeps 260 tool definitions and manual account choice.

## Parts
- `src/pool/accounts.ts`: account list from `~/.flow-mcp-pool/accounts.json` (bootstrapped from the existing
  `~/.flow-mcp-<letter>` profiles and `~/.flow-mcp-projeler.json`). Fields: id, home, cdp_port, email, project_url,
  enabled, note. Accounts sharing an email share credits and count once.
- `src/pool/plan.ts`: pure function. Prefers one account that fits every scene (same character look), otherwise fills
  accounts greedily. Cost table for Omni 1.1 Flash 720p: 4/6/8/10 s = 7/10/12/15.
- `src/pool/worker.ts`: detached child per account. Modes: `credits`, `generate`, `recover`. Drives Flow's agent panel
  (port of `flow_ajan.mjs`), refuses a quote above the cap, maps finished tiles to scenes in creation order, downloads.
  Writes its state to `~/.flow-mcp-pool/runs/<run>/<account>.json`, so a server restart loses nothing.
- `src/pool/store.ts`: run files, credit cache (10 min), per-account lock with pid.
- `src/pool.ts`: MCP tools `flow_accounts`, `flow_generate` (with `dry_run`), `flow_wait`, `flow_retry`,
  `flow_recover`, and server instructions holding the prompt playbook.

## Left to the builder
Exact wording of tool descriptions; polling intervals; test layout (`node --test` on the built plan module).
