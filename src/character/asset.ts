/** Fetching public/models/naiwa.glb: a missing file means "use the placeholder"; anything else wrong is an error. */
import type * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

export class CharacterAssetError extends Error {
  constructor(
    readonly url: string,
    readonly problems: string[],
  ) {
    super(`奶蛙 model ${url} does not follow docs/character-contract.md:\n  - ${problems.join("\n  - ")}`);
    this.name = "CharacterAssetError";
  }
}

/** The GLB's scene, or null when there is no such file. */
export async function fetchModel(url: string): Promise<THREE.Object3D | null> {
  const res = await fetch(url);
  if (res.status === 404) return null;
  if (!res.ok) throw new CharacterAssetError(url, [`HTTP ${res.status} ${res.statusText}`]);
  const data = await res.arrayBuffer();
  const magic = data.byteLength >= 4 ? new TextDecoder().decode(new Uint8Array(data, 0, 4)) : "";
  if (magic !== "glTF") {
    // Dev servers answer a missing file with the app's HTML page.
    if ((res.headers.get("content-type") ?? "").includes("text/html")) return null;
    throw new CharacterAssetError(url, ["not a binary glTF file (no glTF header)"]);
  }
  return parseModel(data, url);
}

export async function parseModel(data: ArrayBuffer, url: string): Promise<THREE.Object3D> {
  try {
    const gltf = await new GLTFLoader().parseAsync(data, url.slice(0, url.lastIndexOf("/") + 1));
    return gltf.scene;
  } catch (e) {
    throw new CharacterAssetError(url, [`glTF parse failed: ${(e as Error).message}`]);
  }
}
