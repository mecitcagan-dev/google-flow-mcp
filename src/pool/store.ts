import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Everything the pool remembers is a file here, so a restarted server (or another MCP client) sees the same runs.
export const POOL_HOME = process.env.FLOW_POOL_HOME ?? join(homedir(), ".flow-mcp-pool");
const RUNS = join(POOL_HOME, "runs");
const LOCKS = join(POOL_HOME, "locks");
const CREDITS = join(POOL_HOME, "credits.json");
export const CREDIT_TTL_MS = 30 * 60_000;

export type SceneStatus = "pending" | "requested" | "rendering" | "done" | "failed" | "not_started";
export type SceneState = { name: string; status: SceneStatus; file?: string; credits?: number; error?: string };
export type WorkerState = {
  run: string;
  account: string;
  pid: number;
  status: "running" | "done" | "failed";
  scenes: SceneState[];
  credits_after?: number;
  error?: string;
  updated: number;
  log: string[];
};
// What a worker is asked to do; kept beside its state so flow_retry can rebuild a scene without the caller resending it.
export type WorkerTask = {
  run: string;
  account: string;
  project_url?: string;
  output_dir: string;
  file_prefix: string;
  aspect_ratio: "9:16" | "16:9";
  model: string;
  character?: string;
  scenes: { name: string; prompt: string; seconds: 4 | 6 | 8 | 10; max_credits: number }[];
  // recover only
  count?: number;
};

const readJson = <T>(file: string): T | undefined => {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return undefined;
  }
};
// Written to a temp file and renamed, so a reader never sees half a file.
const writeJson = (file: string, data: unknown): void => {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 1));
  renameSync(tmp, file);
};

export const runDir = (run: string): string => join(RUNS, run);
export const taskFile = (run: string, account: string): string => join(runDir(run), `${account}.task.json`);
const stateFile = (run: string, account: string): string => join(runDir(run), `${account}.json`);

export function writeTask(task: WorkerTask): string {
  mkdirSync(runDir(task.run), { recursive: true });
  writeJson(taskFile(task.run, task.account), task);
  return taskFile(task.run, task.account);
}
export type RunMeta = { run: string; kind: "generate" | "recover"; output_dir: string; created: string; unplaced: string[]; retry_of?: string };
export function writeMeta(meta: RunMeta): void {
  mkdirSync(runDir(meta.run), { recursive: true });
  writeJson(join(runDir(meta.run), "_meta.json"), meta);
}
export const readMeta = (run: string): RunMeta | undefined => readJson<RunMeta>(join(runDir(run), "_meta.json"));
export const readTask = (run: string, account: string): WorkerTask | undefined => readJson<WorkerTask>(taskFile(run, account));

export function writeState(state: WorkerState): void {
  mkdirSync(runDir(state.run), { recursive: true });
  state.updated = Date.now();
  writeJson(stateFile(state.run, state.account), state);
}
export const readState = (run: string, account: string): WorkerState | undefined => readJson<WorkerState>(stateFile(run, account));

export function runStates(run: string): WorkerState[] {
  if (!existsSync(runDir(run))) return [];
  return readdirSync(runDir(run))
    .filter((f) => f.endsWith(".json") && !f.endsWith(".task.json") && !f.startsWith("_"))
    .map((f) => readJson<WorkerState>(join(runDir(run), f)))
    .filter((s): s is WorkerState => Boolean(s));
}

// Newest first.
export function listRuns(limit = 10): string[] {
  if (!existsSync(RUNS)) return [];
  return readdirSync(RUNS)
    .map((name) => ({ name, at: statSync(join(RUNS, name)).mtimeMs }))
    .sort((a, b) => b.at - a.at)
    .slice(0, limit)
    .map((r) => r.name);
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

// One browser tab can only be driven by one worker. The lock names the worker's pid, so a worker that died without
// cleaning up does not block the account for ever.
export function isBusy(account: string): boolean {
  const lock = readJson<{ pid: number }>(join(LOCKS, `${account}.json`));
  return Boolean(lock && pidAlive(lock.pid));
}
export function lockAccount(account: string, pid: number): boolean {
  if (isBusy(account)) return false;
  mkdirSync(LOCKS, { recursive: true });
  writeJson(join(LOCKS, `${account}.json`), { pid, at: Date.now() });
  return true;
}
export function unlockAccount(account: string, pid?: number): void {
  const file = join(LOCKS, `${account}.json`);
  const lock = readJson<{ pid: number }>(file);
  if (lock && (pid === undefined || lock.pid === pid)) rmSync(file, { force: true });
}

export type CreditEntry = { credits: number | null; signed_in: boolean; in_project: boolean; email?: string; error?: string; at: number };

// Reading a balance opens Flow's account panel and takes a few seconds per account, so answers are reused for 30 minutes (a run writes its account's new balance itself).
export function readCreditCache(now = Date.now()): Record<string, CreditEntry> {
  const all = readJson<Record<string, CreditEntry>>(CREDITS) ?? {};
  return Object.fromEntries(Object.entries(all).filter(([, e]) => now - e.at < CREDIT_TTL_MS));
}
export function writeCreditCache(entries: Record<string, CreditEntry>): void {
  mkdirSync(POOL_HOME, { recursive: true });
  writeJson(CREDITS, { ...(readJson<Record<string, CreditEntry>>(CREDITS) ?? {}), ...entries });
}
export function dropCreditCache(account: string): void {
  const all = readJson<Record<string, CreditEntry>>(CREDITS) ?? {};
  delete all[account];
  mkdirSync(POOL_HOME, { recursive: true });
  writeJson(CREDITS, all);
}
