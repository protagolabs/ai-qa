import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { z } from "zod";
import { atomicWriteFile } from "../../core/fs/atomic-write.js";
import type { RepositoryIdentity } from "./repository-identity.js";

const trustFileSchema = z.object({
  schemaVersion: z.literal(1),
  entries: z.array(
    z.object({
      canonicalPath: z.string(),
      fingerprint: z.string().length(64),
      confirmedAt: z.string().datetime(),
    }),
  ),
});

type TrustFile = z.infer<typeof trustFileSchema>;

export class TrustStore {
  constructor(private readonly aiQaHome: string) {}

  private get path(): string {
    return join(this.aiQaHome, "trust.json");
  }

  private async read(): Promise<TrustFile> {
    try {
      return trustFileSchema.parse(
        JSON.parse(await readFile(this.path, "utf8")),
      );
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { schemaVersion: 1, entries: [] };
      }
      throw error;
    }
  }

  async trust(identity: RepositoryIdentity, confirmedAt: Date): Promise<void> {
    await mkdir(this.aiQaHome, { recursive: true, mode: 0o700 });
    const release = await lockfile.lock(this.aiQaHome, {
      realpath: false,
      retries: {
        retries: 15,
        minTimeout: 10,
        maxTimeout: 1_000,
        randomize: true,
      },
    });
    try {
      const current = await this.read();
      const entry = {
        canonicalPath: identity.canonicalPath,
        fingerprint: identity.fingerprint,
        confirmedAt: confirmedAt.toISOString(),
      };
      const entries = current.entries.filter(
        (value) => value.canonicalPath !== identity.canonicalPath,
      );
      await atomicWriteFile(
        this.path,
        `${JSON.stringify(
          { schemaVersion: 1, entries: [...entries, entry] },
          null,
          2,
        )}\n`,
      );
    } finally {
      await release();
    }
  }

  async isTrusted(identity: RepositoryIdentity): Promise<boolean> {
    const current = await this.read();
    return current.entries.some(
      (entry) =>
        entry.canonicalPath === identity.canonicalPath &&
        entry.fingerprint === identity.fingerprint,
    );
  }
}
