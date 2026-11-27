import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { ROOT, SETUP_CODE, startServer } from "./harness.mjs";

export async function startPasskeyServer() {
  const source = join(ROOT, "wrangler.jsonc");
  const { config } = ts.parseConfigFileTextToJson(source, await readFile(source, "utf8"));
  const temp = await mkdtemp(join(tmpdir(), "strangers-passkeys-"));
  const path = join(temp, "wrangler.json");
  // Keep the real worker and assets, but let Wrangler pass through the browser's localhost origin.
  delete config.$schema;
  delete config.routes;
  config.dev = { upstream_protocol: "http" };
  config.main = join(ROOT, config.main);
  config.assets.directory = join(ROOT, config.assets.directory);
  config.build.cwd = ROOT;
  await writeFile(path, JSON.stringify(config));
  try {
    const server = await startServer({
      config: path, readyPath: "/robots.txt", writeLimit: 2000,
      vars: { SETUP_CODE, ADMIN_HOST: "", COOKIE_DOMAIN: "", PREVIEW_HOST: "", STAFF_PASSKEYS_LOCAL: "1" },
    });
    return {
      ...server,
      origin: server.base.replace("127.0.0.1", "localhost"),
      async stop() {
        try { await server.stop(); } finally { await rm(temp, { recursive: true, force: true }); }
      },
    };
  } catch (error) {
    await rm(temp, { recursive: true, force: true });
    throw error;
  }
}
