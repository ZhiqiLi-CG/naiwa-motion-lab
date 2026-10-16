/** Everything the UI says, in 中文 and English, and the controls it offers. The structure (ids, icons, keys, ranges)
 *  is shared; the words come from copy(lang). 奶蛙 stays 奶蛙 in English; the product is Naiwa Motion Lab. */
import type { DanceInfo, FleshRegion, MaterialPreset, Mode, MotionState, Tool } from "../contracts";
import { getLang, type Lang } from "../i18n";
import type { RecordLayout } from "./ctx";
import type { IconName } from "./icons";

/** Motion sources (AppState.mode): free = no motion, the body is left to physics. */
export const SOURCES: { id: Mode; icon: IconName; key: string }[] = [
  { id: "play", icon: "free", key: "1" },
  { id: "camera", icon: "camera", key: "2" },
  { id: "video", icon: "film", key: "3" },
  { id: "dance", icon: "motion", key: "4" },
];

/** Ways to perturb the simulation (AppState.tool). */
export const TOOLS: { id: Tool; icon: IconName; key: string }[] = [
  { id: "hand", icon: "hand", key: "H" },
  { id: "ball", icon: "ball", key: "B" },
];

export const SPEEDS = [0.25, 0.5, 1];

/** A physics knob as shown: `toView`/`fromView` map the stored value to the displayed one (damping is shown for
 *  bounciness, gravity in m/s²). */
export interface KnobDef {
  id: "softness" | "damping" | "gravity" | "volume" | "upright";
  param: "softness" | "bounciness" | "gravity" | "bellySize" | "stubbornness";
  min: number;
  max: number;
  step: number;
  digits: number;
  unit: string;
  toView(v: number): number;
  fromView(v: number): number;
}
const same = (v: number) => v;
export const G = 9.81;
export const KNOBS: KnobDef[] = [
  { id: "softness", param: "softness", min: 0, max: 1, step: 0.01, digits: 2, unit: "", toView: same, fromView: same },
  { id: "damping", param: "bounciness", min: 0, max: 1, step: 0.01, digits: 2, unit: "", toView: (b) => 1 - b, fromView: (d) => 1 - d },
  { id: "gravity", param: "gravity", min: 1, max: 19.6, step: 0.1, digits: 2, unit: "m/s²", toView: (g) => g * G, fromView: (a) => a / G },
  { id: "volume", param: "bellySize", min: 0.7, max: 1.8, step: 0.01, digits: 2, unit: "×", toView: same, fromView: same },
  { id: "upright", param: "stubbornness", min: 0, max: 1, step: 0.01, digits: 2, unit: "", toView: same, fromView: same },
];

/** Material by region: four sliders over the seven flesh regions. Each writes the same relative softness to its
 *  regions; `nominal` is where the thumb sits while the regions keep the simulation's defaults. */
export interface RegionGroupDef {
  id: "belly" | "head" | "arm" | "leg";
  regions: FleshRegion[];
  nominal: number;
}
export const REGION_GROUPS: RegionGroupDef[] = [
  { id: "belly", regions: ["belly", "body"], nominal: 1 },
  { id: "head", regions: ["head"], nominal: 0.5 },
  { id: "arm", regions: ["arm", "hand"], nominal: 0.5 },
  { id: "leg", regions: ["leg", "foot"], nominal: 0.5 },
];

export const RECORD_LAYOUTS: { id: RecordLayout; icon: IconName }[] = [
  { id: "frog", icon: "layoutFrog" },
  { id: "pip", icon: "layoutPip" },
  { id: "side-by-side", icon: "layoutSide" },
];

export type DanceOrigin = NonNullable<DanceInfo["origin"]>;
export const DANCE_ORIGINS: DanceOrigin[] = ["video", "procedural", "mine"];

export type ChipTone = "neutral" | "accent" | "success" | "warning" | "danger" | "info";
export const MOTION_CHIP: Record<MotionState, { tone: ChipTone; live?: boolean; busy?: boolean }> = {
  idle: { tone: "neutral" },
  loading: { tone: "info", busy: true },
  ready: { tone: "success" },
  tracking: { tone: "success", live: true },
  lost: { tone: "warning" },
  error: { tone: "danger" },
};

/** Keyboard shortcuts (handled in keys.ts), described by copy().shortcuts in the same order. */
export const SHORTCUT_KEYS: string[][] = [
  ["Space"],
  ["."],
  ["[", "]"],
  ["1", "2", "3", "4"],
  ["H", "B"],
  ["X"],
  ["R"],
  ["M"],
  ["T"],
  ["L"],
  ["?"],
  ["Esc"],
];

