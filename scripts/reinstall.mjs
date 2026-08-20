/**
 * Full reinstall: re-register the manifest with Raycast, then install a
 * production build.
 *
 * `ray build` writes the compiled bundle and package.json into
 * ~/.config/raycast/extensions/<name>/, but it does not tell Raycast to re-read
 * the manifest. Code changes therefore take effect immediately while changes to
 * `preferences` or `commands` do not — Raycast keeps serving the schema it
 * registered the last time `ray develop` ran. A renamed preference silently
 * keeps its old label, and a new one never appears at all.
 *
 * `ray develop` does re-register on startup, so this briefly runs it, waits for
 * the install directory to be rewritten, stops it, and then rebuilds for
 * production so no dev bundle is left installed.
 *
 * Only needed after editing package.json. Plain `npm run build` is fine for
 * source-only changes.
 */
import { spawn, execFileSync } from "child_process";
import { existsSync, statSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const INSTALL_DIR = join(
  homedir(),
  ".config/raycast/extensions/claudecast",
);
const MARKER = join(INSTALL_DIR, "usage-dashboard.js");
const PID_FILE = join(INSTALL_DIR, "cli.pid");

// How long to wait for `ray develop` to rewrite the install directory, and how
// long to let it settle afterwards before stopping it.
const REGISTER_TIMEOUT_MS = 60_000;
const SETTLE_MS = 3000;
const POLL_MS = 250;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mtime = (p) => (existsSync(p) ? statSync(p).mtimeMs : 0);

async function main() {
  const before = mtime(MARKER);
  console.log("Starting ray develop to re-register the manifest...");

  const dev = spawn("npx", ["ray", "develop"], {
    stdio: "ignore",
    detached: false,
  });

  let registered = false;
  const deadline = Date.now() + REGISTER_TIMEOUT_MS;
  try {
    while (Date.now() < deadline) {
      // Registration is done once the dev process has claimed the install
      // directory (cli.pid) and rewritten the bundle.
      if (existsSync(PID_FILE) && mtime(MARKER) > before) {
        registered = true;
        break;
      }
      if (dev.exitCode !== null) break;
      await sleep(POLL_MS);
    }

    if (registered) {
      await sleep(SETTLE_MS);
      console.log("Manifest re-registered.");
    }
  } finally {
    dev.kill("SIGINT");
    // Give it a moment to release cli.pid before the production build lands.
    await sleep(1000);
    if (dev.exitCode === null) dev.kill("SIGKILL");
  }

  if (!registered) {
    console.error(
      "Could not confirm re-registration. Run `npm run dev` manually, wait for\n" +
        "it to build, then stop it and run `npm run build`.",
    );
    process.exitCode = 1;
    return;
  }

  console.log("Installing production build...");
  execFileSync("npx", ["ray", "build", "-e", "dist"], { stdio: "inherit" });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
