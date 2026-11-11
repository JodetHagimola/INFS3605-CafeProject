// Compare the database snapshot before and after a cache lookup/generation.
// A concurrent inventory change cannot make an older brief a valid cache hit.
export async function withConsistentBrief<T>(input: {
  refresh?: boolean;
  fingerprint: () => Promise<string>;
  load: (fingerprint: string) => Promise<T | null>;
  generate: () => Promise<T>;
  save: (brief: T, fingerprint: string) => Promise<T>;
}): Promise<T> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const fingerprint = await input.fingerprint();
    const cached = input.refresh ? null : await input.load(fingerprint);
    if (cached !== null) {
      if (await input.fingerprint() === fingerprint) return cached;
      continue;
    }
    const brief = await input.generate();
    if (await input.fingerprint() !== fingerprint) continue;
    const saved = await input.save(brief, fingerprint);
    if (await input.fingerprint() === fingerprint) return saved;
  }
  throw new Error("Stock changed while the brief was being prepared. Please refresh again.");
}
