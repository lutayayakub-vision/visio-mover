import { spawn } from "node:child_process";
import puppeteer from "puppeteer-core";

export async function startVite(port = 5199) {
  const proc = spawn("npx", ["vite", "--port", String(port), "--strictPort", "--host", "127.0.0.1"], { cwd: new URL("..", import.meta.url).pathname, stdio: "ignore" });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(base + "/tests/harness/image.html")).ok) return { base, stop: () => proc.kill("SIGTERM") }; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  proc.kill("SIGTERM");
  throw new Error("vite dev server did not start");
}

export async function launch(extraArgs = []) {
  return puppeteer.launch({
    executablePath: process.env.CHROME_PATH || "/usr/bin/google-chrome",
    headless: true,
    args: ["--no-sandbox", "--disable-gpu", "--autoplay-policy=no-user-gesture-required", ...extraArgs],
  });
}
