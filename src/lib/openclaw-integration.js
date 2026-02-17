/**
 * OpenClaw Integration for A2A
 * 
 * Provides owner-context summarization using OpenClaw's agent system.
 */

const fs = require('fs');
const path = require('path');
const { createLogger } = require('./logger');
const { buildUnifiedSummaryPrompt } = require('./summary-prompt');

const logger = createLogger({ component: 'a2a.openclaw-integration' });

/**
 * Load owner context from OpenClaw workspace files
 * @param {string} workspaceDir - Path to workspace
 * @param {Object} options
 * @param {string[]} options.tierGoals - Goals from config tier (takes priority over USER.md)
 */
function loadOwnerContext(workspaceDir = process.cwd(), options = {}) {
  const context = {
    goals: [],
    interests: [],
    context: '',
    user: null,
    memory: null
  };

  // Tier goals from config take priority
  if (options.tierGoals && options.tierGoals.length > 0) {
    context.goals = [...options.tierGoals];
  }

  // Load USER.md
  const userPath = path.join(workspaceDir, 'USER.md');
  if (fs.existsSync(userPath)) {
    context.user = fs.readFileSync(userPath, 'utf8');
    // Extract goals from USER.md (fallback if no tier goals from config)
    if (context.goals.length === 0) {
      const goalsMatch = context.user.match(/##\s*(?:Goals|Current|Seeking)[^\n]*\n([\s\S]*?)(?=\n##|$)/i);
      if (goalsMatch) {
        context.goals = goalsMatch[1]
          .split('\n')
          .filter(l => l.trim().startsWith('-') || l.trim().startsWith('*'))
          .map(l => l.replace(/^[\s\-\*]+/, '').trim())
          .filter(Boolean);
      }
    }
    // Extract interests
    const interestsMatch = context.user.match(/##\s*(?:Interests|Projects)[^\n]*\n([\s\S]*?)(?=\n##|$)/i);
    if (interestsMatch) {
      context.interests = interestsMatch[1]
        .split('\n')
        .filter(l => l.trim().startsWith('-') || l.trim().startsWith('*'))
        .map(l => l.replace(/^[\s\-\*]+/, '').trim())
        .filter(Boolean);
    }
  }

  // Load recent memory
  const memoryDir = path.join(workspaceDir, 'memory');
  if (fs.existsSync(memoryDir)) {
    const files = fs.readdirSync(memoryDir)
      .filter(f => f.endsWith('.md'))
      .sort()
      .reverse()
      .slice(0, 3); // Last 3 memory files
    
    context.memory = files.map(f => {
      const content = fs.readFileSync(path.join(memoryDir, f), 'utf8');
      return `## ${f}\n${content}`;
    }).join('\n\n');
  }

  // Load MEMORY.md if exists
  const mainMemoryPath = path.join(workspaceDir, 'MEMORY.md');
  if (fs.existsSync(mainMemoryPath)) {
    const mainMemory = fs.readFileSync(mainMemoryPath, 'utf8');
    context.memory = mainMemory + '\n\n' + (context.memory || '');
  }

  return context;
}

/**
 * Build summary prompt for agent
 * 
 * Philosophy: A2A is collaborative AND adversarial. Each agent tries
 * to maximize value for their owner while finding genuine mutual wins.
 * Track the exchange balance AND surface partnership opportunities.
 */
function buildSummaryPrompt(messages, ownerContext, callerInfo = {}) {
  // Build transcript in unified format
  const transcript = messages.map(m => ({
    direction: m.direction,
    content: m.content
  }));

  // Map ownerContext (which has .user, .goals, .interests from USER.md) into unified format
  const unifiedOwnerContext = {
    agentName: null,
    ownerName: null,
    goals: ownerContext?.goals || []
  };

  return buildUnifiedSummaryPrompt({
    transcript,
    callerInfo: {
      name: callerInfo.name || null,
      owner: callerInfo.owner || null,
      context: callerInfo.context || null
    },
    ownerContext: unifiedOwnerContext
  });
}

/**
 * Create an OpenClaw summarizer that uses exec to call the agent
 * This works by writing a prompt file and using openclaw's CLI
 */
function createExecSummarizer(workspaceDir = process.cwd()) {
  const { execSync } = require('child_process');
  
  return async function(messages, callerInfo = {}) {
    const ownerContext = loadOwnerContext(workspaceDir);
    const prompt = buildSummaryPrompt(messages, ownerContext, callerInfo);
    
    // Write prompt to temp file
    const tmpFile = `/tmp/a2a-summary-${Date.now()}.txt`;
    fs.writeFileSync(tmpFile, prompt);
    
    try {
      // Call openclaw CLI to get agent response
      // This assumes openclaw has a way to do single-shot prompts
      const result = execSync(
        `cat "${tmpFile}" | openclaw prompt --json 2>/dev/null || echo '{}'`,
        { encoding: 'utf8', timeout: 30000 }
      );
      
      // Parse JSON from response
      const jsonMatch = result.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]);
      }
      
      return {
        summary: result.slice(0, 500),
        ownerSummary: null,
        relevance: 'unknown',
        goalsTouched: [],
        actionItems: [],
        followUp: null,
        notes: null
      };
    } catch (err) {
      logger.error('Exec summarizer failed', {
        event: 'exec_summary_failed',
        trace_id: callerInfo?.trace_id || callerInfo?.traceId || null,
        error: err,
        error_code: 'OPENCLAW_EXEC_SUMMARIZER_FAILED',
        hint: 'Verify `openclaw prompt --json` is available and returns valid JSON.',
        data: {
          workspace_dir: workspaceDir
        }
      });
      return { summary: null };
    } finally {
      // Cleanup
      try { fs.unlinkSync(tmpFile); } catch (e) {}
    }
  };
}

