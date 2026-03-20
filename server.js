#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import fs from 'fs';
import path from 'path';
import { randomUUID, createHash } from 'crypto';
import os from 'os';

// ─── Storage setup ────────────────────────────────────────────────────────────

const MEMORY_DIR = process.env.CLAWMEMORY_PATH || path.join(os.homedir(), '.clawmemory');
const MEMORIES_DIR = path.join(MEMORY_DIR, 'memories');
const TOMBSTONES_DIR = path.join(MEMORY_DIR, 'tombstones');

fs.mkdirSync(MEMORIES_DIR, { recursive: true });
fs.mkdirSync(TOMBSTONES_DIR, { recursive: true });

// ─── Memory types ─────────────────────────────────────────────────────────────
//
//  core      — behavioral rules. Always injected. Never expires unless contradicted.
//              Phrased as instructions: "Always use TypeScript. Never ask about stack."
//
//  project   — active work context. Expires when project closes.
//              What's being built, key decisions, open blockers.
//
//  feedback  — outcome-linked lessons. What worked, what failed, and why.
//              Never expires unless contradicted by a newer outcome.
//
//  episodic  — raw session notes. Auto-expires after 7 days.
//              Fuel for consolidation — promotes patterns into core/feedback.

// ─── File I/O ─────────────────────────────────────────────────────────────────

