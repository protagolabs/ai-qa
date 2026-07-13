import { chmod, cp } from "node:fs/promises";

await cp(
  new URL("../src/skills", import.meta.url),
  new URL("../dist/skills", import.meta.url),
  {
    recursive: true,
  },
);
await chmod(new URL("../dist/cli/main.js", import.meta.url), 0o755);
