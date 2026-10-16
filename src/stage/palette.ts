/** The two looks of the stage. Colours are sRGB hex (as designers pick them); three converts them to linear. */

export type ThemeName = "light" | "dark";

export interface StageTheme {
  /** Sky gradient, from the horizon up; the floor fades into skyHorizon far away so there is no seam. */
  skyTop: number;
  skyHorizon: number;
  /** Decoration in the sky: soft bubbles by day, twinkling stars by night. */
  decor: "bubbles" | "stars";
  decorColor: number;
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
    skyHorizon: 0xd2eef8,
    decor: "bubbles",
    decorColor: 0xffffff,
    floor: 0xeef7f2,
    floorDot: 0xdcefe7,
    pad: 0xaee0bc,
    padRim: 0x8fcfa2,
    padVein: 0xc3eacd,
    shadowTint: 0x93a6c8,
    contactTint: 0x5f6f94,
    pool: 0xfff3d6,
    poolStrength: 0.12,
    keyColor: 0xfff1dc,
    keyIntensity: 3.2,
    envIntensity: 0.55,
    exposure: 1,
    env: {
      top: 0xbfe2ff,
      horizon: 0xfff4e6,
      ground: 0x8fa597,
      domeIntensity: 0.9,
      panels: [
        // Big warm softbox front-left above (same side as the key light), a cool fill, a rim behind, a top light.
        { color: 0xfff1de, intensity: 5, position: [-3.2, 4.2, 3.6], size: [4, 3] },
        { color: 0xe4f0ff, intensity: 1.1, position: [4.5, 1.8, 2.6], size: [3, 3] },
        { color: 0xffffff, intensity: 4.5, position: [1.5, 3.2, -4.8], size: [6, 1.6] },
        { color: 0xffffff, intensity: 1.4, position: [0, 6, 0], size: [3, 3] },
      ],
    },
  },
  dark: {
    skyTop: 0x12142e,
    skyHorizon: 0x2c2f5e,
    decor: "stars",
    decorColor: 0xfff3c4,
    floor: 0x272b55,
    floorDot: 0x2f3462,
    pad: 0x2f6a5f,
    padRim: 0x255449,
    padVein: 0x3b8172,
    shadowTint: 0x2a2450,
    contactTint: 0x0b0c22,
    pool: 0xffd9a0,
    poolStrength: 0.55,
    keyColor: 0xffe0b6,
    keyIntensity: 2.7,
    envIntensity: 0.75,
    exposure: 1,
    env: {
      top: 0x2a2f6e,
      horizon: 0x5b4b80,
      ground: 0x2c2442,
      domeIntensity: 0.5,
      panels: [
        { color: 0xffe2bc, intensity: 4.2, position: [-3.2, 4.2, 3.6], size: [3.5, 3] },
        { color: 0xbfc8ff, intensity: 1.1, position: [4.5, 1.8, 2.6], size: [3, 3] },
        { color: 0x9fd8ff, intensity: 3.6, position: [0.5, 3.2, -4.8], size: [6, 1.6] },
      ],
    },
  },
};

/** Candy colours for the balls (and the default comic text fills). */
export const BALL_COLORS = [0xff6f91, 0x5cc8ff, 0x7be0a5, 0xb79cff, 0xffa24c, 0xff5e5e, 0x4fd6c6, 0xffd23f];
