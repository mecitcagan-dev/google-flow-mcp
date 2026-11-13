#!/usr/bin/env node
// flow-pool: one MCP server for many Flow accounts. The caller hands over scenes; this picks accounts by their
// credits, runs one browser worker per account in parallel, and reports named files. See docs/superpowers/specs.
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { ACCOUNTS_FILE, accountEnv, loadAccounts, type Account } from "./pool/accounts.js";
import { COST, costOf, planRun, validateScenes, type Scene } from "./pool/plan.js";
import {
  dropCreditCache, isBusy, listRuns, pidAlive, readCreditCache, readMeta, readTask, runStates, writeCreditCache, writeMeta, writeState, writeTask,
  type CreditEntry, type WorkerTask,
} from "./pool/store.js";

const WORKER = fileURLToPath(new URL("./pool/worker.js", import.meta.url));
const MAX_WAIT_S = 40;
const PAID = "paid_not_saved";

const INSTRUCTIONS = `Makes video clips in Google Flow across several Google accounts, spending each account's free daily credits.
Workflow: flow_generate (try dry_run first for a big job) -> flow_wait until finished -> use the files. You never choose accounts: the server reads balances and splits the scenes.
Costs (Omni 1.1 Flash, 720p): 4 s = 7 credits, 6 s = 10, 8 s = 12, 10 s = 15. Each account gets 50 a day.
Never pay twice: a scene whose error starts with "${PAID}" exists in Flow already - fetch it with flow_recover, do not generate it again. flow_retry only redoes scenes that cost nothing.
Prompts are English, 3-6 sentences: subject and action -> setting -> ONE camera move (dolly, tracking, arc, crane) -> style -> "Audio: ..." -> "Avoid: text, letters, logo, watermark".
With "character" set, every scene must name the character and say "the character from the reference image"; all scenes then stay in one account when its balance allows, so the look matches.
If an account reports signed_out, the user must sign in to Google in that account's Chrome window; nothing else fixes it.`;

type Reading = { credits: number | null; signed_in: boolean; in_project: boolean; email?: string; error?: string };

async function readCredits(a: Account): Promise<Reading> {
  try {
    const { stdout } = await promisify(execFile)(process.execPath, [WORKER, "credits", a.project_url ?? "", "reload"], { env: accountEnv(a), timeout: 90_000, encoding: "utf8" });
    return JSON.parse(stdout.trim().split("\n").pop() ?? "{}") as Reading;
  } catch (err) {
    return { credits: null, signed_in: false, in_project: false, error: String(err instanceof Error ? err.message : err).split("\n")[0].slice(0, 160) };
  }
}

type AccountView = { id: string; email: string; state: "ready" | "busy" | "reading" | "disabled" | "signed_out" | "no_project" | "error"; credits: number | null; shares_credits_with?: string; note?: string };

