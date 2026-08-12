#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import { createArbiterClaudeGuardrail } from "../src/guardrail.js";

export async function runHook({ input = process.stdin, output = process.stdout, error = process.stderr, env = process.env } = {}) {
  let raw = "";
  for await (const chunk of input) raw += chunk;

  let event;
  try {
    event = JSON.parse(raw);
  } catch (parseError) {
    output.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: `Arbiter hook received invalid input: ${String(parseError)}`
      }
    }));
    return;
  }

  const guardrail = createArbiterClaudeGuardrail({ env, logger: { warn: (message) => error.write(`${message}\n`) } });
  const result = await guardrail.handle(event);
  if (result !== undefined) output.write(JSON.stringify(result));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  runHook().catch((hookError) => {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: `Arbiter hook failed closed: ${String(hookError)}`
      }
    }));
  });
}
