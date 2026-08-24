import {
  CredentialInputError,
  PosixCredentialReader,
  StreamTtyReadSession,
  type CredentialTerminalOps,
} from "../../integrations/credentials.ts";

const ops: CredentialTerminalOps = {
  openTty: () => 0,
  duplicateFd: (fd) => ({ fd, owned: false }),
  close: () => undefined,
  write: (_fd, value) => {
    if (value.endsWith(":")) process.stderr.write("READY\n");
  },
  read: async () => 0,
  createTtySession: () => new StreamTtyReadSession(0, process.stdin),
  runStty: async (args) => ({ exitCode: 0, stdout: args[0] === "-g" ? "opaque-mode\n" : "" }),
  onSignal: (signal, handler) => { process.on(signal, handler); },
  offSignal: (signal, handler) => { process.off(signal, handler); },
};

try {
  await new PosixCredentialReader(ops).read("linear", { kind: "tty" });
  process.stdout.write('{"code":"unexpected_success"}\n');
} catch (error) {
  const code = error instanceof CredentialInputError ? error.code : "unexpected_error";
  process.stdout.write(`${JSON.stringify({ code })}\n`);
}
