import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.FLOW_POOL_HOME = mkdtempSync(join(tmpdir(), "flow-pool-"));
const store = await import("../dist/pool/store.js");

test("a lock held by a live process blocks; a dead one is taken over", () => {
  assert.equal(store.lockAccount("a", process.pid), true);
  assert.equal(store.isBusy("a"), true);
  assert.equal(store.lockAccount("a", process.pid), false);
  store.unlockAccount("a", 1);
  assert.equal(store.isBusy("a"), true, "another pid cannot release it");
  store.unlockAccount("a", process.pid);
  assert.equal(store.isBusy("a"), false);
  // 2^22 + 1 is above the default pid range on macOS and Linux, so nothing owns it.
  assert.equal(store.lockAccount("b", 4194305), true);
  assert.equal(store.isBusy("b"), false);
  assert.equal(store.lockAccount("b", process.pid), true);
});

test("worker state round-trips and is listed under its run", () => {
  store.writeState({ run: "r1", account: "a", pid: 1, status: "running", scenes: [{ name: "hook", status: "pending" }], updated: 0, log: [] });
  store.writeTask({ run: "r1", account: "a", output_dir: "/tmp/x", file_prefix: "", aspect_ratio: "9:16", model: "m", scenes: [] });
  const s = store.readState("r1", "a");
  assert.equal(s.scenes[0].name, "hook");
  assert.ok(s.updated > 0);
  assert.equal(store.runStates("r1").length, 1, "the task file is not mistaken for a state file");
  assert.deepEqual(store.listRuns(), ["r1"]);
  assert.equal(store.readTask("r1", "a").output_dir, "/tmp/x");
});

test("credit answers past their time limit are dropped", () => {
  const now = Date.now();
  store.writeCreditCache({
    fresh: { credits: 50, signed_in: true, in_project: true, at: now },
    stale: { credits: 50, signed_in: true, in_project: true, at: now - store.CREDIT_TTL_MS - 1 },
  });
  assert.deepEqual(Object.keys(store.readCreditCache(now)), ["fresh"]);
  store.dropCreditCache("fresh");
  assert.deepEqual(Object.keys(store.readCreditCache(now)), []);
});
