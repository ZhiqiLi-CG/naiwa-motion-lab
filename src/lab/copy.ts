/** The Lab's words, { zh, en } (shown with tr()). */
import type { Text } from "../i18n";

export const L = {
  title: { zh: "Codex 实验助手", en: "Codex lab" },
  close: { zh: "关闭", en: "Close" },
  newChat: { zh: "新对话", en: "New conversation" },
  connected: (v: string | null, how: string | null): Text => ({ zh: `Codex ${v ?? ""} · 已登录${how ? `（${how}）` : ""}`, en: `Codex ${v ?? ""} · logged in${how ? ` (${how})` : ""}` }),
  disconnected: { zh: "Lab 服务已断开", en: "Lab server disconnected" },
  placeholder: { zh: "让 Codex 在页面上试点什么…", en: "Ask Codex to try something on the page…" },
  send: { zh: "发送", en: "Send" },
  stop: { zh: "停止", en: "Stop" },
  keys: { zh: "Enter 发送 · Shift+Enter 换行", en: "Enter to send · Shift+Enter for a new line" },
  empty: {
    zh: "Codex 在你的电脑上运行，能读写这个仓库，也能直接操作这个页面：改参数、戳它、截图、比较指标。它不会提交或推送代码。",
    en: "Codex runs on your machine: it can read and edit this repository and operate this page — set parameters, poke the frog, take screenshots, compare metrics. It never commits or pushes.",
  },
  suggestions: [
    { zh: "把肚子调得更软一点，但别抖", en: "Make the belly softer, without jitter" },
    { zh: "戳一下头，截图看看凹陷", en: "Poke the head and look at the dent" },
    { zh: "比较两个模拟器的手感", en: "Compare the feel of the two simulators" },
  ] as Text[],
  you: { zh: "你", en: "You" },
  thinking: { zh: "Codex 在想…", en: "Codex is thinking…" },
  stopped: { zh: "已停止", en: "Stopped" },
  output: { zh: "输出", en: "Output" },
  tools: { page: { zh: "页面", en: "Page" }, shell: { zh: "命令", en: "Command" }, edit: { zh: "改文件", en: "Edit" }, mcp: { zh: "工具", en: "Tool" }, search: { zh: "搜索", en: "Search" } } as Record<string, Text>,
  plan: { zh: "计划", en: "Plan" },
  job: {
    running: { zh: "进行中", en: "Running" },
    done: { zh: "完成", en: "Done" },
    failed: { zh: "失败", en: "Failed" },
    stopped: { zh: "已停止", en: "Stopped" },
    stop: { zh: "停止", en: "Stop" },
    log: { zh: "过程", en: "Steps" },
    metric: { zh: "指标", en: "Metric" },
    before: { zh: "之前", en: "Before" },
    after: { zh: "之后", en: "After" },
    better: { zh: "更好", en: "better" },
    worse: { zh: "更差", en: "worse" },
    same: { zh: "持平", en: "same" },
    lowerBetter: { zh: "数值越小越好（peak 只说明动得多少）", en: "Lower is better (peak only says how much it moves)" },
  },
  start: { zh: "开始", en: "Start" },
  cancel: { zh: "取消", en: "Cancel" },
  goal: { zh: "目标（可选）", en: "Goal (optional)" },
  budget: { zh: "最多试几次", en: "At most this many tries" },
  usage: { zh: "会用到你的 Codex 额度。", en: "Uses your Codex quota." },
  describe: { zh: "描述这段舞蹈", en: "Describe the dance" },
  describeHint: { zh: "例如：左右摇摆两下，再举起双手转一圈", en: "e.g. sway left and right twice, then raise both hands and turn around" },
  artifacts: {
    preset: { zh: "参数预设", en: "Parameter preset" },
    dance: { zh: "舞蹈", en: "Dance" },
    block: { zh: "代码模块", en: "Code block" },
    file: { zh: "文件", en: "File" },
  } as Record<string, Text>,
  apply: {
    preset: { zh: "应用到参数", en: "Apply to the parameters" },
    dance: { zh: "存进我的舞蹈", en: "Save to My dances" },
    block: { zh: "载入代码实验室", en: "Load into the code lab" },
    file: { zh: "打开", en: "Open" },
  } as Record<string, Text>,
  applied: { zh: "已应用", en: "Applied" },
  appliedPreset: { zh: "参数已换成 Codex 的预设", en: "The parameters now use Codex's preset" },
  savedDance: (n: string): Text => ({ zh: `「${n}」存进我的舞蹈了`, en: `"${n}" saved to My dances` }),
  loadedBlock: { zh: "已作为你的实验载入代码实验室", en: "Loaded into the code lab as your experiment" },
  applyFailed: { zh: "没能应用", en: "Could not apply it" },
  noVideoTrack: { zh: "视频还没分析完", en: "The video is not analysed yet" },
  busy: { zh: "Codex 正忙，等它做完或先停止", en: "Codex is busy: wait for it or stop it first" },
  jobs: {
    feel: { zh: "优化手感", en: "Tune the feel" },
    coherence: { zh: "优化这段动作", en: "Improve this motion" },
    block: { zh: "让 Codex 改进这个模块", en: "Improve this block with Codex" },
    newDance: { zh: "生成新舞蹈", en: "New dance from words" },
    transfer: { zh: "优化动作迁移", en: "Optimise the transfer" },
  },
  newDanceSummary: {
    zh: "Codex 按你的描述用关键帧写一段舞蹈（DanceTrack），先在页面上预览，再交回来存进我的舞蹈。",
    en: "Codex keyframes a dance (a DanceTrack) from your words, previews it on the page, and hands it back for My dances.",
  },
};

/** The chat message for "优化动作迁移": Codex tunes the retargeter in use against its metrics. */
export const transferPrompt = (id: string, dance: string): Text => ({
  zh: `优化当前的动作迁移「${id}」：在舞蹈「${dance}」上用 retargeter.set 试不同的参数，每次用 metrics 读方向偏差、加加速度、四肢入体、脚滑，最后保留最好的一组在页面上，并告诉我改了什么。最多试 5 组。`,
  en: `Optimise the motion transfer "${id}": on the dance "${dance}", try settings with retargeter.set, read direction error, jerk, limb penetration and foot slide with metrics after each, leave the best set applied on the page and tell me what changed. At most 5 tries.`,
});

/** The chat message for "生成新舞蹈". */
export const newDancePrompt = (words: string): Text => ({
  zh: `按这个描述生成一段新舞蹈：「${words}」。用关键帧写一个 DanceTrack（格式见 src/contracts.ts 和 lab/AGENTS.md），存到 .cache/lab/dances/ 下，用 dance.preview 在页面上看效果（截图检查），满意后用 artifact kind=dance 交回来。`,
  en: `Make a new dance from this description: "${words}". Keyframe a DanceTrack (format in src/contracts.ts and lab/AGENTS.md), write it under .cache/lab/dances/, check it on the page with dance.preview (take a screenshot), and hand it back with artifact kind=dance when it looks right.`,
});
