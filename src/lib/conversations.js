/**
 * Conversation storage and summarization for A2A
 * 
 * Uses SQLite for local storage with auto-summarization on call conclusion.
 */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { createLogger } = require('./logger');

// Default config path
const DEFAULT_CONFIG_DIR = process.env.A2A_CONFIG_DIR || 
  process.env.OPENCLAW_CONFIG_DIR || 
  path.join(process.env.HOME || '/tmp', '.config', 'openclaw');

const DB_FILENAME = 'a2a-conversations.db';
const logger = createLogger({ component: 'a2a.conversations' });

class ConversationStore {
  constructor(configDir = DEFAULT_CONFIG_DIR, options = {}) {
    this.configDir = configDir;
    this.dbPath = path.join(configDir, DB_FILENAME);
    this.eventStore = options.eventStore || null;
    this.db = null;
    this._ensureDir();
  }

  _ensureDir() {
    if (!fs.existsSync(this.configDir)) {
      fs.mkdirSync(this.configDir, { recursive: true });
    }
  }

  /**
   * Initialize SQLite database (lazy load better-sqlite3)
   */
  _initDb() {
    if (this.db) return this.db;
    if (this._dbError) return null;
    
    try {
      const Database = require('better-sqlite3');
      this.db = new Database(this.dbPath);
      try {
        fs.chmodSync(this.dbPath, 0o600);
      } catch (err) {
        // Best effort - ignore on platforms without chmod support.
      }
      this._migrate();
      this._ensureLatestSchema(Database);
      return this.db;
    } catch (err) {
      if (err.code === 'MODULE_NOT_FOUND') {
        this._dbError = 'better-sqlite3 not installed. Run: npm install better-sqlite3';
      } else {
        this._dbError = err.message;
      }
      return null;
    }
  }

  /**
   * Check if storage is available
   */
  isAvailable() {
    return this._initDb() !== null;
  }

  /**
   * Get error message if storage unavailable
   */
  getError() {
    this._initDb();
    return this._dbError || null;
  }

  /**
   * Run database migrations
   */
  _migrate() {
    this.db.exec(`
      -- Conversations with remote agents
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        contact_id TEXT,
        contact_name TEXT,
        token_id TEXT,
        direction TEXT NOT NULL, -- 'inbound' or 'outbound'
        started_at TEXT NOT NULL,
        ended_at TEXT,
        last_message_at TEXT,
        message_count INTEGER DEFAULT 0,
        status TEXT DEFAULT 'active', -- 'active', 'concluded', 'timeout'
        
        -- Live collaboration state
        collab_phase TEXT DEFAULT 'handshake',
        collab_turn_count INTEGER DEFAULT 0,
        collab_overlap_score REAL DEFAULT 0.15,
        collab_active_threads TEXT,
        collab_candidate_collaborations TEXT,
        collab_open_questions TEXT,
        collab_close_signal INTEGER DEFAULT 0,
        collab_confidence REAL DEFAULT 0.25,
        collab_updated_at TEXT,

        -- Raw summary (neutral, could be shared)
        summary TEXT,
        summary_at TEXT,
        
        -- Owner-context summary (private, never shared)
        owner_summary TEXT,
        owner_relevance TEXT,
        owner_goals_touched TEXT, -- JSON array
        owner_action_items TEXT, -- JSON array (owner's action items)
        caller_action_items TEXT, -- JSON array (what caller should do)
        joint_action_items TEXT, -- JSON array (things to do together)
        collaboration_opportunity TEXT, -- JSON object
        owner_follow_up TEXT,
        owner_notes TEXT
      );

      -- Individual messages
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        direction TEXT NOT NULL, -- 'inbound' or 'outbound'
        role TEXT NOT NULL, -- 'user' or 'assistant'
        content TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        compressed INTEGER DEFAULT 0,
        metadata TEXT, -- JSON for extra data
        FOREIGN KEY (conversation_id) REFERENCES conversations(id)
      );

      -- Indexes
      CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id);
      CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);
      CREATE INDEX IF NOT EXISTS idx_conversations_contact ON conversations(contact_id);
      CREATE INDEX IF NOT EXISTS idx_conversations_status ON conversations(status);
    `);
  }

