#!/usr/bin/env node
// One account's hands. The pool server starts this as a separate process with FLOW_MCP_HOME and FLOW_MCP_CDP_PORT set
// to one account's Chrome profile, because chrome.ts and flow.ts read those once when they are loaded.
//   node worker.js credits <project_url|""> [reload] -> one JSON line on stdout
//   node worker.js generate <task.json>       -> progress in ~/.flow-mcp-pool/runs/<run>/<account>.json
//   node worker.js recover <task.json>        -> same, downloading clips Flow already holds
// Generation goes through Flow's agent panel, in plain sentences: the composer's own controls changed too often.
import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { basename, join } from "node:path";
import type { Page } from "playwright-core";
import { getFlowPage, inEnglish } from "../chrome.js";
import { downloadMedia } from "../flow.js";
import { lockAccount, unlockAccount, writeCreditCache, writeState, type SceneState, type WorkerState, type WorkerTask } from "./store.js";

const APPROVAL_TIMEOUT_MS = 150_000;
const RENDER_TIMEOUT_MS = 15 * 60_000;
const IDLE_TIMEOUT_MS = 180_000;

type Tile = { id?: string; kind: "video" | "image" | "other"; error: boolean; busy: boolean };

// Every tile in the grid, newest first. A video at rest has no media id and is known by its title (see flow.ts).
const readTiles = (page: Page): Promise<Tile[]> =>
  page.evaluate(() =>
    [...document.querySelectorAll("flow-grid-tile-container")].map((t) => {
      const media = t.querySelector("img[data-media-id], video[data-media-id], img[src], video[src]");
      const label = t.getAttribute("aria-label");
      const id =
        (media && (media.getAttribute("data-media-id") || media.getAttribute("src")?.match(/[0-9a-f]{8}-[0-9a-f-]{27}/)?.[0])) ||
        (label ? `title:${label}` : undefined);
      const video = Boolean(t.querySelector("flow-video-tile"));
      return {
        id,
        kind: video ? ("video" as const) : t.querySelector("flow-image-tile") ? ("image" as const) : ("other" as const),
        error: Boolean(t.querySelector("flow-error-tile")),
        busy: /\d+%/.test((t as HTMLElement).innerText) || (video && !t.querySelector('img[alt="Generated video thumbnail"], video')),
      };
    }),
  );

// The tiles made since `before` was taken: everything above the first tile that was already there. Stills (the
// character portrait) are not clips and are left out; a failed tile keeps its place so the order still lines up.
function clipSlots(tiles: Tile[], before: Set<string>): Tile[] {
  const fresh: Tile[] = [];
  for (const t of tiles) {
    if (t.id && before.has(t.id)) break;
    if (t.kind !== "image" || t.error) fresh.push(t);
  }
  return fresh.reverse();
}

// The balance lives in Flow's account panel. flow.ts's getFlowState reads it too, but then waits 30 s for a composer
// button Flow no longer has, so the panel is read here directly. That panel also holds "Sign out": nothing else in it
// is ever touched.
async function readBalance(page: Page): Promise<number | undefined> {
  const close = async () => {
    await page.keyboard.press("Escape").catch(() => {});
    const x = page.getByRole("button", { name: "Close account panel" });
    if (await x.isVisible().catch(() => false)) await x.click({ timeout: 5000 }).catch(() => {});
  };
  await close();
  await page.evaluate(() => document.querySelectorAll(".page-container").forEach((e) => (e.scrollTop = 0))).catch(() => {});
  try {
    await page.getByRole("button", { name: "Account details" }).click({ timeout: 8000 });
    const link = page.getByRole("link", { name: /Google Flow credits?/i });
    await link.waitFor({ state: "visible", timeout: 8000 });
    const n = Number((await link.innerText()).replace(/[^\d]/g, ""));
    return Number.isNaN(n) ? undefined : n;
  } catch {
    return undefined;
  } finally {
    await close();
    await page.waitForTimeout(300);
  }
}

