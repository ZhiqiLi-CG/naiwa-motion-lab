/** "我的舞蹈": analysed uploads kept in this browser (IndexedDB), landmarks packed into one Float32Array each. */
import type { Track } from "./track";

const DB = "naiwa-motion";
const STORE = "dances";
const PER_FRAME = 2 * 33 * 4;

interface Stored {
  id: string;
  name: string;
  nameEn?: string;
  fps: number;
  duration: number;
  aspect: number;
  source: Track["source"];
  savedAt: number;
  /** 1 where somebody was seen in the frame. */
  present: Uint8Array;
  /** Per frame: world then image landmarks, [x, y, z, visibility] each. */
  data: Float32Array;
}

let dbp: Promise<IDBDatabase> | null = null;
function db(): Promise<IDBDatabase> {
  dbp ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "id" });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

function run<T>(mode: IDBTransactionMode, op: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return db().then(
    (d) =>
      new Promise<T>((resolve, reject) => {
        const req = op(d.transaction(STORE, mode).objectStore(STORE));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      }),
  );
}

function pack(t: Track, savedAt: number): Stored {
  const n = t.frames.length;
  const data = new Float32Array(n * PER_FRAME);
  const present = new Uint8Array(n);
  t.frames.forEach((f, i) => {
    if (f.world.length < 33) return;
    present[i] = 1;
    const o = i * PER_FRAME;
    [...f.world, ...f.image].forEach((p, k) => data.set(p.slice(0, 4), o + k * 4));
  });
  return { id: t.id, name: t.name, nameEn: t.nameEn, fps: t.fps, duration: t.duration, aspect: t.aspect ?? 1, source: t.source, savedAt, present, data };
}

function unpack(s: Stored): Track {
  const frames = Array.from(s.present, (here, i) => {
    if (!here) return { world: [], image: [] };
    const lm = (from: number) => Array.from({ length: 33 }, (_, k) => Array.from(s.data.subarray(from + k * 4, from + k * 4 + 4)));
    return { world: lm(i * PER_FRAME), image: lm(i * PER_FRAME + 33 * 4) };
  });
  return { id: s.id, name: s.name, nameEn: s.nameEn, fps: s.fps, duration: s.duration, aspect: s.aspect, source: s.source, frames };
}

export async function loadSaved(): Promise<Track[]> {
  const all = await run("readonly", (s) => s.getAll() as IDBRequest<Stored[]>);
  return all.sort((a, b) => a.savedAt - b.savedAt).map(unpack);
}

export async function putSaved(t: Track): Promise<void> {
  await run("readwrite", (s) => s.put(pack(t, Date.now())));
}

export async function removeSaved(id: string): Promise<void> {
  await run("readwrite", (s) => s.delete(id));
}
