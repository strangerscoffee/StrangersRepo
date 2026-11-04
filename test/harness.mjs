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
  for (const [k, v] of Object.entries(vars)) args.push("--var", `${k}:${v}`);
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
    async stop() {
      proc.kill("SIGINT");
      await new Promise((r) => (proc.exitCode != null ? r() : proc.once("exit", r)));
      rmSync(state, { recursive: true, force: true });
    },
  };
}
