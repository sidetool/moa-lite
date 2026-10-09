export function openArchive(factory: any, input: Uint8Array, limits: { maxBytes: number; maxEntries: number }, options?: Record<string, unknown>): Promise<{
  files: { name: string; size: number; regular: boolean }[];
  read(index: number): Uint8Array;
}>;