// Balances for every enabled account, read in parallel. Each reading reloads the account's Flow tab first (an open tab
// shows a stale balance), which takes a few seconds each, so answers are reused for 30 minutes and a call never waits longer than
// SURVEY_MS: accounts still being read come back as "reading" and finish in the background for the next call.
const SURVEY_MS = 38_000;
const reading = new Map<string, Promise<void>>();
async function survey(refresh: boolean, only?: string[]): Promise<AccountView[]> {
  const accounts = loadAccounts().filter((a) => !only || only.includes(a.id));
  const cached = refresh ? {} : readCreditCache();
  for (const a of accounts) {
    if (!a.enabled || cached[a.id] || isBusy(a.id) || reading.has(a.id)) continue;
    reading.set(
      a.id,
      readCredits(a).then((r) => {
        writeCreditCache({ [a.id]: { ...r, at: Date.now() } });
        reading.delete(a.id);
      }),
    );
  }
  const started = Date.now();
  const mine = accounts.map((a) => reading.get(a.id)).filter((p): p is Promise<void> => Boolean(p));
  await Promise.race([Promise.all(mine), new Promise((r) => setTimeout(r, SURVEY_MS))]);
  // Only answers at least as new as this call count after a refresh.
  const cache = Object.fromEntries(Object.entries(readCreditCache()).filter(([, e]) => !refresh || e.at >= started));
  const fresh: Record<string, CreditEntry> = {};
  const firstByEmail = new Map<string, string>();
  return accounts.map((a) => {
    const e = fresh[a.id] ?? cache[a.id];
    // The address Flow itself shows wins over the one written in accounts.json.
    const email = e?.email || a.email || "?";
    const twin = email !== "?" ? firstByEmail.get(email.toLowerCase()) : undefined;
    if (a.enabled && email !== "?" && !twin) firstByEmail.set(email.toLowerCase(), a.id);
    const state: AccountView["state"] = !a.enabled ? "disabled" : isBusy(a.id) ? "busy" : reading.has(a.id) && !e ? "reading" : !e || e.error ? "error" : !e.signed_in ? "signed_out" : !e.in_project ? "no_project" : "ready";
    return { id: a.id, email, state, credits: a.enabled ? (e?.credits ?? null) : null, ...(twin ? { shares_credits_with: twin } : {}), ...(a.note || e?.error ? { note: a.note ?? e?.error } : {}) };
  });
}

const usable = (views: AccountView[]) => views.filter((v) => v.state === "ready" && !v.shares_credits_with && (v.credits ?? 0) > 0);

type Settings = Pick<WorkerTask, "output_dir" | "file_prefix" | "aspect_ratio" | "model" | "character">;
type CappedScene = Scene & { max_credits: number };

async function start(scenes: CappedScene[], settings: Settings, opts: { accounts?: string[]; dry_run: boolean; allow_partial: boolean; retry_of?: string }) {
  validateScenes(scenes);
  if (!isAbsolute(settings.output_dir)) throw new Error("output_dir must be an absolute path.");
  const views = await survey(false, opts.accounts);
  const waiting = views.filter((v) => v.state === "reading").map((v) => v.id);
  if (waiting.length) return { started: false, reason: `Still reading the balance of ${waiting.length} account(s) (${waiting.join(", ")}). Nothing was started; call again in about 20 s.` };
  const plan = planRun(scenes, usable(views).map((v) => ({ id: v.id, email: v.email, credits: v.credits! })));
  const summary = {
    plan: plan.assignments.map((a) => ({ account: a.account, scenes: a.scenes.map((s) => s.name), cost: a.cost })),
    total_cost: plan.assignments.reduce((n, a) => n + a.cost, 0),
    unplaced: plan.unplaced.map((s) => s.name),
    credits_available: usable(views).reduce((n, v) => n + (v.credits ?? 0), 0),
  };
  if (opts.dry_run) return { started: false, dry_run: true, ...summary };
  if (!plan.assignments.length || (plan.unplaced.length && !opts.allow_partial)) {
    return {
      started: false,
      reason: plan.assignments.length
        ? `Not enough credits for ${plan.unplaced.length} scene(s). Nothing was started. Pass allow_partial: true to make the rest now, shorten clips, or wait for the daily refill.`
        : "No account is ready with enough credits for even one scene. See flow_accounts.",
      ...summary,
      accounts: views,
    };
  }
  const run = `run-${new Date().toISOString().slice(5, 16).replace(/[-:T]/g, "")}-${randomUUID().slice(0, 4)}`;
  writeMeta({ run, kind: "generate", output_dir: settings.output_dir, created: new Date().toISOString(), unplaced: summary.unplaced, retry_of: opts.retry_of });
  const byId = new Map(loadAccounts().map((a) => [a.id, a]));
  for (const a of plan.assignments) launch("generate", byId.get(a.account)!, { run, account: a.account, project_url: byId.get(a.account)!.project_url, ...settings, scenes: a.scenes as CappedScene[] });
  return { started: true, run_id: run, ...summary, next: `Call flow_wait with run_id "${run}" until finished is true (a 6 s clip takes about 2-4 minutes).` };
}

