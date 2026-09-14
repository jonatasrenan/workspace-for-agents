// Single source of truth for "where does state live" and "where does the program live".
//
// Every tool used to compute its own root from its own module's path
// (`path.resolve(dirname(import.meta.url), '..')`), ignoring any environment
// variable. That's harmless while everything runs from the same tree — it stops
// being harmless the moment the code runs from a parallel git worktree while the
// state lives in the main tree, which is the normal shape of two agents working
// the same task: each tool would keep reading/writing state next to its OWN
// source file instead of the root the caller meant, and the gate, the panel and
// the lint would silently read a trail torn in half.
//
// The two answers are kept separate on purpose: `costs.mjs` needs to record cost
// in an external WFA_ROOT while still reading the price table that ships with
// THIS installation of the program — collapsing the two into one root breaks that.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The directory above tools/ — for whoever needs a file that belongs to the
// program itself (the price table, the panel's assets), never the caller's state.
export const INSTALL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// WFA_ROOT resolved when set; this installation's root otherwise. Every tool that
// reads or writes state (repos/<repo>/..., workspace/<repo>/...) resolves its root
// through this function — never by computing it from its own module path.
export function stateRoot() {
  return process.env.WFA_ROOT ? path.resolve(process.env.WFA_ROOT) : INSTALL_ROOT;
}
