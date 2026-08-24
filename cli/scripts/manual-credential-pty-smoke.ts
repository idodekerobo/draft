#!/usr/bin/env bun
// Manual-only PTY smoke: interrupt the hidden prompt, then verify terminal echo was restored.

import { closeSync, openSync } from "fs";
import { CredentialInputError, credentialReader } from "../src/integrations/credentials.ts";

if (process.argv.includes("--help")) {
  console.log("Usage: bun cli/scripts/manual-credential-pty-smoke.ts");
  console.log("Run in a controlling terminal, then press Ctrl-C at the Linear API key prompt.");
  process.exit(0);
}

console.log("Press Ctrl-C at the hidden Linear API key prompt.");
try {
  await credentialReader.read("linear", { kind: "tty" });
  console.error("Expected an interrupt; rerun the smoke test and press Ctrl-C.");
  process.exitCode = 1;
} catch (error) {
  if (!(error instanceof CredentialInputError) || error.code !== "interrupted") {
    console.error("The prompt did not return the expected interrupted result.");
    process.exitCode = 1;
  } else {
    let fd: number | undefined;
    try {
      fd = openSync("/dev/tty", "r+");
      const inspect = async () => {
        const child = Bun.spawn({ cmd: ["/bin/stty", "-a"], stdin: fd!, stdout: "pipe", stderr: "ignore" });
        const [settings, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited]);
        return { settings, exitCode };
      };
      let result = await inspect();
      if (result.exitCode !== 0 || /(^|[;\s])-echo([;\s]|$)/.test(result.settings)) {
        const recovery = Bun.spawn({ cmd: ["/bin/stty", "echo"], stdin: fd, stdout: "ignore", stderr: "ignore" });
        await recovery.exited;
        result = await inspect();
      }
      if (result.exitCode === 0 && !/(^|[;\s])-echo([;\s]|$)/.test(result.settings)) {
        console.log("PASS: terminal echo is enabled after Ctrl-C.");
      } else {
        console.error("FAIL: terminal echo remained disabled after recovery.");
        process.exitCode = 1;
      }
    } catch {
      console.error("FAIL: could not inspect the controlling terminal.");
      process.exitCode = 1;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
}
