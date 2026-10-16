/** Everything the UI says and the controls it offers, in one place. */
import type { Mode, MotionState, PhysicsParams, Tool } from "../contracts";
import type { IconName } from "./icons";

export interface ModeDef {
  id: Mode;
  label: string;
  short: string;
  icon: IconName;
  key: string;
}
export const MODES: ModeDef[] = [
  { id: "play", label: "捏捏奶蛙", short: "捏捏", icon: "hand", key: "P" },
  { id: "camera", label: "跟着我跳", short: "跟我跳", icon: "camera", key: "C" },
  { id: "video", label: "视频模仿", short: "学视频", icon: "film", key: "V" },
  { id: "dance", label: "舞蹈库", short: "舞蹈库", icon: "music", key: "D" },
];

export interface ToolDef {
  id: Tool;
  label: string;
  icon: IconName;
  key: string;
  hint: string;
}
export const TOOLS: ToolDef[] = [
  { id: "hand", label: "手", icon: "hand", key: "1", hint: "点一下戳肚子 · 按住拖走再甩出去 · 快速划过拍一巴掌" },
  { id: "ball", label: "丢球", icon: "ball", key: "2", hint: "点哪儿就往哪儿丢球，砸它！" },
  { id: "feather", label: "羽毛", icon: "feather", key: "3", hint: "在它身上来回蹭蹭，挠痒痒～" },
  { id: "pump", label: "打气筒", icon: "pump", key: "4", hint: "按住不放给肚子打气，越打越圆" },
];

export interface ParamDef {
  key: keyof PhysicsParams;
  label: string;
  min: number;
  max: number;
  step: number;
  /** What the two ends of the slider feel like. */
  lo: string;
  hi: string;
}
export const PARAMS: ParamDef[] = [
  { key: "softness", label: "软度", min: 0, max: 1, step: 0.01, lo: "硬邦邦", hi: "软趴趴" },
  { key: "bounciness", label: "弹性", min: 0, max: 1, step: 0.01, lo: "一动不动", hi: "Duang 个不停" },
  { key: "gravity", label: "重力", min: 0.1, max: 2, step: 0.05, lo: "月球漫步", hi: "沉甸甸" },
  { key: "bellySize", label: "肚子大小", min: 0.7, max: 1.8, step: 0.01, lo: "小肚腩", hi: "大气球" },
  { key: "stubbornness", label: "倔强", min: 0, max: 1, step: 0.01, lo: "躺平", hi: "不倒翁" },
];

/** Decorative swatch per preset id (token names in tokens.css). */
export const PRESET_SWATCH: Record<string, string> = {
  jelly: "var(--mat-jelly)",
  mochi: "var(--mat-mochi)",
  balloon: "var(--mat-balloon)",
  pudding: "var(--mat-pudding)",
  rubber: "var(--mat-rubber)",
};

export type ChipTone = "neutral" | "accent" | "success" | "warning" | "danger" | "info";
export const MOTION_CHIP: Record<MotionState, { text: string; tone: ChipTone; live?: boolean; busy?: boolean }> = {
  idle: { text: "还没开始", tone: "neutral" },
  loading: { text: "准备中…", tone: "info", busy: true },
  ready: { text: "准备好啦", tone: "success" },
  tracking: { text: "跟上你啦", tone: "success", live: true },
  lost: { text: "找不到你啦", tone: "warning" },
  error: { text: "出了点问题", tone: "danger" },
};