function launch(mode: "generate" | "recover", account: Account, task: WorkerTask): void {
  const file = writeTask(task);
  const child = spawn(process.execPath, [WORKER, mode, file], { env: accountEnv(account), detached: true, stdio: "ignore" });
  child.unref();
  // Written here too, so flow_wait sees the run at once and can tell if the worker never came up.
  writeState({ run: task.run, account: task.account, pid: child.pid ?? 0, status: "running", scenes: task.scenes.map((s) => ({ name: s.name, status: "pending" })), updated: 0, log: [] });
  dropCreditCache(task.account);
}

function view(run: string) {
  const meta = readMeta(run);
  const states = runStates(run);
  const scenes = states.flatMap((s) => {
    // A worker that vanished mid-run may have approved clips that Flow is still making.
    const lost = s.status === "running" && !pidAlive(s.pid) && Date.now() - s.updated > 5000;
    return s.scenes.map((sc) => ({
      name: sc.name,
      account: s.account,
      status: lost && !["done", "failed", "not_started"].includes(sc.status) ? "failed" : sc.status,
      ...(sc.file ? { file: sc.file } : {}),
      ...(sc.credits !== undefined ? { credits: sc.credits } : {}),
      ...(lost && sc.status === "rendering"
        ? { error: `${PAID}: the worker stopped after approving this clip. It is in Flow: use flow_recover on account "${s.account}".` }
        : lost && sc.status !== "done" && sc.status !== "failed"
          ? { error: "interrupted: the worker stopped before this scene was approved; nothing was spent on it." }
          : sc.error
            ? { error: sc.error }
            : {}),
    }));
  });
  const finished = states.length > 0 && states.every((s) => s.status !== "running" || !pidAlive(s.pid));
  const problems = states.filter((s) => s.error).map((s) => ({ account: s.account, error: s.error }));
  return {
    run_id: run,
    finished,
    output_dir: meta?.output_dir,
    done: scenes.filter((s) => s.status === "done").length,
    failed: scenes.filter((s) => s.status === "failed" || s.status === "not_started").length,
    in_progress: scenes.filter((s) => ["pending", "requested", "rendering"].includes(s.status)).length,
    credits_spent: scenes.reduce((n, s) => n + (s.status === "done" || s.status === "rendering" || s.error?.startsWith(PAID) ? (s.credits ?? 0) : 0), 0),
    scenes,
    ...(meta?.unplaced.length ? { unplaced: meta.unplaced } : {}),
    ...(problems.length ? { account_errors: problems } : {}),
    ...(finished ? {} : { activity: states.filter((s) => s.status === "running").map((s) => `${s.account}: ${s.log.at(-1) ?? "starting"}`) }),
  };
}

const server = new McpServer({ name: "flow-pool", version: "1.0.0" }, { instructions: INSTRUCTIONS });
type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };
const reply = async (work: Promise<unknown>): Promise<ToolResult> => {
  try {
    return { content: [{ type: "text", text: JSON.stringify(await work) }] };
  } catch (err) {
    return { content: [{ type: "text", text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) }], isError: true };
  }
};

const sceneShape = z.object({
  name: z.string().describe("Short id, letters/digits/_/- only; the clip is saved as <file_prefix><name>.mp4."),
  prompt: z.string().min(1).describe("English prompt for one clip (see server instructions for the pattern)."),
  seconds: z.union([z.literal(4), z.literal(6), z.literal(8), z.literal(10)]).default(6),
  max_credits: z.number().int().min(1).optional().describe("Refuse (spend nothing) if Flow quotes more. Default: the known price for this length."),
});

