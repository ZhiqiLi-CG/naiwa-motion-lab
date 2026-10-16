/** The two looks of the stage. Colours are sRGB hex (as designers pick them); three converts them to linear. */

export type ThemeName = "light" | "dark";

export interface StageTheme {
  /** Sky gradient, from the horizon up; the floor fades into skyHorizon far away so there is no seam. */
  skyTop: number;
  skyHorizon: number;
  floor: number;
  floorDot: number;
  /** The round lily-pad play mat under the frog's home spot. */
  pad: number;
  padRim: number;
  padVein: number;
  /** Multiplied into the floor where the key light is blocked / right under the frog (tinted, not grey: cartoon). */
  shadowTint: number;
  contactTint: number;
  /** A warm pool of light on the floor around the frog (strength 0 = none). */
  pool: number;
  poolStrength: number;
  keyColor: number;
  keyIntensity: number;
  envIntensity: number;
  exposure: number;
  env: EnvLook;
}

/** The light the environment map is made of: a gradient dome and soft light panels (intensities are linear). */
export interface EnvLook {
  top: number;
  horizon: number;
  ground: number;
  domeIntensity: number;
  panels: { color: number; intensity: number; position: [number, number, number]; size: [number, number] }[];
}

export const THEMES: Record<ThemeName, StageTheme> = {
  light: {
    skyTop: 0x74c0ec,
    skyHorizon: 0xe2f3f0,
    floor: 0xeef7f2,
    floorDot: 0xdcefe7,
    pad: 0xaee0bc,
    padRim: 0x8fcfa2,
    padVein: 0xc3eacd,
    shadowTint: 0x93a6c8,
    contactTint: 0x5f6f94,
    pool: 0xfff3d6,
    poolStrength: 0.1,
    keyColor: 0xfff1dc,
    keyIntensity: 5,
    envIntensity: 0.28,
    exposure: 1,
    env: {
      top: 0xbfe2ff,
      horizon: 0xfff4e6,
      ground: 0x8fa597,
      domeIntensity: 0.9,
      panels: [
        // Positions are relative to the camera's heading (+z towards the camera): a big warm softbox on the key
        // light's side, a cool fill, a rim strip behind, a top light, and a thin strip above the camera whose
        // reflection runs across the belly and bends with every dent.
        { color: 0xfff1de, intensity: 5, position: [-4.2, 3.4, 1.8], size: [4, 3] },
        { color: 0xe4f0ff, intensity: 1.1, position: [4.5, 1.8, 2.6], size: [3, 3] },
        { color: 0xffffff, intensity: 4.5, position: [1.5, 3.2, -4.8], size: [6, 1.6] },
        { color: 0xffffff, intensity: 1.4, position: [0, 6, 0], size: [3, 3] },
        { color: 0xffffff, intensity: 4, position: [0, 2.8, 4.6], size: [3.6, 0.45] },
      ],
    },
  },
  dark: {
    skyTop: 0x161a40,
    skyHorizon: 0x34336c,
    floor: 0x2c2f60,
    floorDot: 0x34386d,
    pad: 0x2f6c66,
    padRim: 0x25574f,
    padVein: 0x418a7e,
    shadowTint: 0x524c8c,
    contactTint: 0x0d0e28,
    pool: 0xffd59a,
    poolStrength: 0.9,
    keyColor: 0xfff0dc,
    keyIntensity: 4.4,
    envIntensity: 0.42,
    exposure: 1,
    env: {
      top: 0x2a2f6e,
      horizon: 0x5b4b80,
      ground: 0x2c2442,
      domeIntensity: 0.5,
      panels: [
        { color: 0xfff0dc, intensity: 4.6, position: [-4.2, 3.4, 1.8], size: [3.5, 3] },
        { color: 0xbfc8ff, intensity: 1.1, position: [4.5, 1.8, 2.6], size: [3, 3] },
        { color: 0x9fd8ff, intensity: 3.6, position: [0.5, 3.2, -4.8], size: [6, 1.6] },
        { color: 0xffffff, intensity: 3, position: [0, 2.8, 4.6], size: [3.6, 0.45] },
      ],
    },
  },
};

/** Colours for the balls, one per ball slot. */
export const BALL_COLORS = [0xff6f91, 0x5cc8ff, 0x7be0a5, 0xb79cff, 0xffa24c, 0xff5e5e, 0x4fd6c6, 0xffd23f];
