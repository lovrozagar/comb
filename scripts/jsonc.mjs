/** Dependency-free JSONC helpers. The published CLI imports this, so keep it to node builtins. */

export function stripJsonc(text) {
  return String(text ?? "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
}
