import { homedir } from "node:os";

export interface CliContext {
  cwd: string;
  env: NodeJS.ProcessEnv;
  homeDir: string;
  now: () => Date;
  readStdin: () => Promise<string>;
  writeStdout: (value: string) => void;
  writeStderr: (value: string) => void;
}

async function readProcessStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    if (Buffer.isBuffer(chunk)) {
      chunks.push(Buffer.from(chunk));
    } else {
      chunks.push(Buffer.from(String(chunk)));
    }
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function createDefaultContext(): CliContext {
  return {
    cwd: process.cwd(),
    env: process.env,
    homeDir: homedir(),
    now: () => new Date(),
    readStdin: readProcessStdin,
    writeStdout: (value) => process.stdout.write(value),
    writeStderr: (value) => process.stderr.write(value),
  };
}
