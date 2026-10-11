/** TTY prompts. Copied into consumers. */
import * as clack from "@clack/prompts";

export { isInteractive } from "./interactive.mjs";

export function bailIfCancel(value) {
  if (clack.isCancel(value)) {
    clack.cancel("Aborted");
    process.exit(0);
  }
  return value;
}

export async function select(opts) {
  return bailIfCancel(await clack.select(opts));
}

export async function multiselect(opts) {
  return bailIfCancel(await clack.multiselect(opts));
}

export async function confirm(opts) {
  return bailIfCancel(await clack.confirm(opts));
}

export async function text(opts) {
  return bailIfCancel(await clack.text(opts));
}

export async function password(opts) {
  return bailIfCancel(await clack.password(opts));
}

export function spinner() {
  return clack.spinner();
}
