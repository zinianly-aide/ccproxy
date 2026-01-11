import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function expandHome(input: string): string {
  if (!input) return input;
  if (input === "~") return os.homedir();
  if (input.startsWith("~/")) return path.join(os.homedir(), input.slice(2));
  return input;
}

export function resolveWithinRoot(root: string, target: string): {
  path: string;
  exists: boolean;
} {
  const rootReal = fs.realpathSync(expandHome(root));
  const candidate = path.resolve(rootReal, target);
  const rootPrefix = rootReal.endsWith(path.sep)
    ? rootReal
    : rootReal + path.sep;

  if (!(candidate === rootReal || candidate.startsWith(rootPrefix))) {
    throw new Error(`Path escapes repo root: ${target}`);
  }

  let resolved = candidate;
  let exists = false;
  try {
    resolved = fs.realpathSync(candidate);
    exists = true;
  } catch {
    exists = false;
  }

  if (exists && !(resolved === rootReal || resolved.startsWith(rootPrefix))) {
    throw new Error(`Path resolves outside repo root: ${target}`);
  }

  return { path: exists ? resolved : candidate, exists };
}

export function resolveRepoDir(root: string, repo: string): string {
  const { path: resolved, exists } = resolveWithinRoot(root, repo);
  if (!exists) {
    throw new Error(`Repo not found: ${repo}`);
  }
  const stat = fs.statSync(resolved);
  if (!stat.isDirectory()) {
    throw new Error(`Repo is not a directory: ${repo}`);
  }
  return resolved;
}
