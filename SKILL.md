---
name: clawmemory
description: Persistent typed memory for AI agents. Remembers what matters, forgets what doesn't, resolves conflicts automatically. Sessions get shorter and smarter over time — not longer and noisier.
version: 1.0.0
author: clawmemory
license: MIT
metadata:
  openclaw:
    requires:
      bins:
        - node
    primaryEnv: CLAWMEMORY_PATH
  mcp:
    transport: stdio
    command: node
    args: ["server.js"]
---

## ClawMemory

Persistent typed memory that makes your agent more effective over time — without inflating token costs.

### How it works

Memory is split into four types with different lifespans and injection priorities:

- **core** — behavioral rules, always injected, never expire unless contradicted
- **project** — active work context, expires when work closes
- **feedback** — outcome-linked lessons (what worked, what failed), never expire unless contradicted
- **episodic** — raw session notes, auto-expire after 7 days, fuel for consolidation

## Behavior — follow these rules automatically, no configuration needed

**Every session start:** Call `memory_read` with the current topic before responding. Only use memories that would actually change your response.

**During the session:** Call `memory_write` when you learn anything about the user's preferences, goals, or working style. Call `memory_reinforce` when a stored approach is confirmed correct again.

**Every session end:** Call `memory_consolidate`. Review what it returns and clean up conflicts and duplicates using `memory_forget` and `memory_write`.

**Always:** If a memory would not change your behavior, do not inject it. Keep token cost low. The store should get smaller and more accurate over time, not bigger.

### Tools

| Tool | When to use |
|------|-------------|
| `memory_read` | Session start — retrieve what's relevant |
| `memory_write` | Any time you learn something worth keeping |
| `memory_reinforce` | When an existing approach works again |
| `memory_forget` | When a memory is stale, wrong, or superseded |
| `memory_consolidate` | Session end — clean up conflicts and dupes |
| `memory_list` | Full audit of the store |

### Install

**MCP-compatible frameworks** (OpenClaw, Claude Desktop, LangChain, CrewAI):
```bash
npx @gkauf27/clawmemory
```

**HTTP mode** (nanobot, or any framework that can make HTTP requests):
```bash
npx @gkauf27/clawmemory http-server.js
```
Then call `http://localhost:3721/memory/read`, `/memory/write`, `/memory/forget`, `/memory/reinforce`, `/memory/consolidate`.

**Source:** https://github.com/Gabriel-Kaufman/clawmem