const zh = {
  product: "Naiwa Motion Lab",
  brand: "Naiwa",
  brandSub: "Motion Lab",
  motion: {
    title: "动作",
    sub: "把人的动作迁移到奶蛙身上",
    sources: { play: "自由", camera: "摄像头", video: "上传视频", dance: "预设动作" } as Record<Mode, string>,
    sourceHints: {
      play: "无动作驱动，身体只受物理作用",
      camera: "实时捕捉摄像头中的人",
      video: "先分析视频，再逐帧迁移",
      dance: "从真实视频采集或程序生成的动作",
    } as Record<Mode, string>,
    status: {
      idle: "未开始",
      loading: "加载中",
      ready: "就绪",
      tracking: "跟踪中",
      lost: "未检测到人",
      error: "错误",
    } as Record<MotionState, string>,
    mirror: "镜像",
    mirrorHint: "左右翻转，像照镜子",
    layoutTitle: "录制画面",
    layouts: { frog: "仅奶蛙", pip: "画中画", "side-by-side": "并排对比" } as Record<RecordLayout, string>,
  },
  camera: {
    start: "开启摄像头",
    starting: "正在开启…",
    stop: "关闭摄像头",
    tip: "保持全身在画面内，光线充足",
    privacy: "画面只在本机浏览器中处理，不上传",
  },
  video: {
    drop: "拖入视频文件，或",
    pick: "选择文件",
    dropBig: "松开以载入视频",
    notVideo: "不是视频文件",
    analysing: "正在分析动作",
    analysingHint: "分析完成后开始播放",
    swap: "更换",
    keep: "保存为我的动作",
    kept: "已保存到我的动作",
    namePlaceholder: "动作名称",
    save: "保存",
    cancel: "取消",
    saveFailed: "保存失败：视频尚未分析完",
    tip: "单人、全身入镜、镜头稳定的视频效果最好",
    privacy: "视频只在本机浏览器中播放与分析，不上传",
  },
  dance: {
    groups: {
      video: "真实视频采集",
      procedural: "程序生成",
      mine: "我的动作",
    } as Record<DanceOrigin, string>,
    empty: "动作列表加载中…",
    loop: (s: number) => `${s.toFixed(1)} 秒循环`,
    from: "来源",
    mineEmpty: "在「上传视频」中分析视频后，可保存到这里",
    goVideo: "上传视频",
    delete: "删除",
    confirmDelete: "再次点击以删除",
    deleted: (n: string) => `已删除「${n}」`,
    deleteFailed: "删除失败",
  },
  pip: {
    label: "预览",
    camera: "摄像头",
    video: "视频",
    emptyCamera: "开启摄像头后，这里显示画面与骨架",
    emptyVideo: "载入视频后在这里播放",
  },
  sim: {
    title: "仿真",
    sub: "模拟器、软体材质与参数",
    simulator: "模拟器",
    devices: { cpu: "CPU", gpu: "GPU" },
    mine: "我的",
    unavailable: "不可用",
    editCode: "编辑代码",
    loadingSims: "模拟器加载中…",
    params: "模拟器参数",
    rebuildTip: "修改后会重建仿真",

    presets: "材质预设",
    modified: "已修改",
    global: "整体",
    knobs: {
      softness: { label: "软度", hint: "0 最硬 · 1 最软" },
      damping: { label: "阻尼", hint: "0 晃动久 · 1 很快静止" },
      gravity: { label: "重力", hint: "9.81 m/s² 为地球重力" },
      volume: { label: "体积", hint: "相对建模体积" },
      upright: { label: "直立恢复", hint: "0 倒下不起 · 1 总能站回" },
    } as Record<KnobDef["id"], { label: string; hint: string }>,
    regions: "分部位材质",
    regionsSub: "各部位的相对软度，乘以整体软度",
    regionNames: { belly: "肚子", head: "头", arm: "手臂", leg: "腿" } as Record<RegionGroupDef["id"], string>,
    regionDefault: "默认",
    regionReset: "全部恢复默认",
    copyLink: "复制当前设置的链接",
    collapse: "收起 / 展开",
  },
  transport: {
    playback: "播放",
    pause: "暂停",
    resume: "继续",
    step: "单步",
    speed: "速度",
    interact: "交互",
    tools: { hand: "戳 / 拖动", ball: "探测球", feather: "羽毛", pump: "打气" } as Record<Tool, string>,
    toolHints: {
      hand: "点击身体戳一下，按住拖动",
      ball: "点击处投下一个探测球",
      feather: "",
      pump: "",
    } as Record<Tool, string>,
    reset: "复位",
    resetHint: "让身体回到初始站姿",
  },
  readouts: {
    label: "仿真读数",
    fps: "帧率",
    step: "步进",
    particles: "粒子",
    cells: "单元",
    volume: "体积",
    paused: "已暂停",
  },
  record: "录制",
  stopRecord: "停止录制",
  soundOn: "声音：开",
  soundOff: "声音：关",
  toDark: "切换到深色",
  toLight: "切换到浅色",
  langSwitch: "Switch to English",
  help: "帮助",
  tabs: { motion: "动作", sim: "仿真" },
  sheetToggle: "展开 / 收起面板",
  rec: {
    title: "录制完成",
    sub: (s: string) => `时长 ${s}`,
    share: "保存 / 分享",
    copy: "复制设置链接",
    again: "重新录制",
    close: "关闭",
  },
  helpSub: "人的动作实时迁移到软体奶蛙上：骨骼驱动，肉体仿真",
  viewTitle: "视图操作",
  viewOps: [
    ["点击身体", "戳一下"],
    ["按住身体拖动", "拖动身体"],
    ["拖动背景", "旋转视角"],
    ["滚轮 / 双指", "缩放"],
  ] as [string, string][],
  keysTitle: "快捷键",
  shortcuts: [
    "暂停 / 继续",
    "单步（暂停时）",
    "减速 / 加速",
    "自由 / 摄像头 / 上传视频 / 预设动作",
    "戳 / 拖动 · 探测球",
    "复位",
    "开始 / 停止录制",
    "镜像",
    "浅色 / 深色",
    "中文 / English",
    "帮助",
    "关闭对话框",
  ],
  themeTitle: "主题",
  themes: { system: "跟随系统", light: "浅色", dark: "深色" },
  langTitle: "语言",
  duration: (t: number) => (t < 60 ? `${t} 秒` : `${Math.floor(t / 60)} 分 ${String(t % 60).padStart(2, "0")} 秒`),
  /** Successes are announced by the commands themselves (they know what happened); the UI reports failures. */
  toasts: {
    linkFailed: "复制链接失败",
    shareFailed: "保存视频失败",
  },
};

