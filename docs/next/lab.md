# Next: Lab mode (after the current version is accepted)

The user wants, on their own machine, a chat interface through which Codex operates and optimises the toy, "a bit
like robotgen-v2's" agent conversation, plus buttons for Codex-driven jobs. Start it only after the current version
is accepted (user, 2026-10-16).

- Local only: `node lab/server.mjs` on 127.0.0.1 drives `codex exec --json` (one resumed thread per conversation),
  patterns from /home/zhiqili/robotgen-studio/robotgen/agents/. The public site stays static; Lab shows only when the
  server answers.
- Codex's tools operate the live page through the server (lab/bin/naiwa <action> <json>): state, params and
  per-region softness, modes and dances, poke/slap/grab-throw at regions, balls, reset, record, canvas screenshots,
  dances.
- Browser side `src/lab/` (`mountLab(...)` called by src/main.ts): a conversation panel beside the 3D view in the
  shape of RobotGen Studio's AgentChat (apps/studio/src/features/agent/: streaming messages, compact tool items,
  produced things as cards to apply or open, a running job with progress and stop), light and playful, bilingual.
- Detection (user, 2026-10-17: "检测本地有没有codex cli的登录", "如果有的话 在很多地方需要通过codex cli进行优化"): the
  server reports whether Codex CLI is installed and logged in (`codex --version`, `codex login status`). Logged in:
  Codex-driven optimisation is offered in many places, each next to what it optimises — the simulator's parameters and
  per-region softness, a retargeter's parameters and quality metrics, a user's block in the code lab, dances. Not
  installed or logged out: those entry points are hidden, and the Lab says how to install or log in.
- First example the user named — video → motion (2026-10-17): MediaPipe is per-frame and image-space, so a moving
  camera (pans, zooms, cuts) shows up as the person travelling, turning or hopping. With Codex available, "optimise
  this motion" runs locally: estimate the camera (static vs moving, shot cuts), then either a world-grounded
  video-to-motion model (GVHMR / WHAM / TRAM style, gravity-aligned with camera motion removed) or Codex-driven
  clean-up of the MediaPipe track (cut detection, camera-motion compensation from background features, foot-contact
  constraints), compared against the browser's track with the retarget metrics. Heavy models need a Python env (and
  ideally an NVIDIA GPU; this machine has only an AMD iGPU, so check speed before choosing). The goal the user
  stated: "animation 需要用codex 优化的更连贯一些" — the result must be temporally coherent (no jumps at cuts, no
  jitter, no drift or sliding feet), measured by the smoothness / foot-slide metrics before and after.
- Buttons: 优化手感 / Tune the feel (experiments on the soft body, judged by looking, saved as a preset);
  生成新舞蹈 / New dance from words (keyframed or text-to-motion, e.g. HY-Motion under .cache/envs/).