server.registerTool(
  "flow_accounts",
  {
    title: "Flow accounts and credits",
    description:
      "List every Flow account with its credits and state (ready, busy, reading, signed_out, no_project, disabled, error) and the total usable credits. Answers are reused for 30 minutes; a first or refreshed reading reloads each Flow tab (about 10 s in all); an account still shown as reading is ready on the next call. Optional before flow_generate, which reads balances itself.",
    inputSchema: { refresh: z.boolean().default(false).describe("Read every balance again instead of using answers under 30 minutes old.") },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  ({ refresh }) =>
    reply(
      survey(refresh).then((accounts) => {
        const total = usable(accounts).reduce((n, v) => n + (v.credits ?? 0), 0);
        return { total_usable_credits: total, clips_possible: Object.fromEntries(Object.entries(COST).map(([s, c]) => [`${s}s`, usable(accounts).reduce((n, v) => n + Math.floor((v.credits ?? 0) / c), 0)])), accounts, accounts_file: ACCOUNTS_FILE };
      }),
    ),
);

server.registerTool(
  "flow_generate",
  {
    title: "Generate video clips across accounts",
    description:
      "Make one video clip per scene. The server splits scenes over accounts by their credits (one account when it fits, so a character looks the same), generates in parallel, and saves <output_dir>/<file_prefix><name>.mp4. Spends credits: Flow's own quote is checked against each scene's cap before approval. Returns a run_id at once; collect results with flow_wait. With dry_run it only returns the split and cost.",
    inputSchema: {
      output_dir: z.string().describe("Absolute folder for the clips."),
      scenes: z.array(sceneShape).min(1).max(60),
      character: z.string().optional().describe("Description of a recurring character. Its portrait is drawn first (free) in each account used and attached to every scene as a character reference."),
      aspect_ratio: z.enum(["9:16", "16:9"]).default("9:16"),
      model: z.string().default("Omni 1.1 Flash").describe("Video model as named in Flow. Costs and caps assume the default."),
      file_prefix: z.string().regex(/^[\w-]*$/).default(""),
      accounts: z.array(z.string()).optional().describe("Restrict to these account ids. Default: every ready account."),
      dry_run: z.boolean().default(false),
      allow_partial: z.boolean().default(false).describe("Start even when credits cover only some scenes; the rest are listed as unplaced."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  ({ scenes, accounts, dry_run, allow_partial, output_dir, ...rest }) =>
    reply(start(scenes.map((s) => ({ ...s, max_credits: s.max_credits ?? COST[s.seconds] })), { output_dir: resolve(output_dir), ...rest }, { accounts, dry_run, allow_partial })),
);

server.registerTool(
  "flow_wait",
  {
    title: "Wait for a run",
    description: `Wait for a run (default: the newest) and return each scene's status, file, credits and error. Returns within ${MAX_WAIT_S} s even if clips are still rendering: call again until finished is true.`,
    inputSchema: { run_id: z.string().optional(), timeout_seconds: z.number().int().min(0).max(MAX_WAIT_S).default(MAX_WAIT_S) },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  ({ run_id, timeout_seconds }) =>
    reply(
      (async () => {
        const run = run_id ?? listRuns(1)[0];
        if (!run || !runStates(run).length) throw new Error(run_id ? `No run "${run_id}". Recent runs: ${listRuns(5).join(", ") || "none"}.` : "No runs yet.");
        const deadline = Date.now() + timeout_seconds * 1000;
        while (Date.now() < deadline && !view(run).finished) await new Promise((r) => setTimeout(r, 2000));
        return view(run);
      })(),
    ),
);

server.registerTool(
  "flow_retry",
  {
    title: "Redo scenes that cost nothing",
    description: `Generate again the scenes of a run that failed without being charged or were never started (default: all such scenes of the newest run), on whichever accounts have credits now. Scenes marked "${PAID}" are skipped: they exist in Flow, use flow_recover. Returns a new run_id.`,
    inputSchema: { run_id: z.string().optional(), scenes: z.array(z.string()).optional().describe("Scene names to redo. Default: every unpaid failed scene."), allow_partial: z.boolean().default(false) },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  ({ run_id, scenes, allow_partial }) =>
    reply(
      (async () => {
        const run = run_id ?? listRuns(10).find((r) => readMeta(r)?.kind === "generate");
        if (!run) throw new Error("No generation run to retry.");
        const v = view(run);
        if (!v.finished) throw new Error(`Run ${run} is still working. Call flow_wait first.`);
        const again: CappedScene[] = [];
        const skipped: string[] = [];
        let settings: Settings | undefined;
        // An account that just turned a scene down is not asked again while others have credits.
        const refused = new Set(v.scenes.filter((sc) => sc.status === "failed" && !sc.error?.startsWith(PAID)).map((sc) => sc.account));
        for (const sc of v.scenes) {
          if (scenes ? !scenes.includes(sc.name) : sc.status === "done") continue;
          if (sc.status === "done" || sc.error?.startsWith(PAID)) {
            skipped.push(sc.name);
            continue;
          }
          const task = readTask(run, sc.account);
          const original = task?.scenes.find((s) => s.name === sc.name);
          if (!task || !original) continue;
          settings ??= { output_dir: task.output_dir, file_prefix: task.file_prefix, aspect_ratio: task.aspect_ratio, model: task.model, character: task.character };
          again.push(original);
        }
        if (!again.length || !settings) return { started: false, reason: "Nothing to redo in this run.", ...(skipped.length ? { skipped_paid_or_done: skipped } : {}) };
        const others = loadAccounts().map((a) => a.id).filter((id) => !refused.has(id));
        let out = (await start(again, settings, { accounts: others, dry_run: false, allow_partial, retry_of: run })) as { started: boolean };
        if (!out.started) out = (await start(again, settings, { dry_run: false, allow_partial, retry_of: run })) as { started: boolean };
        return { ...out, ...(skipped.length ? { skipped_paid_or_done: skipped } : {}) };
      })(),
    ),
);

server.registerTool(
  "flow_recover",
  {
    title: "Download clips Flow already holds",
    description:
      "Download the newest finished videos from one account's Flow project, free of credits, as <file_prefix>recovered-NN.mp4 (01 = newest). Use it for scenes that were paid for but not saved. Returns a run_id; collect with flow_wait, then rename the right file.",
    inputSchema: {
      account: z.string().describe("Account id, as shown on the failed scene."),
      output_dir: z.string().describe("Absolute folder for the files."),
      count: z.number().int().min(1).max(20).default(4),
      file_prefix: z.string().regex(/^[\w-]*$/).default(""),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  ({ account, output_dir, count, file_prefix }) =>
    reply(
      (async () => {
        const a = loadAccounts().find((x) => x.id === account);
        if (!a) throw new Error(`No account "${account}". See flow_accounts.`);
        if (!a.enabled) throw new Error(`Account "${account}" is disabled${a.note ? ` (${a.note})` : ""}.`);
        if (isBusy(account)) throw new Error(`Account "${account}" is busy with another run. Call flow_wait first.`);
        if (!isAbsolute(output_dir)) throw new Error("output_dir must be an absolute path.");
        const run = `recover-${new Date().toISOString().slice(5, 16).replace(/[-:T]/g, "")}-${randomUUID().slice(0, 4)}`;
        writeMeta({ run, kind: "recover", output_dir: resolve(output_dir), created: new Date().toISOString(), unplaced: [] });
        launch("recover", a, { run, account, project_url: a.project_url, output_dir: resolve(output_dir), file_prefix, aspect_ratio: "9:16", model: "", scenes: [], count });
        return { started: true, run_id: run, next: `Call flow_wait with run_id "${run}".` };
      })(),
    ),
);

await server.connect(new StdioServerTransport());