export const TEXT = {
  brand: "奶蛙",
  brandSub: "Playground",
  record: "录制",
  stopRecord: "停止录制",
  soundOn: "声音：开",
  soundOff: "声音：关",
  toDark: "切到夜间",
  toLight: "切到白天",
  help: "怎么玩",
  feel: "手感",
  feelSub: "调调奶蛙的肉肉",
  presets: "材质",
  custom: "自己调的",
  copyLink: "复制这套手感的链接",
  rain: "下球雨",
  reset: "复位",
  pokeHint: "戳戳我的大肚子！",
  loadingTitle: "奶蛙",
  camera: {
    title: "跟着我跳",
    sub: "你跳什么，奶蛙就学什么",
    start: "打开摄像头",
    starting: "正在打开…",
    stop: "关掉摄像头",
    mirror: "镜像",
    mirrorHint: "像照镜子一样，你举左手它举右手",
    tips: [
      { icon: "standBack", text: "往后退两三步，让头到脚都进画面" },
      { icon: "sunLight", text: "站在亮一点的地方，背景越简单越好" },
      { icon: "bigMove", text: "动作做大一点，奶蛙学得更像" },
    ] as { icon: IconName; text: string }[],
    privacy: "画面只在你的浏览器里处理，不会上传",
  },
  video: {
    title: "视频模仿",
    sub: "丢一段舞蹈视频，奶蛙照着跳",
    drop: "把视频拖到这里",
    pick: "选一个视频",
    dropBig: "松手，奶蛙就学这段舞！",
    notVideo: "这个好像不是视频哦",
    tips: [
      { icon: "person", text: "一个人、全身入镜的视频效果最好" },
      { icon: "standBack", text: "镜头别晃太厉害，正面或侧面都行" },
    ] as { icon: IconName; text: string }[],
    privacy: "视频只在你的浏览器里播放，不会上传",
  },
  dance: {
    title: "舞蹈库",
    sub: "挑一支舞，跳的时候也能戳它",
    empty: "舞蹈还在路上…",
    playing: "正在跳",
    loop: (s: number) => `${Math.round(s)} 秒一轮`,
    from: "动作来自",
  },
  pip: {
    camera: "摄像头",
    video: "视频",
    emptyCamera: "打开摄像头后，你会出现在这里",
    emptyVideo: "选好视频后，它会在这里播放",
  },
  rec: {
    title: "录好啦！",
    sub: (s: string) => `一共 ${s}，快拿去炫耀`,
    share: "保存 / 分享",
    copy: "复制链接",
    again: "再录一段",
    close: "关闭",
  },
  helpTitle: "怎么玩奶蛙",
  howTo: [
    ["点一下", "戳它的肚子"],
    ["按住拖动", "把它抓起来，甩出去"],
    ["快速划过", "拍它一巴掌"],
    ["羽毛来回蹭", "挠痒痒"],
    ["按住打气筒", "肚子越来越圆"],
  ] as [string, string][],
  keysTitle: "快捷键",
  themeTitle: "主题",
  themes: { system: "跟随系统", light: "白天", dark: "夜间" },
  toasts: {
    linkCopied: "链接复制好啦，发给朋友一起捏！",
    linkFailed: "复制没成功，再试一次？",
    shareFailed: "没能保存，再试一次？",
    recStart: "开始录制，尽情表演！",
  },
};

/** A little cheer at round numbers of pokes and throws. */
export function milestone(kind: "pokes" | "throws", n: number): string | null {
  const pokes: Record<number, string> = {
    10: "戳了 10 下！奶蛙开始脸红了",
    50: "50 下！肚子都快被戳出坑了",
    100: "100 下！你是戳肚子大师",
    500: "500 下……奶蛙想请你喝杯奶茶歇歇",
  };
  const throws: Record<number, string> = {
    5: "抛飞 5 次！奶蛙觉得自己会飞了",
    20: "20 次！奶蛙已经晕乎乎了",
  };
  return (kind === "pokes" ? pokes : throws)[n] ?? null;
}

/** Keyboard shortcuts as shown in the help dialog (handled in keys.ts). */
export const SHORTCUTS: [string[], string][] = [
  [["1", "2", "3", "4"], "手 / 丢球 / 羽毛 / 打气筒"],
  [["P", "C", "V", "D"], "捏捏 / 跟着跳 / 视频 / 舞蹈库"],
  [["B"], "下球雨"],
  [["X"], "复位"],
  [["R"], "开始 / 停止录制"],
  [["F"], "展开 / 收起手感"],
  [["M"], "镜像"],
  [["S"], "声音开关"],
  [["T"], "白天 / 夜间"],
  [["?"], "打开帮助"],
  [["Esc"], "关闭弹窗"],
];
