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
- Buttons: 优化手感 / Tune the feel (experiments on the soft body, judged by looking, saved as a preset);
  生成新舞蹈 / New dance from words (keyframed or text-to-motion, e.g. HY-Motion under .cache/envs/).