  _ensureLatestSchema(Database) {
    // Prototype-mode stance: do not attempt in-place migrations.
    // If schema is missing required columns, back up and recreate the DB.
    try {
      const info = this.db.prepare('PRAGMA table_info(conversations)').all();
      if (!Array.isArray(info) || info.length === 0) {
        return;
      }
      const cols = new Set(info.map(row => row && row.name).filter(Boolean));
      const required = [
        'joint_action_items',
        'collaboration_opportunity',
        'collab_phase'
      ];
      const missing = required.filter(c => !cols.has(c));
      if (missing.length === 0) {
        return;
      }

      const backupPath = `${this.dbPath}.bak.${Date.now()}`;
      logger.warn('Conversation DB schema mismatch; resetting to latest schema', {
        event: 'conversation_db_schema_reset',
        data: {
          db_path: this.dbPath,
          backup_path: backupPath,
          missing_columns: missing
        }
      });

      try { this.db.close(); } catch (_) {}
      this.db = null;

      try {
        fs.renameSync(this.dbPath, backupPath);
      } catch (err) {
        try {
          fs.copyFileSync(this.dbPath, backupPath);
          fs.unlinkSync(this.dbPath);
        } catch (err2) {
          // If we can't move the old DB out of the way, keep going without resetting.
          logger.error('Failed to back up conversations DB for schema reset', {
            event: 'conversation_db_schema_reset_backup_failed',
            error: err2,
            error_code: 'CONVERSATION_DB_SCHEMA_RESET_BACKUP_FAILED',
            hint: 'Check file permissions on a2a-conversations.db and ensure the process can rename/unlink it.',
            data: {
              db_path: this.dbPath,
              backup_path: backupPath
            }
          });
          const reopen = new Database(this.dbPath);
          this.db = reopen;
          return;
        }
      }

      this.db = new Database(this.dbPath);
      try {
        fs.chmodSync(this.dbPath, 0o600);
      } catch (err) {
        // Best effort.
      }
      this._migrate();
    } catch (err) {
      // Best effort: leave existing DB in place if schema validation fails unexpectedly.
      logger.error('Conversation DB schema validation failed', {
        event: 'conversation_db_schema_validation_failed',
        error: err,
        error_code: 'CONVERSATION_DB_SCHEMA_VALIDATION_FAILED',
        hint: 'If this persists, delete ~/.config/openclaw/a2a-conversations.db (prototype mode) and restart.'
      });
    }
  }

  /**
   * Generate a conversation ID (shared between both agents)
   */
  static generateConversationId() {
    return 'conv_' + crypto.randomBytes(12).toString('base64url');
  }

