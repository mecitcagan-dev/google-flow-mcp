# Account Pool Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One MCP server (`dist/pool.js`) that spreads video scenes over many Flow accounts and returns named files.

**Architecture:** The server plans and supervises; one detached child process per account drives that account's Chrome
through the existing `chrome.ts`/`flow.ts`. All state is files under `~/.flow-mcp-pool`, so restarts lose nothing.

**Tech Stack:** TypeScript (NodeNext, Node 24), `@modelcontextprotocol/sdk`, `playwright-core`, `zod`, `node:test`.

**Spec:** `docs/superpowers/specs/2026-11-13-account-pool-design.md`

## Global Constraints

- Existing files under `src/` are not modified; new code lives in `src/pool/` and `src/pool.ts`.
- Cost table (Omni 1.1 Flash, 720p): 4 s = 7, 6 s = 10, 8 s = 12, 10 s = 15 credits.
- A quote above the scene's cap is never approved.
- Accounts with the same email count once. Disabled accounts are never opened.
- No MCP call blocks longer than 45 s.
- Tool descriptions and results are in English.

## Review Focus

- Not enough credits for every scene: refuse with the plan unless `allow_partial`; test in Task 1.
- Two profiles with one email: second is skipped; test in Task 1.
- Account already busy in another run: excluded from planning; test in Task 2 (lock with live pid).
- Worker dies mid-run: `flow_wait` reports `interrupted` and points to `flow_recover`; test in Task 2 (dead pid).
- Scene names that are unsafe as file names or duplicated: rejected before anything is spent; test in Task 1.

---

### Task 1: Planning (`src/pool/plan.ts`, test `test/plan.test.mjs`)

**Produces:**
- `COST: Record<4|6|8|10, number>`
- `type Scene = { name: string; prompt: string; seconds: 4|6|8|10 }`
- `type Balance = { id: string; email: string; credits: number }`
- `validateScenes(scenes: Scene[]): void` throws on duplicate or non `[\w-]+` names
- `planRun(scenes: Scene[], balances: Balance[]): { assignments: { account: string; scenes: Scene[]; cost: number }[]; unplaced: Scene[] }`

- [ ] Tests: single account preferred when one fits all (smallest sufficient balance wins); greedy split by highest
  balance otherwise, scene order kept; duplicate email used once; unplaced scenes listed; bad names throw.
- [ ] Implement, `npm run build && node --test test/`, commit.

### Task 2: Store (`src/pool/store.ts`, `src/pool/accounts.ts`, test `test/store.test.mjs`)

**Produces:**
- `POOL_HOME` (env `FLOW_POOL_HOME`, default `~/.flow-mcp-pool`)
- `type Account = { id: string; home: string; cdp_port: number; email: string; project_url?: string; enabled: boolean; note?: string }`
- `loadAccounts(): Account[]` (bootstraps `accounts.json` from `~/.flow-mcp-<letter>` and `~/.flow-mcp-projeler.json`)
- `type SceneState = { name: string; status: "pending"|"requested"|"rendering"|"done"|"failed"|"not_started"; file?: string; credits?: number; error?: string }`
- `type WorkerState = { run: string; account: string; pid: number; status: "running"|"done"|"failed"; scenes: SceneState[]; credits_after?: number; error?: string; updated: number; log: string[] }`
- `writeState`, `readState`, `listRuns`, `lockAccount(id, pid): boolean`, `unlockAccount`, `isBusy(id)`, `pidAlive`,
  `readCreditCache`, `writeCreditCache` (entries older than 10 min are dropped).

- [ ] Tests: lock with live pid blocks, with dead pid is taken over; state round-trips; stale cache entry dropped.
- [ ] Implement, test, commit.

### Task 3: Worker (`src/pool/worker.ts`)

**Consumes:** Task 2 store; `getFlowPage` (chrome.js); `getFlowState`, `mediaIds`, `downloadMedia`, `newErrorTiles` (flow.js).
**Produces:** CLI `node dist/pool/worker.js credits` (prints one JSON line) and `generate|recover <task.json>`.

- [ ] Port `flow_ajan.mjs`: open project, optional character image, per scene request → wait for Approve → read quote →
  refuse above cap → approve → wait for the new tile before the next request; then wait, map new tiles in creation
  order, download to `<output_dir>/<prefix><name>.mp4`, read the balance, write state after every step.
- [ ] Verified live in Task 5 (no unit test: it is browser automation).

### Task 4: Server (`src/pool.ts`)

**Produces:** tools `flow_accounts`, `flow_generate`, `flow_wait`, `flow_retry`, `flow_recover`; `package.json` script `pool`.

- [ ] Implement with server `instructions` carrying the prompt playbook; smoke test over stdio (`tools/list`,
  `flow_generate` with `dry_run`).

### Task 5: Live check and switch-over

- [ ] `flow_accounts` against the real profiles; one 4 s clip on one account; confirm file and balance change.
- [ ] Replace the 13 entries in `~/.claude.json` with one `flow`; update `README.md` and the project's `SISTEM.md`.
