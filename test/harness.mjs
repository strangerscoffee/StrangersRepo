// Starts `wrangler dev` on a fresh local D1/R2 (in a temp dir) for the tests.
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const SETUP_CODE = "test-setup-code-0123456789abcdef0123456789abcdef";
const WRANGLER = join(ROOT, "node_modules", ".bin", "wrangler");

function freePort() {
  return new Promise((resolve) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

export async function startServer({ writeLimit, preSql, scheduled, vars = {} } = {}) {
  const state = mkdtempSync(join(tmpdir(), "kitchen-diary-test-"));
  // Optional SQL to run on the empty local database before the Worker starts (e.g. an older schema).
  if (preSql) {
    execFileSync(WRANGLER, ["d1", "execute", "kitchen-diary", "--local", "--persist-to", state, "--command", preSql], {
      cwd: ROOT, stdio: "pipe", env: { ...process.env, CI: "1" },
    });
  }
  const port = await freePort();
  const args = ["dev", "--local", "--port", String(port), "--ip", "127.0.0.1", "--persist-to", state,
    "--var", `SETUP_CODE:${SETUP_CODE}`, "--show-interactive-dev-session=false"];
  if (writeLimit) args.push("--var", `WRITE_LIMIT_PER_15_MIN:${writeLimit}`);
  // The admin section's own address is for the real site: here it's at /admin on the diary's (unless a test sets it).
  for (const [k, v] of Object.entries({ ADMIN_HOST: "", PREVIEW_HOST: "", ...vars })) args.push("--var", `${k}:${v}`);
  if (scheduled) args.push("--test-scheduled"); // GET /__scheduled runs the Worker's scheduled() handler
  const proc = spawn(WRANGLER, args, { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, CI: "1" } });
  let log = "";
  proc.stdout.on("data", (d) => (log += d));
  proc.stderr.on("data", (d) => (log += d));
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 60000;
  for (;;) {
    if (proc.exitCode != null) throw new Error("wrangler dev exited:\n" + log);
    try {
      const r = await fetch(base + "/robots.txt");
      if (r.ok) break;
    } catch {}
    if (Date.now() > deadline) throw new Error("wrangler dev didn't start:\n" + log);
    await new Promise((r) => setTimeout(r, 300));
  }
  return {
    base,
    log: () => log,
    /** Runs SQL on this server's local database and returns the rows (for checking schema and query plans). */
    sql(command) {
      const out = execFileSync(WRANGLER, ["d1", "execute", "kitchen-diary", "--local", "--persist-to", state, "--json", "--command", command], {
        cwd: ROOT, stdio: "pipe", env: { ...process.env, CI: "1" },
      }).toString();
      return JSON.parse(out)[0].results;
    },
    async stop() {
      proc.kill("SIGINT");
      await new Promise((r) => (proc.exitCode != null ? r() : proc.once("exit", r)));
      rmSync(state, { recursive: true, force: true });
    },
  };
}

/** Pages run on the server's clock (public/shared/core.js): for a test that needs "now" to be a set time, every
 *  response to this page or context says the server's time is `ms` (pin the device's clock too, with page.clock). */
export async function serverTimeIs(target, ms) {
  // Only the site's API answers (where pages read the server's time): routing the page itself would make Chromium
  // treat it as coming from elsewhere and refuse its live connection to this local server.
  await target.route("**/api/**", async (route) => {
    try {
      const res = await route.fetch();
      await route.fulfill({ response: res, headers: { ...res.headers(), "x-now": String(ms) } });
    } catch { /* the page closed while this was on its way */ }
  });
}
