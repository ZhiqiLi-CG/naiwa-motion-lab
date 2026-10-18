/**
 * Codex's JSONL events (`codex exec --json`) as the page shows them: messages, compact tool items (a command, a page
 * tool call through lab/bin/naiwa.mjs, file edits, a search), the plan, the end of a turn. One Codex event maps to at
 * most one page event; ids let the page update an item in place as it goes from running to done.
 */

const OUTPUT_TAIL = 1500;

/** `"C:\…\powershell.exe" -Command 'node lab/bin/naiwa.mjs poke region=belly'` → `node lab/bin/naiwa.mjs poke region=belly`;
 *  `/bin/bash -lc "…"` → `…`. */
export function cleanCommand(command) {
  const s = String(command ?? "").trim();
  const m = s.match(/^(?:"[^"]*(?:powershell|pwsh|cmd|bash|sh)(?:\.exe)?"|\S*(?:powershell|pwsh|cmd|bash|sh)(?:\.exe)?)\s+(?:-NoProfile\s+)?(?:-Command|-c|-lc|\/c|\/d \/c)\s+([\s\S]+)$/i);
  if (!m) return s;
  const inner = m[1].trim();
  if ((inner.startsWith("'") && inner.endsWith("'")) || (inner.startsWith('"') && inner.endsWith('"'))) return inner.slice(1, -1).replace(/''/g, "'");
  return inner;
}

/** A page tool call (`node lab/bin/naiwa.mjs <action> …`): its action and the rest. */
export function pageToolOf(command) {
  const m = cleanCommand(command).match(/naiwa\.mjs\s+([\w.-]+)\s*([\s\S]*)$/);
  return m ? { action: m[1], args: m[2].trim() } : null;
}

const tail = (s, n = OUTPUT_TAIL) => {
  const t = String(s ?? "");
  return t.length > n ? `…${t.slice(-n)}` : t;
};

/** One Codex event → one page event, or null for events the page does not show. */
export function mapCodexEvent(e) {
  switch (e?.type) {
    case "thread.started":
      return { type: "thread", id: e.thread_id };
    case "turn.started":
      return { type: "turn", status: "running" };
    case "turn.completed":
      return { type: "turn", status: "done", usage: e.usage ?? null };
    case "turn.failed":
      return { type: "turn", status: "failed", error: e.error?.message ?? "failed" };
    case "error":
      return { type: "error", text: e.message ?? "error" };
    case "item.started":
    case "item.updated":
    case "item.completed":
      return mapItem(e.item, e.type === "item.completed");
    default:
      return null;
  }
}

function mapItem(item, done) {
  if (!item) return null;
  const id = item.id;
  switch (item.type) {
    case "agent_message":
      return done ? { type: "message", id, role: "assistant", text: item.text ?? "" } : null;
    case "reasoning":
      return done && item.text ? { type: "thinking", id, text: tail(item.text, 600) } : null;
    case "command_execution": {
      const page = pageToolOf(item.command);
      const status = item.status === "in_progress" || !done ? "running" : item.exit_code === 0 ? "done" : "failed";
      return {
        type: "tool",
        id,
        tool: page ? "page" : "shell",
        title: page ? `${page.action}${page.args ? ` ${page.args}` : ""}` : cleanCommand(item.command),
        status,
        exitCode: item.exit_code ?? null,
        output: done ? tail(item.aggregated_output) : "",
      };
    }
    case "file_change":
      return {
        type: "tool",
        id,
        tool: "edit",
        title: (item.changes ?? []).map((c) => `${c.kind ?? "update"} ${c.path}`).join(", ") || "edit",
        status: !done ? "running" : item.status === "failed" ? "failed" : "done",
        exitCode: null,
        output: "",
      };
    case "mcp_tool_call":
      return { type: "tool", id, tool: "mcp", title: `${item.server ?? ""}.${item.tool ?? ""}`, status: !done ? "running" : item.status === "failed" ? "failed" : "done", exitCode: null, output: "" };
    case "web_search":
      return { type: "tool", id, tool: "search", title: item.query ?? "search", status: done ? "done" : "running", exitCode: null, output: "" };
    case "todo_list":
      return { type: "plan", id, items: (item.items ?? []).map((t) => ({ text: t.text, done: Boolean(t.completed) })) };
    case "error":
      return { type: "error", id, text: item.message ?? "error" };
    default:
      return null;
  }
}