async function reloadProject(page: Page): Promise<void> {
  if (!/\/project\//.test(page.url())) return;
  await page.goto(inEnglish(page.url()), { waitUntil: "domcontentloaded" }).catch(() => {});
  await page.getByRole("button", { name: "Account details" }).waitFor({ state: "visible", timeout: 20_000 }).catch(() => {});
  await page.waitForTimeout(1500);
}

async function openProject(page: Page, projectUrl?: string): Promise<void> {
  if (/\/about|accounts\.google\.com/.test(page.url())) throw new Error("signed_out: this account is not signed in to Google in its Flow Chrome window.");
  if (projectUrl && !page.url().startsWith(projectUrl.split("?")[0])) {
    await page.goto(inEnglish(projectUrl.split("?")[0]), { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(4000);
  }
  if (/\/about|accounts\.google\.com/.test(page.url())) throw new Error("signed_out: this account is not signed in to Google in its Flow Chrome window.");
  if (!/\/project\//.test(page.url())) throw new Error("no_project: no Flow project is open and the account has no project_url in accounts.json.");
}

// A tab left open shows the balance from when it loaded: it misses the daily refill and anything a second profile of
// the same Google account spent (seen 13 Nov 2026: 50 shown, 15 real). `reload` loads the page again first.
async function credits(projectUrl?: string, reload = false): Promise<void> {
  const out: { credits: number | null; signed_in: boolean; in_project: boolean; url?: string; email?: string; error?: string } = { credits: null, signed_in: false, in_project: false };
  try {
    const page = await getFlowPage();
    await openProject(page, projectUrl).catch(() => {});
    if (reload) await reloadProject(page);
    const url = page.url();
    out.signed_in = !/\/about|accounts\.google\.com/.test(url);
    out.in_project = /\/project\//.test(url);
    out.url = url.split("?")[0];
    if (out.in_project) out.credits = (await readBalance(page)) ?? null;
    if (out.in_project && out.credits === null) out.error = "Could not read the balance from Flow's account panel.";
    // The signed-in address, read from the page: the one in accounts.json is only what someone wrote down.
    out.email = await page
      .evaluate(() => [...document.querySelectorAll("[aria-label],img[alt]")].map((e) => e.getAttribute("aria-label") || e.getAttribute("alt") || "").find((t) => /@/.test(t))?.match(/[\w.+-]+@[\w.-]+/)?.[0])
      .catch(() => undefined);
  } catch (err) {
    out.error = String(err instanceof Error ? err.message : err).split("\n")[0].slice(0, 160);
  }
  // Written from here as well, so the answer is kept even when the server that asked has stopped waiting.
  if (process.env.FLOW_POOL_ACCOUNT) writeCreditCache({ [process.env.FLOW_POOL_ACCOUNT]: { ...out, at: Date.now() } });
  console.log(JSON.stringify(out));
}

async function run(mode: "generate" | "recover", task: WorkerTask): Promise<void> {
  const state: WorkerState = {
    run: task.run,
    account: task.account,
    pid: process.pid,
    status: "running",
    scenes: task.scenes.map((s) => ({ name: s.name, status: "pending" })),
    updated: 0,
    log: [],
  };
  const save = () => writeState(state);
  const log = (line: string) => {
    state.log.push(`${new Date().toTimeString().slice(0, 8)} ${line}`);
    state.log = state.log.slice(-40);
    save();
  };
  if (!lockAccount(task.account, process.pid)) {
    state.status = "failed";
    state.error = "busy: another run is driving this account's Flow tab.";
    state.scenes.forEach((s) => (s.status = "not_started"));
    return save();
  }
  save();
  try {
    const page = await getFlowPage();
    await openProject(page, task.project_url);
    mkdirSync(task.output_dir, { recursive: true });
    if (mode === "recover") await recover(page, task, state, log);
    else await generate(page, task, state, log);
    // The balance Flow shows now is the honest record of what the run cost.
    // After downloads the page can be left in a tile's view, where the account button is not shown: load the grid again.
    await reloadProject(page);
    const after = await readBalance(page);
    if (after !== undefined) {
      state.credits_after = after;
      writeCreditCache({ [task.account]: { credits: after, signed_in: true, in_project: true, at: Date.now() } });
    }
    state.status = state.scenes.some((s) => s.status === "done") || !state.scenes.length ? "done" : "failed";
  } catch (err) {
    state.status = "failed";
    state.error = String(err instanceof Error ? err.message : err).split("\n")[0];
    for (const s of state.scenes) if (s.status === "pending") s.status = "not_started";
  } finally {
    unlockAccount(task.account, process.pid);
    save();
  }
}

// A file already under this name is a clip someone paid for: it is moved aside, never overwritten.
function keepOld(dir: string, stem: string): void {
  for (const ext of [".mp4", ".webm", ".mov"]) {
    const file = join(dir, stem + ext);
    if (!existsSync(file)) continue;
    mkdirSync(join(dir, "_replaced"), { recursive: true });
    renameSync(file, join(dir, "_replaced", `${stem}-${Date.now()}${ext}`));
  }
}

async function fetchClip(page: Page, id: string, dir: string, stem: string): Promise<string> {
  keepOld(dir, stem);
  const files = await downloadMedia(page, id, join(dir, stem));
  const clip = files.find((f) => /\.(mp4|webm|mov)$/i.test(f));
  if (!clip) throw new Error(`Flow handed back ${files.map((f) => basename(f)).join(", ") || "nothing"} instead of a video.`);
  return clip;
}

async function generate(page: Page, task: WorkerTask, state: WorkerState, log: (l: string) => void): Promise<void> {
  const composer = page.locator('[aria-label="What do you want to create?"], [placeholder="What do you want to create?"], [contenteditable="true"]').last();
  const send = page.getByRole("button", { name: "Start generation" });
  const approvals = page.getByRole("radio", { name: "Approve", exact: true });
  const shape = task.aspect_ratio === "9:16" ? "9:16 vertical" : "16:9 horizontal";

  // The agent takes a new message only when its send button is back.
  const idle = async () => {
    const deadline = Date.now() + IDLE_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (await send.isVisible().catch(() => false)) return;
      await page.waitForTimeout(2000);
    }
    throw new Error("Flow's agent stayed busy for 3 minutes and took no new request.");
  };
  const say = async (text: string) => {
    await idle();
    await composer.click();
    await page.keyboard.insertText(text);
    await page.waitForTimeout(500);
    await send.click();
  };

  const before = new Set((await readTiles(page)).map((t) => t.id).filter((id): id is string => Boolean(id)));

  if (task.character) {
    log("character portrait requested");
    await say(`Generate ONE image only (no video), with the free image model, ${shape}: ${task.character}`);
    await page.waitForTimeout(8000);
    await idle();
  }

  let approved = 0;
  for (const [i, scene] of task.scenes.entries()) {
    const mine = state.scenes[i];
    try {
      const asked = await approvals.count();
      mine.status = "requested";
      log(`requested: ${scene.name}`);
      await say(
        `New request. Generate one VIDEO: model ${task.model}, 720p, ${shape}, ${scene.seconds} seconds, one output.` +
          (task.character
            ? " Use the character image you generated at the start of this session as a CHARACTER REFERENCE (ingredient, keep the exact look; NOT the start frame)."
            : " Text-to-video only, no start frame, no image.") +
          ` Use this prompt exactly: ${scene.prompt}`,
      );
      const deadline = Date.now() + APPROVAL_TIMEOUT_MS;
      const askedAt = Date.now();
      while ((await approvals.count()) <= asked) {
        if (Date.now() > deadline) throw new Error("Flow's agent never asked for approval (it may be slow, or its panel changed).");
        await page.waitForTimeout(2000);
        // The agent sometimes answers with something other than a price to approve (seen 13 Nov 2026: with 8 credits
        // left it offered 360p or an upgrade instead of the 7-credit clip). Once it has stopped talking with no
        // approval on screen, waiting longer changes nothing: report what it said.
        if (Date.now() - askedAt > 10_000 && (await send.isVisible().catch(() => false))) {
          await page.waitForTimeout(3000);
          if ((await approvals.count()) > asked) break;
          const panel = await page.locator("flow-agent-panel").innerText().catch(() => "");
          const said = (panel.split(scene.prompt.slice(-40)).pop() ?? "").replace(/\b(thumb_up|thumb_down|content_copy|flag|radio_button_unchecked|add|article_spark|tune|arrow_forward)\b|What do you want to create\?/g, " ").replace(/\s+/g, " ").trim();
          throw new Error(`agent_declined: Flow's agent did not offer this clip for approval. Nothing spent. It said: "${said.slice(0, 300)}"`);
        }
      }
      const quoteText = await page.evaluate(
        () => [...document.querySelectorAll("*")].filter((e) => /\d+\s*credits?/i.test(e.textContent ?? "") && e.children.length < 3).map((e) => e.textContent ?? "").pop() ?? "",
      );
      const quote = Number(quoteText.match(/(\d+)\s*credits?/i)?.[1] ?? NaN);
      // Also refuses when the quote could not be read at all (NaN): never approve a price nobody saw.
      if (!(quote <= scene.max_credits)) throw new Error(`quote_over_cap: Flow quoted ${Number.isNaN(quote) ? "an unreadable amount" : `${quote} credits`}, the cap is ${scene.max_credits}. Not approved, nothing spent.`);
      await approvals.last().click();
      mine.credits = quote;
      mine.status = "rendering";
      approved++;
      log(`approved: ${scene.name}, ${quote} credits`);
      // The next request goes out only once this clip's tile exists, so tiles appear in scene order.
      const tileBy = Date.now() + 60_000;
      while (Date.now() < tileBy && clipSlots(await readTiles(page), before).length < approved) await page.waitForTimeout(2000);
    } catch (err) {
      // Stop asking, but do not abandon the clips already approved and paid for: they are still collected below.
      mine.status = "failed";
      mine.error = String(err instanceof Error ? err.message : err).split("\n")[0];
      for (const later of state.scenes.slice(i + 1)) later.status = "not_started";
      log(`stopped at ${scene.name}: ${mine.error}`);
      break;
    }
  }
  if (!approved) return;

  let slots: Tile[] = [];
  const deadline = Date.now() + RENDER_TIMEOUT_MS;
  while (Date.now() < deadline) {
    slots = clipSlots(await readTiles(page), before);
    if (slots.length >= approved && slots.every((t) => t.error || (t.kind === "video" && !t.busy))) break;
    writeState(state);
    await page.waitForTimeout(10_000);
  }
  // Titles of freshly finished videos can still change for a moment; read once more after a pause.
  await page.waitForTimeout(4000);
  slots = clipSlots(await readTiles(page), before);

  const rendering = state.scenes.filter((s) => s.status === "rendering");
  const certain = slots.length === rendering.length;
  if (!certain) log(`Flow shows ${slots.length} new clip tile(s) for ${rendering.length} approved scene(s); files are matched in order and should be checked.`);
  for (const [k, scene] of rendering.entries()) {
    const slot = slots[k];
    if (!slot) {
      Object.assign(scene, { status: "failed", error: "No tile appeared for this scene in time. It may still finish in Flow: flow_recover fetches it without spending again." });
    } else if (slot.error) {
      Object.assign(scene, { status: "failed", credits: 0, error: "Flow failed this render (its tile says so) and did not charge for it." });
    } else if (slot.busy || !slot.id) {
      Object.assign(scene, { status: "failed", error: "Still rendering when the wait ended. It is paid for: use flow_recover later, do not generate it again." });
    } else {
      try {
        scene.file = await fetchClip(page, slot.id, task.output_dir, task.file_prefix + scene.name);
        scene.status = "done";
        if (!certain) scene.error = "order_uncertain: check that this file shows this scene.";
        log(`saved: ${scene.file}`);
      } catch (err) {
        Object.assign(scene, { status: "failed", error: `Made and paid for, but the download failed (${String(err instanceof Error ? err.message : err).split("\n")[0]}). Use flow_recover, do not generate it again.` });
      }
    }
    writeState(state);
  }
}

// Clips Flow already holds, newest first, at no cost: the way back from "paid for but no file".
async function recover(page: Page, task: WorkerTask, state: WorkerState, log: (l: string) => void): Promise<void> {
  const ready = (await readTiles(page)).filter((t) => t.kind === "video" && !t.busy && !t.error && t.id).slice(0, task.count ?? 6);
  const failed = (await readTiles(page)).filter((t) => t.error).length;
  if (failed) log(`${failed} failed tile(s) in this project (Flow did not charge for them).`);
  for (const [k, tile] of ready.entries()) {
    const scene: SceneState = { name: `${task.file_prefix}recovered-${String(k + 1).padStart(2, "0")}`, status: "pending" };
    state.scenes.push(scene);
    try {
      scene.file = await fetchClip(page, tile.id!, task.output_dir, scene.name);
      scene.status = "done";
    } catch (err) {
      Object.assign(scene, { status: "failed", error: String(err instanceof Error ? err.message : err).split("\n")[0] });
    }
    writeState(state);
  }
}

const [mode, arg] = process.argv.slice(2);
if (mode === "credits") await credits(arg || undefined, process.argv[4] === "reload");
else if (mode === "generate" || mode === "recover") await run(mode, JSON.parse(readFileSync(arg, "utf8")) as WorkerTask);
else console.error("usage: worker.js credits [project_url] | generate <task.json> | recover <task.json>");
// The CDP connection would keep the process alive; the Chrome window itself stays open.
process.exit(0);