export type Copy = typeof zh;

const en: Copy = {
  product: "Naiwa Motion Lab",
  brand: "Naiwa",
  brandSub: "Motion Lab",
  motion: {
    title: "Motion",
    sub: "Transfer a person's motion onto 奶蛙",
    sources: { play: "Free", camera: "Camera", video: "Video", dance: "Presets" },
    sourceHints: {
      play: "No motion driving: the body is left to physics",
      camera: "Live capture of the person in the webcam",
      video: "Analyse a video, then transfer it frame by frame",
      dance: "Motions captured from real videos or generated",
    },
    status: {
      idle: "Idle",
      loading: "Loading",
      ready: "Ready",
      tracking: "Tracking",
      lost: "No person detected",
      error: "Error",
    },
    mirror: "Mirror",
    mirrorHint: "Flip left and right, like a mirror",
    layoutTitle: "Recording layout",
    layouts: { frog: "Frog only", pip: "Picture in picture", "side-by-side": "Side by side" },
  },
  camera: {
    start: "Start camera",
    starting: "Starting…",
    stop: "Stop camera",
    tip: "Keep the whole body in frame, in good light",
    privacy: "Processed in this browser only; nothing is uploaded",
  },
  video: {
    drop: "Drop a video file, or",
    pick: "choose a file",
    dropBig: "Release to load the video",
    notVideo: "Not a video file",
    analysing: "Analysing motion",
    analysingHint: "Playback starts when the analysis is done",
    swap: "Replace",
    keep: "Save as my motion",
    kept: "Saved to My motions",
    namePlaceholder: "Motion name",
    save: "Save",
    cancel: "Cancel",
    saveFailed: "Could not save: the video is not analysed yet",
    tip: "Best with one person, whole body in view and a steady camera",
    privacy: "Played and analysed in this browser only; nothing is uploaded",
  },
  dance: {
    groups: { video: "Captured from video", procedural: "Procedural", mine: "My motions" },
    empty: "Loading motions…",
    loop: (s: number) => `${s.toFixed(1)} s loop`,
    from: "Source",
    mineEmpty: "Analyse a video under Video, then save it here",
    goVideo: "Upload a video",
    delete: "Delete",
    confirmDelete: "Click again to delete",
    deleted: (n: string) => `Deleted “${n}”`,
    deleteFailed: "Could not delete",
  },
  pip: {
    label: "Preview",
    camera: "Camera",
    video: "Video",
    emptyCamera: "The camera image and skeleton appear here",
    emptyVideo: "The video plays here once loaded",
  },
  sim: {
    title: "Simulation",
    sub: "Simulator, soft-body material and parameters",
    simulator: "Simulator",
    devices: { cpu: "CPU", gpu: "GPU" },
    mine: "Mine",
    unavailable: "Unavailable",
    editCode: "Edit code",
    loadingSims: "Loading simulators…",
    params: "Simulator parameters",
    rebuildTip: "Changing it rebuilds the simulation",

    presets: "Material presets",
    modified: "Modified",
    global: "Global",
    knobs: {
      softness: { label: "Softness", hint: "0 firmest · 1 softest" },
      damping: { label: "Damping", hint: "0 wobbles long · 1 settles fast" },
      gravity: { label: "Gravity", hint: "9.81 m/s² is Earth's" },
      volume: { label: "Volume", hint: "Relative to the modelled volume" },
      upright: { label: "Upright recovery", hint: "0 stays down · 1 always stands back up" },
    },
    regions: "Material by region",
    regionsSub: "Relative softness per region, multiplied by Softness",
    regionNames: { belly: "Belly", head: "Head", arm: "Arms", leg: "Legs" },
    regionDefault: "Default",
    regionReset: "Reset all to default",
    copyLink: "Copy a link to these settings",
    collapse: "Collapse / expand",
  },
  transport: {
    playback: "Playback",
    pause: "Pause",
    resume: "Resume",
    step: "Step",
    speed: "Speed",
    interact: "Interact",
    tools: { hand: "Poke / drag", ball: "Probe ball", feather: "Feather", pump: "Pump" },
    toolHints: {
      hand: "Click the body to poke it, hold to drag it",
      ball: "Click to drop a probe ball there",
      feather: "",
      pump: "",
    },
    reset: "Reset",
    resetHint: "Put the body back in its rest stance",
  },
  readouts: {
    label: "Simulation readouts",
    fps: "FPS",
    step: "Step",
    particles: "Particles",
    cells: "Cells",
    volume: "Volume",
    paused: "Paused",
  },
  record: "Record",
  stopRecord: "Stop recording",
  soundOn: "Sound on",
  soundOff: "Sound off",
  toDark: "Switch to dark",
  toLight: "Switch to light",
  langSwitch: "切换到中文",
  help: "Help",
  tabs: { motion: "Motion", sim: "Simulation" },
  sheetToggle: "Expand / collapse the panel",
  rec: {
    title: "Recording ready",
    sub: (s: string) => `Duration ${s}`,
    share: "Save / share",
    copy: "Copy settings link",
    again: "Record again",
    close: "Close",
  },
  helpSub: "Human motion transferred live onto a soft-bodied 奶蛙: the skeleton is driven, the flesh is simulated",
  viewTitle: "Viewport",
  viewOps: [
    ["Click the body", "Poke"],
    ["Drag the body", "Pull it around"],
    ["Drag the background", "Orbit"],
    ["Wheel / pinch", "Zoom"],
  ],
  keysTitle: "Shortcuts",
  shortcuts: [
    "Pause / resume",
    "Step (while paused)",
    "Slower / faster",
    "Free / Camera / Video / Presets",
    "Poke / drag · Probe ball",
    "Reset",
    "Start / stop recording",
    "Mirror",
    "Light / dark",
    "中文 / English",
    "Help",
    "Close the dialog",
  ],
  themeTitle: "Theme",
  themes: { system: "System", light: "Light", dark: "Dark" },
  langTitle: "Language",
  duration: (t: number) => (t < 60 ? `${t} s` : `${Math.floor(t / 60)} min ${String(t % 60).padStart(2, "0")} s`),
  toasts: {
    linkFailed: "Could not copy the link",
    shareFailed: "Could not save the video",
  },
};

export const copy = (lang: Lang = getLang()): Copy => (lang === "en" ? en : zh);

export const danceName = (d: DanceInfo, lang: Lang = getLang()): string => (lang === "en" ? (d.nameEn ?? d.name) : d.name);
export const presetName = (p: MaterialPreset, lang: Lang = getLang()): string => (lang === "en" ? p.nameEn : p.name);

/** "3 秒" / "3 s", "1 分 05 秒" / "1 min 05 s". */
export function formatDuration(ms: number, lang: Lang = getLang()): string {
  return copy(lang).duration(Math.max(1, Math.round(ms / 1000)));
}