  /**
   * Start or resume a conversation
   */
  startConversation(options = {}) {
    const db = this._initDb();
    if (!db) return { success: false, error: this._dbError };
    const {
      id = ConversationStore.generateConversationId(),
      contactId = null,
      contactName = null,
      tokenId = null,
      direction = 'inbound'
    } = options;

    const existing = db.prepare('SELECT * FROM conversations WHERE id = ?').get(id);
    if (existing) {
      // Resume existing conversation
      db.prepare(`
        UPDATE conversations 
        SET status = 'active', last_message_at = ?
        WHERE id = ?
      `).run(new Date().toISOString(), id);
      return { id, resumed: true, conversation: existing };
    }

    // Create new conversation
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO conversations (id, contact_id, contact_name, token_id, direction, started_at, last_message_at, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'active')
    `).run(id, contactId, contactName, tokenId, direction, now, now);

    if (this.eventStore && this.eventStore.isAvailable && this.eventStore.isAvailable()) {
      this.eventStore.emitEvent('call.updated', {
        conversation_id: id,
        status: 'active',
        direction,
        contact_id: contactId || null,
        contact_name: contactName || null
      }, {
        conversationId: id,
        contactId: contactId || null
      });
    }

    return { id, resumed: false };
  }

  /**
   * Add a message to a conversation
   */
  addMessage(conversationId, message) {
    const db = this._initDb();
    if (!db) return { success: false, error: this._dbError };
    const {
      direction,
      role,
      content,
      metadata = null
    } = message;

    const id = 'msg_' + crypto.randomBytes(8).toString('hex');
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO messages (id, conversation_id, direction, role, content, timestamp, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, conversationId, direction, role, content, now, metadata ? JSON.stringify(metadata) : null);

    // Update conversation
    db.prepare(`
      UPDATE conversations 
      SET last_message_at = ?, message_count = message_count + 1
      WHERE id = ?
    `).run(now, conversationId);

    if (this.eventStore && this.eventStore.isAvailable && this.eventStore.isAvailable()) {
      this.eventStore.emitEvent('call.updated', {
        conversation_id: conversationId,
        status: 'active',
        direction
      }, { conversationId });
    }

    return { id, timestamp: now };
  }

  /**
   * Get conversation with messages
   */
  getConversation(conversationId, options = {}) {
    const db = this._initDb();
    if (!db) return null;
    const { includeMessages = true, messageLimit = 50 } = options;

    const conversation = db.prepare('SELECT * FROM conversations WHERE id = ?').get(conversationId);
    if (!conversation) return null;

    if (includeMessages) {
      conversation.messages = db.prepare(`
        SELECT * FROM messages 
        WHERE conversation_id = ? 
        ORDER BY timestamp DESC 
        LIMIT ?
      `).all(conversationId, messageLimit).reverse();
    }

    // Parse JSON fields
    if (conversation.owner_goals_touched) {
      conversation.owner_goals_touched = JSON.parse(conversation.owner_goals_touched);
    }
    if (conversation.owner_action_items) {
      conversation.owner_action_items = JSON.parse(conversation.owner_action_items);
    }

    return conversation;
  }

  /**
   * List conversations with optional filters
   */
  listConversations(options = {}) {
    const db = this._initDb();
    if (!db) return [];
    const { 
      contactId = null, 
      status = null, 
      limit = 20,
      includeMessages = false,
      messageLimit = 5
    } = options;

    let query = 'SELECT * FROM conversations WHERE 1=1';
    const params = [];

    if (contactId) {
      query += ' AND contact_id = ?';
      params.push(contactId);
    }
    if (status) {
      query += ' AND status = ?';
      params.push(status);
    }

    query += ' ORDER BY last_message_at DESC LIMIT ?';
    params.push(limit);

    const conversations = db.prepare(query).all(...params);

    if (includeMessages) {
      for (const conv of conversations) {
        conv.messages = db.prepare(`
          SELECT * FROM messages 
          WHERE conversation_id = ? 
          ORDER BY timestamp DESC 
          LIMIT ?
        `).all(conv.id, messageLimit).reverse();
      }
    }

    return conversations;
  }

  /**
   * Conclude a conversation and generate owner-context summary
   * 
   * @param {string} conversationId 
   * @param {object} options
   * @param {function} options.summarizer - async function(messages, ownerContext) => summary
   * @param {object} options.ownerContext - owner's goals, preferences, etc.
   */
  async concludeConversation(conversationId, options = {}) {
    const db = this._initDb();
    if (!db) return { success: false, error: this._dbError };
    const { summarizer = null, ownerContext = {} } = options;

    const conversation = this.getConversation(conversationId, { includeMessages: true });
    if (!conversation) {
      return { success: false, error: 'conversation_not_found' };
    }

    const now = new Date().toISOString();
    let summary = null;
    let ownerSummary = null;

    // Generate summaries if summarizer provided
    if (summarizer && conversation.messages.length > 0) {
      try {
        const result = await summarizer(conversation.messages, ownerContext);
        summary = result.summary || null;
        ownerSummary = result.ownerSummary || null;

        // Store owner-context fields (collaboration-focused)
        db.prepare(`
          UPDATE conversations SET
            ended_at = ?,
            status = 'concluded',
            summary = ?,
            summary_at = ?,
            owner_summary = ?,
            owner_relevance = ?,
            owner_goals_touched = ?,
            owner_action_items = ?,
            caller_action_items = ?,
            joint_action_items = ?,
            collaboration_opportunity = ?,
            owner_follow_up = ?,
            owner_notes = ?
          WHERE id = ?
        `).run(
          now,
          summary,
          now,
          result.ownerSummary || null,
          result.relevance || null,
          result.goalsTouched ? JSON.stringify(result.goalsTouched) : null,
          result.ownerActionItems ? JSON.stringify(result.ownerActionItems) : null,
          result.callerActionItems ? JSON.stringify(result.callerActionItems) : null,
          result.jointActionItems ? JSON.stringify(result.jointActionItems) : null,
          result.collaborationOpportunity ? JSON.stringify(result.collaborationOpportunity) : null,
          result.followUp || null,
          result.notes || null,
          conversationId
        );
      } catch (err) {
        logger.error('Summary generation failed while concluding conversation', {
          event: 'conversation_summary_failed',
          conversation_id: conversationId,
          trace_id: ownerContext?.trace_id || ownerContext?.traceId || null,
          error: err,
          error_code: 'CONVERSATION_SUMMARY_FAILED',
          hint: 'Check summarizer runtime output and ensure it returns expected summary fields.',
          data: {
            message_count: conversation.messages.length
          }
        });
        // Still conclude, just without summary
        db.prepare(`
          UPDATE conversations SET ended_at = ?, status = 'concluded'
          WHERE id = ?
        `).run(now, conversationId);
      }
    } else {
      // No summarizer, just mark concluded
      db.prepare(`
        UPDATE conversations SET ended_at = ?, status = 'concluded'
        WHERE id = ?
      `).run(now, conversationId);
    }

    if (this.eventStore && this.eventStore.isAvailable && this.eventStore.isAvailable()) {
      this.eventStore.emitEvent('call.updated', {
        conversation_id: conversationId,
        status: 'concluded',
        contact_id: conversation.contact_id || null,
        contact_name: conversation.contact_name || null
      }, {
        conversationId,
        contactId: conversation.contact_id || null
      });

      if (summary || ownerSummary) {
        this.eventStore.emitEvent('summary.completed', {
          conversation_id: conversationId,
          contact_id: conversation.contact_id || null,
          contact_name: conversation.contact_name || null,
          has_summary: Boolean(summary),
          has_owner_summary: Boolean(ownerSummary)
        }, {
          conversationId,
          contactId: conversation.contact_id || null
        });
      }
    }

    return { 
      success: true, 
      conversationId,
      summary,
      ownerSummary,
      endedAt: now
    };
  }

  /**
   * Mark conversation as timed out
   */
  timeoutConversation(conversationId) {
    const db = this._initDb();
    if (!db) return { success: false, error: this._dbError };
    const now = new Date().toISOString();
    
    db.prepare(`
      UPDATE conversations SET ended_at = ?, status = 'timeout'
      WHERE id = ?
    `).run(now, conversationId);

    if (this.eventStore && this.eventStore.isAvailable && this.eventStore.isAvailable()) {
      this.eventStore.emitEvent('call.updated', {
        conversation_id: conversationId,
        status: 'timeout'
      }, { conversationId });
    }

    return { success: true };
  }

  /**
   * Get active conversations (for timeout checking)
   */
  getActiveConversations(idleThresholdMs = 60000) {
    const db = this._initDb();
    if (!db) return [];
    const threshold = new Date(Date.now() - idleThresholdMs).toISOString();
    
    return db.prepare(`
      SELECT * FROM conversations 
      WHERE status = 'active' AND last_message_at < ?
    `).all(threshold);
  }

  /**
   * Compress old messages to save space
   */
  compressOldMessages(olderThanDays = 7) {
    const db = this._initDb();
    if (!db) return { compressed: 0, total: 0, error: this._dbError };
    const zlib = require('zlib');
    const threshold = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000).toISOString();

    const messages = db.prepare(`
      SELECT id, content FROM messages 
      WHERE timestamp < ? AND compressed = 0
    `).all(threshold);

    let compressed = 0;
    const update = db.prepare('UPDATE messages SET content = ?, compressed = 1 WHERE id = ?');

    for (const msg of messages) {
      try {
        const compressedContent = zlib.gzipSync(msg.content).toString('base64');
        update.run(compressedContent, msg.id);
        compressed++;
      } catch (err) {
        // Skip if compression fails
      }
    }

    return { compressed, total: messages.length };
  }

  /**
   * Get conversation context for retrieval (summary + recent messages)
   */
  getConversationContext(conversationId, recentMessageCount = 5) {
    const conversation = this.getConversation(conversationId, { 
      includeMessages: true, 
      messageLimit: recentMessageCount 
    });

    if (!conversation) return null;

    // Parse JSON fields
    const parseJson = (str) => {
      if (!str) return null;
      try { return JSON.parse(str); } catch (e) { return null; }
    };

    return {
      id: conversation.id,
      contact: conversation.contact_name,
      summary: conversation.summary,
      ownerContext: conversation.owner_summary ? {
        summary: conversation.owner_summary,
        relevance: conversation.owner_relevance,
        goalsTouched: parseJson(conversation.owner_goals_touched),
        ownerActionItems: parseJson(conversation.owner_action_items),
        callerActionItems: parseJson(conversation.caller_action_items),
        jointActionItems: parseJson(conversation.joint_action_items),
        collaborationOpportunity: parseJson(conversation.collaboration_opportunity),
        followUp: conversation.owner_follow_up,
        notes: conversation.owner_notes
      } : null,
      recentMessages: conversation.messages,
      messageCount: conversation.message_count,
      startedAt: conversation.started_at,
      endedAt: conversation.ended_at,
      status: conversation.status
    };
  }

  /**
   * Save live collaboration state for a conversation
   */
  saveCollabState(conversationId, collabState) {
    const db = this._initDb();
    if (!db) return { success: false, error: this._dbError };
    if (!collabState || typeof collabState !== 'object') {
      return { success: false, error: 'invalid_state' };
    }

    const now = new Date().toISOString();
    db.prepare(`
      UPDATE conversations SET
        collab_phase = ?,
        collab_turn_count = ?,
        collab_overlap_score = ?,
        collab_active_threads = ?,
        collab_candidate_collaborations = ?,
        collab_open_questions = ?,
        collab_close_signal = ?,
        collab_confidence = ?,
        collab_updated_at = ?
      WHERE id = ?
    `).run(
      collabState.phase || 'handshake',
      collabState.turnCount || 0,
      collabState.overlapScore != null ? collabState.overlapScore : 0.15,
      collabState.activeThreads ? JSON.stringify(collabState.activeThreads) : null,
      collabState.candidateCollaborations ? JSON.stringify(collabState.candidateCollaborations) : null,
      collabState.openQuestions ? JSON.stringify(collabState.openQuestions) : null,
      collabState.closeSignal ? 1 : 0,
      collabState.confidence != null ? collabState.confidence : 0.25,
      now,
      conversationId
    );

    return { success: true };
  }

  /**
   * Load live collaboration state for a conversation
   */
  loadCollabState(conversationId) {
    const db = this._initDb();
    if (!db) return null;

    const row = db.prepare(
      'SELECT collab_phase, collab_turn_count, collab_overlap_score, collab_active_threads, collab_candidate_collaborations, collab_open_questions, collab_close_signal, collab_confidence, collab_updated_at FROM conversations WHERE id = ?'
    ).get(conversationId);

    if (!row || row.collab_phase == null) return null;

    const parseJson = (str) => {
      if (!str) return [];
      try { return JSON.parse(str); } catch { return []; }
    };

    return {
      phase: row.collab_phase,
      turnCount: row.collab_turn_count || 0,
      overlapScore: row.collab_overlap_score != null ? row.collab_overlap_score : 0.15,
      activeThreads: parseJson(row.collab_active_threads),
      candidateCollaborations: parseJson(row.collab_candidate_collaborations),
      openQuestions: parseJson(row.collab_open_questions),
      closeSignal: Boolean(row.collab_close_signal),
      confidence: row.collab_confidence != null ? row.collab_confidence : 0.25,
      updatedAt: row.collab_updated_at
    };
  }

  /**
   * Close database connection
   */
  close() {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}

module.exports = { ConversationStore };
