/** Everything the UI says and the controls it offers. Each string is one { zh, en } pair (src/i18n.ts Text); copy(lang)
 *  resolves the whole table to one language for the parts to read (T.motion.title is a string). The structure (ids,
 *  icons, keys, ranges) is shared. 奶蛙 stays 奶蛙 in English; the product is Naiwa Motion Lab. */
import type { DanceInfo, FleshRegion, MaterialPreset, Mode, MotionState, Tool } from "../contracts";
import { getLang, type Lang, type Text } from "../i18n";
import type { RecordLayout } from "./ctx";
import type { IconName } from "./icons";

/** Motion sources (AppState.mode): free = no motion, the body is left to physics. */
export const SOURCES: { id: Mode; icon: IconName; key: string }[] = [
  { id: "play", icon: "free", key: "1" },
  { id: "camera", icon: "camera", key: "2" },
  { id: "video", icon: "film", key: "3" },
  { id: "dance", icon: "motion", key: "4" },
];

/** Ways to perturb the simulation (AppState.tool); the page offers these two. */
export type ShownTool = Extract<Tool, "hand" | "ball">;
export const TOOLS: { id: ShownTool; icon: IconName; key: string }[] = [
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

/** The 手感 / Feel panel's sliders, in everyday words (feel.ts maps them to PhysicsParams). */
export type FeelSliderId = "firm" | "settle" | "belly";

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

/** The lab (simulator, retargeter, parameters, playback, readouts) is closed by default; each visitor's choice is
 *  remembered under this key. */
export const LAB_KEY = "naiwa.lab";
/** Whether the 手感 / Feel panel is folded, per visitor. */
export const FEEL_KEY = "naiwa.feel";

const t = (zh: string, en: string): Text => ({ zh, en });

/** Every string, in both languages. */
export const STRINGS = {
  product: t("Naiwa Motion Lab", "Naiwa Motion Lab"),
  brand: t("Naiwa", "Naiwa"),
  brandSub: t("Motion Lab", "Motion Lab"),
  motion: {
    title: t("动作", "Motion"),
    sub: t("把人的动作迁移到奶蛙身上", "Transfer a person's motion onto 奶蛙"),
    sources: {
      play: t("自由", "Free"),
      camera: t("摄像头", "Camera"),
      video: t("上传视频", "Video"),
      dance: t("预设动作", "Presets"),
    } as Record<Mode, Text>,
    sourceHints: {
      play: t("无动作驱动，身体只受物理作用", "No motion driving: the body is left to physics"),
      camera: t("实时捕捉摄像头中的人", "Live capture of the person in the webcam"),
      video: t("先分析视频，再逐帧迁移", "Analyse a video, then transfer it frame by frame"),
      dance: t("从真实视频采集或程序生成的动作", "Motions captured from real videos or generated"),
    } as Record<Mode, Text>,
    status: {
      idle: t("未开始", "Idle"),
      loading: t("加载中", "Loading"),
      ready: t("就绪", "Ready"),
      tracking: t("跟踪中", "Tracking"),
      lost: t("未检测到人", "No person detected"),
      error: t("错误", "Error"),
    } as Record<MotionState, Text>,
    mirror: t("镜像", "Mirror"),
    mirrorHint: t("左右翻转，像照镜子", "Flip left and right, like a mirror"),
    layoutTitle: t("录制画面", "Recording layout"),
    layouts: {
      frog: t("仅奶蛙", "Frog only"),
      pip: t("画中画", "Picture in picture"),
      "side-by-side": t("并排对比", "Side by side"),
    } as Record<RecordLayout, Text>,
  },
  camera: {
    start: t("开启摄像头", "Start camera"),
    starting: t("正在开启…", "Starting…"),
    stop: t("关闭摄像头", "Stop camera"),
    tip: t("保持全身在画面内，光线充足", "Keep the whole body in frame, in good light"),
    privacy: t("画面只在本机浏览器中处理，不上传", "Processed in this browser only; nothing is uploaded"),
  },
  video: {
    drop: t("拖入视频文件，或", "Drop a video file, or"),
    pick: t("选择文件", "choose a file"),
    dropBig: t("松开以载入视频", "Release to load the video"),
    notVideo: t("不是视频文件", "Not a video file"),
    analysing: t("正在分析动作", "Analysing motion"),
    analysingHint: t("分析完成后开始播放", "Playback starts when the analysis is done"),
    swap: t("更换", "Replace"),
    keep: t("保存为我的动作", "Save as my motion"),
    kept: t("已保存到我的动作", "Saved to My motions"),
    namePlaceholder: t("动作名称", "Motion name"),
    save: t("保存", "Save"),
    cancel: t("取消", "Cancel"),
    saveFailed: t("保存失败：视频尚未分析完", "Could not save: the video is not analysed yet"),
    tip: t("单人、全身入镜、镜头稳定的视频效果最好", "Best with one person, whole body in view and a steady camera"),
    privacy: t("视频只在本机浏览器中播放与分析，不上传", "Played and analysed in this browser only; nothing is uploaded"),
  },
  dance: {
    groups: {
      video: t("真实视频采集", "Captured from video"),
      procedural: t("程序生成", "Procedural"),
      mine: t("我的动作", "My motions"),
    } as Record<DanceOrigin, Text>,
    empty: t("暂无预设动作", "No preset motions"),
    loop: (s: number) => t(`${s.toFixed(1)} 秒循环`, `${s.toFixed(1)} s loop`),
    from: t("来源", "Source"),
    mineEmpty: t("在「上传视频」中分析视频后，可保存到这里", "Analyse a video under Video, then save it here"),
    goVideo: t("上传视频", "Upload a video"),
    delete: t("删除", "Delete"),
    confirmDelete: t("再次点击以删除", "Click again to delete"),
    deleted: (n: string) => t(`已删除「${n}」`, `Deleted “${n}”`),
    deleteFailed: t("删除失败", "Could not delete"),
  },
  pip: {
    label: t("预览", "Preview"),
    camera: t("摄像头", "Camera"),
    video: t("视频", "Video"),
    emptyCamera: t("开启摄像头后，这里显示画面与骨架", "The camera image and skeleton appear here"),
    emptyVideo: t("载入视频后在这里播放", "The video plays here once loaded"),
  },
  sim: {
    title: t("实验室", "Lab"),
    sub: t("模拟器、动作迁移、材质", "Simulator, motion transfer, material"),
    simulator: t("模拟器", "Simulator"),
    devices: { cpu: t("CPU", "CPU"), gpu: t("GPU", "GPU") },
    mine: t("我的", "Mine"),
    unavailable: t("不可用", "Unavailable"),
    runsOn: t("运行于", "Running on"),
    editCode: t("编辑代码", "Edit code"),
    retargeter: t("动作迁移", "Motion transfer"),
    noSimulators: t("暂无已注册的模拟器", "No simulators registered"),
    noRetargeters: t("暂无已注册的动作迁移算法", "No retargeters registered"),
    params: t("参数", "Parameters"),
    rebuildTip: t("修改后会重建仿真", "Changing it rebuilds the simulation"),
    rebuildNote: t("标记的参数修改后会重建仿真", "Marked parameters rebuild the simulation"),

    presets: t("材质预设", "Material presets"),
    modified: t("已修改", "Modified"),
    global: t("整体", "Global"),
    knobs: {
      softness: { label: t("软度", "Softness"), hint: t("0 最硬 · 1 最软", "0 firmest · 1 softest") },
      damping: { label: t("阻尼", "Damping"), hint: t("0 晃动久 · 1 很快静止", "0 wobbles long · 1 settles fast") },
      gravity: { label: t("重力", "Gravity"), hint: t("9.81 m/s² 为地球重力", "9.81 m/s² is Earth's") },
      volume: { label: t("体积", "Volume"), hint: t("相对建模体积", "Relative to the modelled volume") },
      upright: { label: t("直立恢复", "Upright recovery"), hint: t("0 倒下不起 · 1 总能站回", "0 stays down · 1 always stands back up") },
    } as Record<KnobDef["id"], { label: Text; hint: Text }>,
    regions: t("分部位材质", "Material by region"),
    regionsSub: t("各部位的相对软度，乘以整体软度", "Relative softness per region, multiplied by Softness"),
    regionNames: {
      belly: t("肚子", "Belly"),
      head: t("头", "Head"),
      arm: t("手臂", "Arms"),
      leg: t("腿", "Legs"),
    } as Record<RegionGroupDef["id"], Text>,
    regionDefault: t("默认", "Default"),
    regionReset: t("全部恢复默认", "Reset all to default"),
    copyLink: t("复制当前设置的链接", "Copy a link to these settings"),
    collapse: t("收起 / 展开", "Collapse / expand"),
  },
  feel: {
    title: t("手感", "Feel"),
    sub: t("材质、软硬、晃动", "Material, firmness, wobble"),
    material: t("材质", "Material"),
    sliders: {
      firm: { label: t("软硬", "Firmness"), low: t("软", "Soft"), high: t("硬", "Firm"), mid: t("适中", "Medium") },
      settle: { label: t("晃动", "Wobble"), low: t("晃得久", "Wobbles long"), high: t("很快停", "Settles fast"), mid: t("适中", "Medium") },
      belly: { label: t("肚子", "Belly"), low: t("肚子小", "Small belly"), high: t("肚子大", "Big belly"), mid: t("正常", "Normal") },
    } as Record<FeelSliderId, { label: Text; low: Text; high: Text; mid: Text }>,
    slow: t("慢动作", "Slow motion"),
    slowHint: t("放慢仿真，看清每一下晃动", "Slows the simulation so every wobble shows"),
    moon: t("月球重力", "Moon gravity"),
    moonHint: t("身体变轻，落得更慢", "The body is lighter and falls slower"),
    reset: t("恢复默认", "Back to default"),
    resetHint: t("回到默认材质、正常速度和重力", "Default material, normal speed and gravity"),
  },
  transport: {
    playback: t("播放", "Playback"),
    pause: t("暂停", "Pause"),
    resume: t("继续", "Resume"),
    step: t("单步", "Step"),
    speed: t("速度", "Speed"),
    interact: t("交互", "Interact"),
    tools: { hand: t("戳 / 拖动", "Poke / drag"), ball: t("探测球", "Probe ball") } as Record<ShownTool, Text>,
    toolHints: {
      hand: t("点击身体戳一下，按住拖动", "Click the body to poke it, hold to drag it"),
      ball: t("点击处投下一个探测球", "Click to drop a probe ball there"),
    } as Record<ShownTool, Text>,
    reset: t("复位", "Reset"),
    resetHint: t("让身体回到初始站姿", "Put the body back in its rest stance"),
  },
  readouts: {
    label: t("仿真读数", "Simulation readouts"),
    fps: t("帧率", "FPS"),
    step: t("步进", "Step"),
    particles: t("粒子", "Particles"),
    cells: t("单元", "Cells"),
    volume: t("体积", "Volume"),
    paused: t("已暂停", "Paused"),
  },
  record: t("录制", "Record"),
  stopRecord: t("停止录制", "Stop recording"),
  soundOn: t("声音：开", "Sound on"),
  soundOff: t("声音：关", "Sound off"),
  toDark: t("切换到深色", "Switch to dark"),
  toLight: t("切换到浅色", "Switch to light"),
  langSwitch: t("Switch to English", "切换到中文"),
  lab: t("实验室", "Lab"),
  labHint: t("模拟器、动作迁移、参数、播放控制与读数", "Simulator, motion transfer, parameters, playback and readouts"),
  help: t("帮助", "Help"),
  tabs: { motion: t("动作", "Motion"), feel: t("手感", "Feel"), sim: t("实验室", "Lab") },
  sheetToggle: t("展开 / 收起面板", "Expand / collapse the panel"),
  rec: {
    title: t("录制完成", "Recording ready"),
    sub: (s: string) => t(`时长 ${s}`, `Duration ${s}`),
    share: t("保存 / 分享", "Save / share"),
    copy: t("复制设置链接", "Copy settings link"),
    again: t("重新录制", "Record again"),
    close: t("关闭", "Close"),
  },
  helpSub: t(
    "人的动作实时迁移到软体奶蛙上：骨骼驱动，肉体仿真",
    "Human motion transferred live onto a soft-bodied 奶蛙: the skeleton is driven, the flesh is simulated",
  ),
  viewTitle: t("视图操作", "Viewport"),
  viewOps: [
    [t("点击身体", "Click the body"), t("戳一下", "Poke")],
    [t("按住身体拖动", "Drag the body"), t("拖动身体", "Pull it around")],
    [t("拖动背景", "Drag the background"), t("旋转视角", "Orbit")],
    [t("滚轮 / 双指", "Wheel / pinch"), t("缩放", "Zoom")],
  ] as [Text, Text][],
  keysTitle: t("快捷键", "Shortcuts"),
  shortcuts: [
    t("暂停 / 继续（实验室）", "Pause / resume (Lab)"),
    t("单步（实验室，暂停时）", "Step (Lab, while paused)"),
    t("减速 / 加速（实验室）", "Slower / faster (Lab)"),
    t("自由 / 摄像头 / 上传视频 / 预设动作", "Free / Camera / Video / Presets"),
    t("戳 / 拖动 · 探测球", "Poke / drag · Probe ball"),
    t("复位", "Reset"),
    t("开始 / 停止录制", "Start / stop recording"),
    t("镜像", "Mirror"),
    t("浅色 / 深色", "Light / dark"),
    t("打开 / 关闭实验室", "Open / close the Lab"),
    t("帮助", "Help"),
    t("关闭对话框", "Close the dialog"),
  ],
  themeTitle: t("主题", "Theme"),
  themes: { system: t("跟随系统", "System"), light: t("浅色", "Light"), dark: t("深色", "Dark") },
  langTitle: t("语言", "Language"),
  langNames: { zh: t("中文", "中文"), en: t("English", "English") } as Record<Lang, Text>,
  duration: (s: number) =>
    s < 60
      ? t(`${s} 秒`, `${s} s`)
      : t(`${Math.floor(s / 60)} 分 ${String(s % 60).padStart(2, "0")} 秒`, `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, "0")} s`),
  /** Successes are announced by the commands themselves (they know what happened); the UI reports failures. */
  toasts: {
    linkFailed: t("复制链接失败", "Could not copy the link"),
    shareFailed: t("保存视频失败", "Could not save the video"),
  },
};

/** The table in one language: every Text becomes a string, every function returning Text returns a string. */
export type Resolved<T> = T extends Text
  ? string
  : T extends (...a: infer A) => Text
    ? (...a: A) => string
    : T extends object
      ? { [K in keyof T]: Resolved<T[K]> }
      : T;
export type Copy = Resolved<typeof STRINGS>;

export const isText = (v: unknown): v is Text =>
  typeof v === "object" && v !== null && !Array.isArray(v) && Object.keys(v).length === 2 && typeof (v as Text).zh === "string" && typeof (v as Text).en === "string";

function resolve(v: unknown, lang: Lang): unknown {
  if (isText(v)) return v[lang];
  if (typeof v === "function") return (...a: unknown[]) => (v as (...a: unknown[]) => Text)(...a)[lang];
  if (Array.isArray(v)) return v.map((x) => resolve(x, lang));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, resolve(x, lang)]));
  return v;
}

const resolved: Partial<Record<Lang, Copy>> = {};
export const copy = (lang: Lang = getLang()): Copy => (resolved[lang] ??= resolve(STRINGS, lang) as Copy);

export const danceName = (d: DanceInfo, lang: Lang = getLang()): string => (lang === "en" ? (d.nameEn ?? d.name) : d.name);
export const presetName = (p: MaterialPreset, lang: Lang = getLang()): string => (lang === "en" ? p.nameEn : p.name);

/** "3 秒" / "3 s", "1 分 05 秒" / "1 min 05 s". */
export function formatDuration(ms: number, lang: Lang = getLang()): string {
  return copy(lang).duration(Math.max(1, Math.round(ms / 1000)));
}
