#!/usr/bin/env node
// Operate the live Naiwa Motion Lab page through the Lab server: node lab/bin/naiwa.mjs <action> [key=value … | json | @file.json]
// Prints the result as JSON. The actions are listed in lab/AGENTS.md.
import { naiwa, parseToolArgs } from "../lib/naiwa.mjs";

const [action, ...rest] = process.argv.slice(2);
if (!action || action === "help" || action === "--help") {
  console.log(`usage: node lab/bin/naiwa.mjs <action> [key=value ...] | '<json>' | @args.json
examples:
  node lab/bin/naiwa.mjs state
  node lab/bin/naiwa.mjs params.set softness=0.8 regionSoftness.belly=1
  node lab/bin/naiwa.mjs poke region=belly strength=0.7
  node lab/bin/naiwa.mjs probe scene=poke
  node lab/bin/naiwa.mjs screenshot
every action: lab/AGENTS.md`);
  process.exit(action ? 0 : 1);
}

try {
  const args = parseToolArgs(rest);
  const timeoutMs = Math.max(60000, (Number(args.seconds) || 0) * 1000 + 30000, Number(args.ms) + 30000 || 0);
  const value = await naiwa(action, args, { timeoutMs });
  console.log(JSON.stringify(value ?? null, null, 2));
} catch (e) {
  console.error(`naiwa ${action}: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
}
