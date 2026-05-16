'use strict';

const fs   = require('fs');
const path = require('path');
const { HISTORY_DIR } = require('./configStore');

const INDEX_FILE = path.join(HISTORY_DIR, 'conversations.json');

function ensureDir() {
  fs.mkdirSync(HISTORY_DIR, { recursive: true });
}

function loadIndex() {
  ensureDir();
  try {
    if (fs.existsSync(INDEX_FILE)) {
      return JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
    }
  } catch { /* corrupt index, start fresh */ }
  return [];
}

function saveIndex(index) {
  ensureDir();
  fs.writeFileSync(INDEX_FILE, JSON.stringify(index, null, 2), 'utf8');
}

/**
 * Record a job/conversation from the worker process.
 * @param {Object} jobData — { id?, messages?, model?, timestamp? }
 */
function recordJob(jobData) {
  if (!jobData || !jobData.messages) return;

  const id = jobData.id || `conv-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const timestamp = jobData.timestamp || new Date().toISOString();

  // Save conversation file
  const convPath = path.join(HISTORY_DIR, `${id}.json`);
  const conversation = {
    id,
    timestamp,
    model: jobData.model || 'unknown',
    messages: jobData.messages,
    tokensUsed: jobData.tokensUsed || 0,
  };
  ensureDir();
  fs.writeFileSync(convPath, JSON.stringify(conversation, null, 2), 'utf8');

  // Update index
  const index = loadIndex();
  const preview = (jobData.messages[0]?.content || '').slice(0, 100);
  index.unshift({
    id,
    timestamp,
    model: conversation.model,
    preview,
    messageCount: conversation.messages.length,
  });

  // Keep last 500 conversations in index
  if (index.length > 500) index.length = 500;
  saveIndex(index);
}

function listConversations() {
  return loadIndex();
}

function getConversation(id) {
  const convPath = path.join(HISTORY_DIR, `${id}.json`);
  try {
    return JSON.parse(fs.readFileSync(convPath, 'utf8'));
  } catch {
    return null;
  }
}

module.exports = { recordJob, listConversations, getConversation };
