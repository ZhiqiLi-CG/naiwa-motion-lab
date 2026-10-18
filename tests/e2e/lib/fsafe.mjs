// Deleting folders that may hold links. The --head export holds a junction to the repository's node_modules, and a
// recursive delete that goes through it (as rmSync's can on Windows) wipes the real node_modules.
import { existsSync, lstatSync, readdirSync, realpathSync, rmdirSync, unlinkSync } from "node:fs";
import { join, sep } from "node:path";

/** Delete a folder tree without ever following a symlink or junction: links are removed themselves, only real
 *  folders are entered. Throws instead of deleting anything inside one of `keep` (real paths). */
export function removeTree(p, keep = []) {
  const guard = keep.filter((k) => existsSync(k)).map((k) => realpathSync(k).toLowerCase());
  const walk = (q) => {
    let st;
    try { st = lstatSync(q); } catch { return; }
    if (st.isSymbolicLink()) return unlinkLink(q);
    const real = realpathSync(q).toLowerCase();
    if (guard.some((g) => real === g || real.startsWith(g + sep) || real.startsWith(g + "/"))) throw new Error(`refusing to delete ${q}: it is inside ${real}`);
    if (st.isDirectory()) {
      for (const name of readdirSync(q)) walk(join(q, name));
      rmdirSync(q);
    } else unlinkSync(q);
  };
  walk(p);
}

/** Remove a symlink or junction itself (never its target); nothing when p is not a link. */
export function unlinkLink(p) {
  let st;
  try { st = lstatSync(p); } catch { return; }
  if (!st.isSymbolicLink()) return;
  try { unlinkSync(p); } catch { rmdirSync(p); }
}