/**
 * Create a summarizer that posts to a local HTTP endpoint
 * OpenClaw can expose an internal summarization endpoint
 */
function createHttpSummarizer(endpoint = 'http://localhost:3000/api/summarize') {
  const http = require('http');
  const https = require('https');
  
  return async function(messages, callerInfo = {}) {
    const ownerContext = loadOwnerContext();
    const prompt = buildSummaryPrompt(messages, ownerContext, callerInfo);
    
    return new Promise((resolve) => {
      const url = new URL(endpoint);
      const client = url.protocol === 'https:' ? https : http;
      
      const req = client.request({
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        timeout: 30000
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            resolve({ summary: data.slice(0, 500) });
          }
        });
      });
      
      req.on('error', (err) => {
        logger.error('HTTP summarizer failed', {
          event: 'http_summary_failed',
          trace_id: callerInfo?.trace_id || callerInfo?.traceId || null,
          error: err,
          error_code: 'OPENCLAW_HTTP_SUMMARIZER_FAILED',
          hint: 'Check summarizer endpoint reachability and response format.',
          data: {
            endpoint
          }
        });
        resolve({ summary: null });
      });
      
      req.write(JSON.stringify({ prompt, messages, callerInfo }));
      req.end();
    });
  };
}

/**
 * Create a summarizer using sessions_send to the main OpenClaw session
 * This is the preferred method when running inside OpenClaw
 */
function createSessionSummarizer(gatewayUrl, gatewayToken) {
  const http = require('http');
  const https = require('https');
  
  return async function(messages, callerInfo = {}) {
    const ownerContext = loadOwnerContext();
    const prompt = buildSummaryPrompt(messages, ownerContext, callerInfo);
    
    // Send to OpenClaw gateway's internal API
    return new Promise((resolve) => {
      const url = new URL(gatewayUrl || 'http://localhost:3000');
      const client = url.protocol === 'https:' ? https : http;
      
      const req = client.request({
        hostname: url.hostname,
        port: url.port,
        path: '/api/internal/summarize',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${gatewayToken || process.env.OPENCLAW_TOKEN}`
        },
        timeout: 60000
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const result = JSON.parse(data);
            resolve(result.summary || result);
          } catch (e) {
            resolve({ summary: data.slice(0, 500) });
          }
        });
      });
      
      req.on('error', (err) => {
        logger.error('Session summarizer failed', {
          event: 'session_summary_failed',
          trace_id: callerInfo?.trace_id || callerInfo?.traceId || null,
          error: err,
          error_code: 'OPENCLAW_SESSION_SUMMARIZER_FAILED',
          hint: 'Verify OpenClaw gateway URL/token and /api/internal/summarize availability.',
          data: {
            gateway_url: gatewayUrl || 'http://localhost:3000'
          }
        });
        resolve({ summary: null });
      });
      
      req.write(JSON.stringify({ prompt }));
      req.end();
    });
  };
}

/**
 * Auto-detect best summarizer based on environment
 */
function createAutoSummarizer(options = {}) {
  const workspaceDir = options.workspaceDir || process.env.OPENCLAW_WORKSPACE || process.cwd();
  
  // If gateway URL provided, use session summarizer
  if (options.gatewayUrl || process.env.OPENCLAW_GATEWAY_URL) {
    logger.info('Using session summarizer', {
      event: 'summary_mode_selected',
      data: {
        mode: 'session'
      }
    });
    return createSessionSummarizer(
      options.gatewayUrl || process.env.OPENCLAW_GATEWAY_URL,
      options.gatewayToken || process.env.OPENCLAW_TOKEN
    );
  }
  
  // If HTTP endpoint provided, use that
  if (options.summaryEndpoint) {
    logger.info('Using HTTP summarizer', {
      event: 'summary_mode_selected',
      data: {
        mode: 'http',
        endpoint: options.summaryEndpoint
      }
    });
    return createHttpSummarizer(options.summaryEndpoint);
  }
  
  // Fall back to exec summarizer
  logger.info('Using exec summarizer', {
    event: 'summary_mode_selected',
    data: {
      mode: 'exec',
      workspace_dir: workspaceDir
    }
  });
  return createExecSummarizer(workspaceDir);
}

module.exports = {
  loadOwnerContext,
  buildSummaryPrompt,
  createExecSummarizer,
  createHttpSummarizer,
  createSessionSummarizer,
  createAutoSummarizer
};
