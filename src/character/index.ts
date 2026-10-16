/**
 * The character module: loads 奶蛙 (public/models/naiwa.glb, or a placeholder built in code when there is none) and
 * shows the simulated frog with its face and life. See docs/character-contract.md for the asset.
 */
import { CHARACTER_URL } from "../contracts";
import { fetchModel } from "./asset";
import { createCharacter, type NaiwaCharacter } from "./character";
import { buildPlaceholder } from "./placeholder";

export { CharacterAssetError } from "./asset";
export type { NaiwaCharacter } from "./character";
export type { Mood } from "./life";

/** Load the frog. Rejects with CharacterAssetError when the GLB exists but breaks the asset contract. */
export async function loadCharacter(url: string = CHARACTER_URL): Promise<NaiwaCharacter> {
  const scene = await fetchModel(url);
  if (scene) return createCharacter(scene, "glb", url);
  console.warn(`奶蛙: ${url} not found, showing the placeholder frog`);
  return createCharacter(buildPlaceholder(), "placeholder", "placeholder");
}