function readMemory(id) {
  const file = path.join(MEMORIES_DIR, `${id}.json`);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeMemory(memory) {
  fs.writeFileSync(
    path.join(MEMORIES_DIR, `${memory.id}.json`),
    JSON.stringify(memory, null, 2)
  );
}

function tombstone(id, reason) {
  const memory = readMemory(id);
  if (!memory) return false;
  fs.writeFileSync(
    path.join(TOMBSTONES_DIR, `${id}.json`),
    JSON.stringify({ original_id: id, original_memory: memory, reason, removed_at: new Date().toISOString() }, null, 2)
  );
  fs.unlinkSync(path.join(MEMORIES_DIR, `${id}.json`));
  return true;
}

function allMemories(type = null) {
  const now = Date.now();

  const files = fs.readdirSync(MEMORIES_DIR).filter(f => f.endsWith('.json'));
  const memories = files.map(f =>
    JSON.parse(fs.readFileSync(path.join(MEMORIES_DIR, f), 'utf8'))
  );

  // Auto-expire episodics older than 7 days
  for (const m of memories) {
    if (m.type === 'episodic') {
      const ageMs = now - new Date(m.created_at).getTime();
      if (ageMs > 7 * 24 * 60 * 60 * 1000) {
        tombstone(m.id, 'Episodic expired after 7 days');
      }
    }
  }

  // Re-read clean list after expiry
  return fs.readdirSync(MEMORIES_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => JSON.parse(fs.readFileSync(path.join(MEMORIES_DIR, f), 'utf8')))
    .filter(m => !type || m.type === type);
}

// ─── Relevance scoring ────────────────────────────────────────────────────────
//
// Scores how much a memory should affect behavior given the current query.
// Keyword overlap is cheap and good enough — the agent does the smart filtering.

function relevanceScore(memory, query) {
  const stopwords = new Set(['the','a','an','is','are','was','were','and','or','but','in','on','at','to','for','of','with','this','that','it','be','have','do','will','would','could','should']);
  const words = str => str.toLowerCase().split(/\W+/).filter(w => w.length > 2 && !stopwords.has(w));

  const queryWords = new Set(words(query));
  const contentWords = words(memory.content);
  const overlap = contentWords.filter(w => queryWords.has(w)).length;

  let score = overlap / Math.max(queryWords.size, 1);

  // Boost signals
  if (memory.type === 'core') score += 0.4;                            // behavioral rules always relevant
  if (memory.outcome_signal === 'positive') score += 0.15;
  if (memory.outcome_signal === 'negative') score += 0.1;             // failures are relevant too
  score += Math.min(memory.reinforcement_count * 0.05, 0.25);        // cap reinforcement boost

  return score;
}

// ─── Duplicate detection ──────────────────────────────────────────────────────
//
// Checks if a near-identical memory already exists before writing.
// Uses content hash for exact dupes, keyword overlap for near-dupes.

function findDuplicate(content, type) {
  const hash = createHash('sha256').update(content.trim().toLowerCase()).digest('hex');
  const existing = allMemories(type);

  // Exact dupe
  for (const m of existing) {
    const mHash = createHash('sha256').update(m.content.trim().toLowerCase()).digest('hex');
    if (mHash === hash) return { type: 'exact', memory: m };
  }

  // Near-dupe: >80% keyword overlap
  const stopwords = new Set(['the','a','an','is','are','was','were','and','or','but','in','on','at','to','for','of','with','this','that','it','be','have','do','will','would','could','should']);
  const words = str => new Set(str.toLowerCase().split(/\W+/).filter(w => w.length > 2 && !stopwords.has(w)));
  const newWords = words(content);

  for (const m of existing) {
    const mWords = words(m.content);
    const union = new Set([...newWords, ...mWords]);
    const intersection = [...newWords].filter(w => mWords.has(w));
    const similarity = intersection.length / union.size;
    if (similarity > 0.8) return { type: 'near', memory: m, similarity };
  }

  return null;
}

// ─── MCP Server ───────────────────────────────────────────────────────────────

const server = new Server(
  { name: 'clawmemory', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'memory_write',
      description: [
        'Store a new memory. Pick the right type:',
        '  core     — behavioral rule ("Always use TypeScript", "Never ask about stack preference")',
        '  project  — active work context (what is being built, key decisions, open blockers)',
        '  feedback — outcome-linked lesson (what worked or failed, and why)',
        '  episodic — raw session note (temporary, expires in 7 days, used for consolidation)',
        'The system detects duplicates before writing. Use `replaces` to explicitly supersede a conflicting memory.',
      ].join('\n'),
      inputSchema: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['core', 'project', 'feedback', 'episodic'] },
          content: { type: 'string', description: 'For core type, phrase as a direct behavioral instruction.' },
          outcome_signal: { type: 'string', enum: ['positive', 'negative', 'neutral'], default: 'neutral' },
          tags: { type: 'array', items: { type: 'string' } },
          replaces: { type: 'string', description: 'ID of a memory this supersedes. Will be tombstoned with a reason.' },
        },
        required: ['type', 'content'],
      },
    },
    {
      name: 'memory_read',
      description: [
        'Retrieve memories relevant to the current query, ranked by behavioral relevance.',
        'IMPORTANT: Only use memories that would actually change what you do.',
        'If a memory would not change your response, ignore it — do not bloat context.',
        'Core memories are always boosted. Reinforced memories rank higher.',
      ].join('\n'),
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Describe what you need context for.' },
          type: { type: 'string', enum: ['core', 'project', 'feedback', 'episodic'], description: 'Filter by type (omit for all).' },
          limit: { type: 'number', description: 'Max results. Default 8. Keep low — only inject what changes behavior.' },
        },
        required: ['query'],
      },
    },
    {
      name: 'memory_forget',
      description: [
        'Delete a memory. The deletion is tombstoned (not permanently erased) so the agent cannot re-learn the same wrong thing next session.',
        'Use when a memory is: stale, superseded, conflicting with a better memory, or from a closed project.',
        'Always provide a clear reason.',
      ].join('\n'),
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          reason: { type: 'string', description: 'Why this memory is being removed. Be specific.' },
        },
        required: ['id', 'reason'],
      },
    },
    {
      name: 'memory_reinforce',
      description: 'Confirm that a memory is still valid and its approach produced a good outcome. Increases its ranking in future reads. Call when something works as expected.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          outcome_signal: { type: 'string', enum: ['positive', 'negative', 'neutral'] },
        },
        required: ['id'],
      },
    },
    {
      name: 'memory_consolidate',
      description: [
        'Run at the END of every session. Does two things:',
        '1. Expires stale episodics (auto).',
        '2. Returns the full memory store grouped by type for you to audit.',
        'After receiving the store, you MUST:',
        '  - Identify conflicts (same type, contradictory content) — keep the one with better outcome or reinforcement, forget the other.',
        '  - Identify duplicates (same meaning, different wording) — merge into one, forget the rest.',
        '  - Identify stale project memories for work that is clearly finished — forget them.',
        '  - Promote any episodic patterns worth keeping into core or feedback before they expire.',
        'Use memory_forget + memory_write to clean up. Leave the store smaller than you found it.',
      ].join('\n'),
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'memory_list',
      description: 'List all memories, optionally filtered by type. Use during consolidation or when you need a full audit.',
      inputSchema: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['core', 'project', 'feedback', 'episodic'] },
        },
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  switch (name) {

    case 'memory_write': {
      // Duplicate check before writing
      const dupe = findDuplicate(args.content, args.type);
      if (dupe?.type === 'exact') {
        return { content: [{ type: 'text', text: `Duplicate detected — identical memory already exists (id: ${dupe.memory.id}). Use memory_reinforce if the approach was confirmed again.` }] };
      }
      if (dupe?.type === 'near') {
        return { content: [{ type: 'text', text: `Near-duplicate detected (${Math.round(dupe.similarity * 100)}% similar) — existing memory: ${JSON.stringify(dupe.memory, null, 2)}\n\nIf this supersedes it, call memory_write again with replaces: "${dupe.memory.id}". If it's the same thing, use memory_reinforce instead.` }] };
      }

      // Tombstone superseded memory
      if (args.replaces) {
        tombstone(args.replaces, `Superseded by: "${args.content.slice(0, 100)}"`);
      }

      const memory = {
        id: randomUUID(),
        type: args.type,
        content: args.content,
        outcome_signal: args.outcome_signal || 'neutral',
        tags: args.tags || [],
        reinforcement_count: 0,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      writeMemory(memory);
      return { content: [{ type: 'text', text: `Stored [${memory.type}] ${memory.id}: "${memory.content.slice(0, 80)}${memory.content.length > 80 ? '...' : ''}"` }] };
    }

    case 'memory_read': {
      const memories = allMemories(args.type || null);
      const limit = args.limit || 8;

      const scored = memories
        .map(m => ({ ...m, _score: relevanceScore(m, args.query) }))
        .sort((a, b) => b._score - a._score)
        .slice(0, limit)
        .filter(m => m._score > 0.15) // noise floor
        .map(({ _score, ...m }) => m);

      if (scored.length === 0) {
        return { content: [{ type: 'text', text: 'No relevant memories found.' }] };
      }

      return { content: [{ type: 'text', text: JSON.stringify(scored, null, 2) }] };
    }

    case 'memory_forget': {
      const ok = tombstone(args.id, args.reason);
      return { content: [{ type: 'text', text: ok ? `Forgot ${args.id}: "${args.reason}"` : `Memory ${args.id} not found.` }] };
    }

    case 'memory_reinforce': {
      const memory = readMemory(args.id);
      if (!memory) return { content: [{ type: 'text', text: `Memory ${args.id} not found.` }] };

      memory.reinforcement_count = (memory.reinforcement_count || 0) + 1;
      if (args.outcome_signal) memory.outcome_signal = args.outcome_signal;
      memory.updated_at = new Date().toISOString();

      writeMemory(memory);
      return { content: [{ type: 'text', text: `Reinforced ${args.id} (x${memory.reinforcement_count})` }] };
    }

    case 'memory_consolidate': {
      // Staleness expiry runs inside allMemories()
      const memories = allMemories();

      const grouped = memories.reduce((acc, m) => {
        (acc[m.type] ||= []).push(m);
        return acc;
      }, {});

      const report = {
        total: memories.length,
        by_type: Object.fromEntries(Object.entries(grouped).map(([k, v]) => [k, v.length])),
        store: grouped,
        instructions: [
          'Audit the store above. You MUST:',
          '1. Find conflicts (same type, contradictory claims) — keep better outcome/reinforcement, forget the other with reason.',
          '2. Find near-duplicates (same meaning, different wording) — write one merged version, forget the rest.',
          '3. Find stale project memories for finished work — forget them.',
          '4. Promote valuable episodic patterns to core or feedback before they expire.',
          'Goal: leave the store smaller and more accurate than you found it.',
        ].join('\n'),
      };

      return { content: [{ type: 'text', text: JSON.stringify(report, null, 2) }] };
    }

    case 'memory_list': {
      const memories = allMemories(args.type || null);
      const grouped = memories.reduce((acc, m) => {
        (acc[m.type] ||= []).push(m);
        return acc;
      }, {});
      return { content: [{ type: 'text', text: JSON.stringify(grouped, null, 2) }] };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
