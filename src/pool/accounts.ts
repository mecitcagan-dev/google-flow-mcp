import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { POOL_HOME } from "./store.js";

export type Account = {
  id: string;
  // The single-account profile folder (FLOW_MCP_HOME) and its Chrome remote-debugging port.
  home: string;
  cdp_port: number;
  email: string;
  project_url?: string;
  // false: never opened, never spent from. `note` says why.
  enabled: boolean;
  note?: string;
};

export const ACCOUNTS_FILE = join(POOL_HOME, "accounts.json");

// First run: one account per existing ~/.flow-mcp-<letter> profile (ports 9333 upwards in letter order, as those
// profiles were set up), with the email and project address from ~/.flow-mcp-projeler.json when that file exists.
function bootstrap(): Account[] {
  const home = homedir();
  const known = (() => {
    try {
      return JSON.parse(readFileSync(join(home, ".flow-mcp-projeler.json"), "utf8")) as Record<string, { url?: string; hesap?: string }>;
    } catch {
      return {};
    }
  })();
  const accounts: Account[] = readdirSync(home)
    .map((d) => d.match(/^\.flow-mcp-([a-z])$/)?.[1])
    .filter((l): l is string => Boolean(l))
    .sort()
    .map((letter) => ({
      id: letter,
      home: join(home, `.flow-mcp-${letter}`),
      cdp_port: 9333 + letter.charCodeAt(0) - 97,
      email: known[`flow${letter}`]?.hesap ?? "?",
      project_url: known[`flow${letter}`]?.url,
      enabled: true,
    }));
  if (existsSync(join(home, ".flow-mcp")) && !accounts.length) {
    accounts.push({ id: "main", home: join(home, ".flow-mcp"), cdp_port: 9333, email: "?", enabled: true });
  }
  return accounts;
}

export function loadAccounts(): Account[] {
  if (!existsSync(ACCOUNTS_FILE)) {
    mkdirSync(POOL_HOME, { recursive: true });
    writeFileSync(ACCOUNTS_FILE, JSON.stringify(bootstrap(), null, 2));
  }
  const list = JSON.parse(readFileSync(ACCOUNTS_FILE, "utf8")) as Account[];
  const ids = new Set<string>();
  for (const a of list) {
    if (!a.id || !a.home || !a.cdp_port) throw new Error(`${ACCOUNTS_FILE}: every account needs id, home and cdp_port.`);
    if (ids.has(a.id)) throw new Error(`${ACCOUNTS_FILE}: account id "${a.id}" appears twice.`);
    ids.add(a.id);
  }
  return list;
}

// The environment the single-account code (chrome.ts, flow.ts) reads at import time.
export const accountEnv = (a: Account): NodeJS.ProcessEnv => ({
  ...process.env,
  FLOW_MCP_HOME: a.home,
  FLOW_MCP_CDP_PORT: String(a.cdp_port),
  FLOW_POOL_ACCOUNT: a.id,
});
