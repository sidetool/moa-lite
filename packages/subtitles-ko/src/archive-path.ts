export function safeZipPath(name: string): boolean {
  return !!name && !/[\x00-\x1f]/.test(name) && !/^(?:[\\/]|[A-Za-z]:)/.test(name) &&
    !name.replace(/\\/g, "/").split("/").some(part => part === "..") &&
    !name.startsWith("__MACOSX/");
}
