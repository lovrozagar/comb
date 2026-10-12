/** TTY / CI / --yes probe. Copied into consumers; no clack. */
export function isInteractive({
  argv = process.argv.slice(2),
  env = process.env,
  stdin = process.stdin,
  stdout = process.stdout,
} = {}) {
  if (!stdin?.isTTY || !stdout?.isTTY) return false;
  const ci = env.CI;
  if (ci != null && ci !== "" && ci !== "0" && ci !== "false") return false;
  for (const a of argv) {
    if (a === "--yes" || a === "-y" || a === "--non-interactive") return false;
  }
  return true;
}
