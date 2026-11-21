import { expect, test } from "bun:test";

const scenarios = ["resume-restored-race", "resume-duplicate-restoration", "resume-cleanup-race", "claude-retirement", "resume-start-failure"];
for (const scenario of [...scenarios, ...Array.from({ length: 7 }, () => "resume-restored-race")]) {
  test(`isolated host lifecycle: ${scenario}`, async () => {
    const path = new URL(`./session-lifecycle-cases/${scenario}.case.ts`, import.meta.url).pathname;
    const child = Bun.spawn([process.execPath, "test", path], { stdout: "pipe", stderr: "pipe" });
    const timeout = setTimeout(() => child.kill(), 15000);
    try {
      const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      if (code !== 0) console.error(stdout, stderr);
      expect(code).toBe(0);
    } finally { clearTimeout(timeout); child.kill(); }
  }, 20000);
}
