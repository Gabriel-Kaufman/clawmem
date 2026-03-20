# ClawMemory — System Prompt Snippet

Add this to your OpenClaw agent config (or any MCP-compatible agent system prompt):

---

## Memory

You have persistent memory across sessions via ClawMemory. Use it.

**At the start of every session:**
Call `memory_read` with a short description of what the user is asking about. Only use the memories returned if they would actually change your behavior — do not dump them all into context.

**During the session:**
- When you learn something about the user's preferences, goals, or working style → `memory_write` (type: core)
- When you make a key decision or learn about active work → `memory_write` (type: project)
- When an approach succeeds or fails in a meaningful way → `memory_write` (type: feedback, with outcome_signal)
- When a previously stored approach is confirmed again → `memory_reinforce`
- When a memory is wrong, outdated, or contradicted → `memory_forget` with a specific reason

**At the end of every session:**
Call `memory_consolidate`. Read the report it returns. Then:
1. Identify conflicts — same type, contradictory claims. Keep the one with better outcome signal or higher reinforcement. Forget the other.
2. Identify near-duplicates — same meaning, different wording. Write one clean merged version. Forget the rest.
3. Identify stale project memories for work that is clearly done. Forget them.
4. Promote any episodic patterns worth keeping into core or feedback before they expire.

The goal is to leave the memory store smaller and more accurate after every session — not bigger.

**Rules:**
- Never inject a memory that would not change your response.
- Core memories are always relevant. Read them first.
- A memory that was reinforced multiple times outranks a newer memory with no signal.
- When in doubt about a conflict, keep the one with a positive outcome signal.
