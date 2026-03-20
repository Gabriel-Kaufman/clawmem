#!/usr/bin/env node
import http from 'http';
import fs from 'fs';
import path from 'path';
import { randomUUID, createHash } from 'crypto';
import os from 'os';

const PORT = process.env.CLAWMEMORY_PORT || 3721;
const MEMORY_DIR = process.env.CLAWMEMORY_PATH || path.join(os.homedir(), '.clawmemory');
const MEMORIES_DIR = path.join(MEMORY_DIR, 'memories');
const TOMBSTONES_DIR = path.join(MEMORY_DIR, 'tombstones');

fs.mkdirSync(MEMORIES_DIR, { recursive: true });
fs.mkdirSync(TOMBSTONES_DIR, { recursive: true });

// ─── Storage ──────────────────────────────────────────────────────────────────

function readMemory(id) {
  const file = path.join(MEMORIES_DIR, `${id}.json`);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeMemory(memory) {
  fs.writeFileSync(path.join(MEMORIES_DIR, `${memory.id}.json`), JSON.stringify(memory, null, 2));
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
  const memories = files.map(f => JSON.parse(fs.readFileSync(path.join(MEMORIES_DIR, f), 'utf8')));

  for (const m of memories) {
    if (m.type === 'episodic') {
      if (now - new Date(m.created_at).getTime() > 7 * 24 * 60 * 60 * 1000) {
        tombstone(m.id, 'Episodic expired after 7 days');
      }
    }
  }

  return fs.readdirSync(MEMORIES_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => JSON.parse(fs.readFileSync(path.join(MEMORIES_DIR, f), 'utf8')))
    .filter(m => !type || m.type === type);
}

function relevanceScore(memory, query) {
  const stop = new Set(['the','a','an','is','are','was','were','and','or','but','in','on','at','to','for','of','with','this','that','it','be','have','do','will','would','could','should']);
  const words = str => str.toLowerCase().split(/\W+/).filter(w => w.length > 2 && !stop.has(w));
  const qw = new Set(words(query));
  const cw = words(memory.content);
  let score = cw.filter(w => qw.has(w)).length / Math.max(qw.size, 1);
  if (memory.type === 'core') score += 0.4;
  if (memory.outcome_signal === 'positive') score += 0.15;
  if (memory.outcome_signal === 'negative') score += 0.1;
  score += Math.min((memory.reinforcement_count || 0) * 0.05, 0.25);
  return score;
}

function findDuplicate(content, type) {
  const hash = createHash('sha256').update(content.trim().toLowerCase()).digest('hex');
  const stop = new Set(['the','a','an','is','are','was','were','and','or','but','in','on','at','to','for','of','with','this','that','it','be','have','do','will','would','could','should']);
  const words = str => new Set(str.toLowerCase().split(/\W+/).filter(w => w.length > 2 && !stop.has(w)));
  const newWords = words(content);

  for (const m of allMemories(type)) {
    if (createHash('sha256').update(m.content.trim().toLowerCase()).digest('hex') === hash) {
      return { type: 'exact', memory: m };
    }
    const mWords = words(m.content);
    const union = new Set([...newWords, ...mWords]);
    const overlap = [...newWords].filter(w => mWords.has(w)).length;
    if (overlap / union.size > 0.8) return { type: 'near', memory: m, similarity: overlap / union.size };
  }
  return null;
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

const routes = {
  'POST /memory/write': (body) => {
    const dupe = findDuplicate(body.content, body.type);
    if (dupe?.type === 'exact') return { duplicate: 'exact', existing_id: dupe.memory.id, message: 'Identical memory exists. Use /memory/reinforce if the approach was confirmed again.' };
    if (dupe?.type === 'near') return { duplicate: 'near', similarity: dupe.similarity, existing: dupe.memory, message: `Near-duplicate found. Send replaces: "${dupe.memory.id}" to supersede it.` };
    if (body.replaces) tombstone(body.replaces, `Superseded by: "${body.content.slice(0, 100)}"`);
    const memory = {
      id: randomUUID(),
      type: body.type,
      content: body.content,
      outcome_signal: body.outcome_signal || 'neutral',
      tags: body.tags || [],
      reinforcement_count: 0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    writeMemory(memory);
    return { ok: true, id: memory.id, type: memory.type };
  },

  'POST /memory/read': (body) => {
    const limit = body.limit || 8;
    const memories = allMemories(body.type || null)
      .map(m => ({ ...m, _score: relevanceScore(m, body.query) }))
      .sort((a, b) => b._score - a._score)
      .slice(0, limit)
      .filter(m => m._score > 0.15)
      .map(({ _score, ...m }) => m);
    return { memories };
  },

  'POST /memory/forget': (body) => {
    const ok = tombstone(body.id, body.reason);
    return ok ? { ok: true } : { ok: false, message: 'Memory not found' };
  },

  'POST /memory/reinforce': (body) => {
    const memory = readMemory(body.id);
    if (!memory) return { ok: false, message: 'Memory not found' };
    memory.reinforcement_count = (memory.reinforcement_count || 0) + 1;
    if (body.outcome_signal) memory.outcome_signal = body.outcome_signal;
    memory.updated_at = new Date().toISOString();
    writeMemory(memory);
    return { ok: true, reinforcement_count: memory.reinforcement_count };
  },

  'POST /memory/consolidate': () => {
    const memories = allMemories();
    const grouped = memories.reduce((acc, m) => { (acc[m.type] ||= []).push(m); return acc; }, {});
    return {
      total: memories.length,
      by_type: Object.fromEntries(Object.entries(grouped).map(([k, v]) => [k, v.length])),
      store: grouped,
      instructions: 'Review store for conflicts and duplicates. Use /memory/forget + /memory/write to clean up. Goal: smaller and more accurate after every consolidation.',
    };
  },

  'GET /memory/list': (_, query) => {
    const memories = allMemories(query.type || null);
    const grouped = memories.reduce((acc, m) => { (acc[m.type] ||= []).push(m); return acc; }, {});
    return { total: memories.length, store: grouped };
  },
};

// ─── Server ───────────────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  const [pathname, search] = (req.url || '/').split('?');
  const query = Object.fromEntries(new URLSearchParams(search || ''));
  const routeKey = `${req.method} ${pathname}`;

  const send = (status, data) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  };

  if (!routes[routeKey]) return send(404, { error: `Unknown route: ${routeKey}` });

  if (req.method === 'GET') {
    try { send(200, routes[routeKey](null, query)); }
    catch (e) { send(500, { error: e.message }); }
    return;
  }

  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', () => {
    try {
      const parsed = body ? JSON.parse(body) : {};
      send(200, routes[routeKey](parsed, query));
    } catch (e) {
      send(500, { error: e.message });
    }
  });
});

server.listen(PORT, () => {
  console.log(`ClawMemory HTTP server running on http://localhost:${PORT}`);
  console.log(`Memory store: ${MEMORY_DIR}`);
});
