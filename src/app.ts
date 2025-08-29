import express from 'express';
import { WebSocketServer } from 'ws';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { HumanMessage } from "@langchain/core/messages";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { MemorySaver } from "@langchain/langgraph";
import llm from "./gemini/gemini.js";
import { vscodeTools, listFilesTool, readFileTool, searchInFilesTool } from "./tools/vscode-tools";
import * as fs from 'fs';

// ES module compatibility
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Create Express app
const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Create memory saver and two-agent system
const memory = new MemorySaver();

// Agent system messages
const THINKER_SYSTEM_MESSAGE = `You are the Investigative Thinker Agent in a web UI. Your PRIMARY role is to actively investigate and understand what the user is talking about.

YOUR INVESTIGATION PROCESS:
1. **IMMEDIATELY** use list_files to examine the project structure
2. **SEARCH FOR RELEVANT CODE** using search_in_files to find related functions, classes, or patterns the user mentions
3. **READ KEY FILES** that are relevant to the user's request
4. **UNDERSTAND THE CONTEXT** - what exists, what's missing, what the user is referring to
5. **ANALYZE THE USER'S REQUEST** in the context of what you discovered
6. **CREATE A DETAILED PLAN** based on your investigation findings

Available investigation tools: list_files, read_file, search_in_files

CRITICAL: You MUST actively use your tools to investigate before making any plan. Search for keywords the user mentions, explore the codebase, understand the current state!

Your response format:
INVESTIGATION FINDINGS:
[Detailed findings from using your tools - file structure, code patterns, existing implementations]

CONTEXT UNDERSTANDING:
[What exactly the user is referring to and what currently exists in the codebase]

DETAILED PLAN:
1. [Specific step with exact file paths and actions based on investigation]
2. [Next step with context from investigation]
3. [Continue with precise actions]

RECOMMENDED TOOLS: [specific tools for each step]
POTENTIAL ISSUES: [based on what you found during investigation]

STOP after creating the plan. Do not call tools repeatedly. Be efficient.`;

const DOER_SYSTEM_MESSAGE = `You are the Action-Oriented Doer Agent in a web UI. Your role is to execute based on the Investigative Thinker's detailed findings.

The Thinker Agent has already:
- Investigated the project structure using tools
- Read relevant files to understand context
- Created a specific plan based on real findings

Your responsibilities:
1. **EXECUTE THE PLAN** step by step using the exact file paths and details provided
2. **USE THE RECOMMENDED TOOLS** as suggested by the Thinker
3. **HANDLE ERRORS** and provide specific feedback about what went wrong
4. **REPORT PROGRESS** after each major step
5. **ASK FOR CLARIFICATION** only if the Thinker's investigation was incomplete

Available tools: ${vscodeTools.map(tool => tool.name).join(", ")}

The Thinker will provide you with:
- INVESTIGATION FINDINGS: Real data about the project
- CONTEXT UNDERSTANDING: What the user is actually referring to
- DETAILED PLAN: Specific actions with file paths
- RECOMMENDED TOOLS: Exact tools to use for each step

Execute efficiently and report back with concrete results. STOP when the task is complete.`;

// Investigative Thinker Agent
const thinkerAgent = createReactAgent({
  llm: llm,
  tools: [listFilesTool, readFileTool, searchInFilesTool], // Full investigation toolkit
  checkpointSaver: memory,
  messageModifier: THINKER_SYSTEM_MESSAGE
});

// Action Doer Agent
const doerAgent = createReactAgent({
  llm: llm,
  tools: vscodeTools,
  checkpointSaver: memory,
  messageModifier: DOER_SYSTEM_MESSAGE
});

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// Routes
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

app.get('/api/file-tree', (req, res) => {
  try {
    const tree = getDirectoryTree(process.cwd());
    res.json({ tree });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Function to get directory tree
function getDirectoryTree(dirPath: string, maxDepth: number = 3, currentDepth: number = 0): any[] {
  const ignorePatterns = [
    'node_modules',
    '.git',
    '.vscode',
    'dist',
    'build',
    '.env',
    '.env.local',
    '.DS_Store',
    'Thumbs.db',
    '*.log',
    '.next',
    'coverage'
  ];

  if (currentDepth > maxDepth) {
    return [];
  }

  try {
    const items = fs.readdirSync(dirPath, { withFileTypes: true });
    const tree: any[] = [];

    for (const item of items) {
      // Skip ignored patterns
      if (ignorePatterns.some(pattern => {
        if (pattern.includes('*')) {
          return item.name.match(pattern.replace('*', '.*'));
        }
        return item.name === pattern || item.name.startsWith(pattern);
      })) {
        continue;
      }

      const fullPath = path.join(dirPath, item.name);
      const treeItem: any = {
        name: item.name,
        path: fullPath,
        type: item.isDirectory() ? 'directory' : 'file'
      };

      if (item.isDirectory()) {
        treeItem.children = getDirectoryTree(fullPath, maxDepth, currentDepth + 1);
      }

      tree.push(treeItem);
    }

    return tree.sort((a, b) => {
      if (a.type !== b.type) {
        return a.type === 'directory' ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    });
  } catch (error) {
    console.error(`Error reading directory ${dirPath}:`, error);
    return [];
  }
}

// WebSocket handling
wss.on('connection', (ws) => {
  console.log('🔌 New WebSocket connection established');
  
  const threadId = `conversation-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  const thinkerThreadId = `thinker-${threadId}`;
  const doerThreadId = `doer-${threadId}`;
  
  ws.on('message', async (data) => {
    try {
      const message = JSON.parse(data.toString());
      
      if (message.type === 'chat') {
        console.log(`💬 Received message: ${message.message}`);
        
        // Send acknowledgment
        ws.send(JSON.stringify({
          type: 'response',
          content: '🕵️ Investigative Thinker: Examining project & analyzing request...'
        }));
        
        try {
          // Step 1: Thinker investigates and creates a plan
          const thinkerResult = await thinkerAgent.invoke(
            {
              messages: [new HumanMessage(`User request: ${message.message}`)]
            },
            {
              configurable: {
                thread_id: thinkerThreadId,
                recursionLimit: 15
              }
            }
          );
          
          // Get the thinker's investigation and plan
          const thinkerResponse = thinkerResult.messages[thinkerResult.messages.length - 1];
          
          // Send thinker's investigation results
          ws.send(JSON.stringify({
            type: 'investigation',
            content: `🔍 Investigation Results:\n${thinkerResponse.content}`
          }));
          
          // Send progress update
          ws.send(JSON.stringify({
            type: 'response',
            content: '⚡ Action Doer: Executing the investigated plan...'
          }));
          
          // Step 2: Doer executes the plan
          const doerResult = await doerAgent.invoke(
            {
              messages: [
                new HumanMessage(`Execute this plan from the Thinker Agent:\n\n${thinkerResponse.content}\n\nOriginal user request: ${message.message}`)
              ]
            },
            {
              configurable: {
                thread_id: doerThreadId,
                recursionLimit: 15
              }
            }
          );
          
          // Send final results
          const doerResponse = doerResult.messages[doerResult.messages.length - 1];
          ws.send(JSON.stringify({
            type: 'response',
            content: `✅ Task Completed:\n${doerResponse.content}`
          }));
          
          // Send tool execution results from both agents
          const allToolMessages = [
            ...thinkerResult.messages.filter((msg: any) => msg._getType() === 'tool'),
            ...doerResult.messages.filter((msg: any) => msg._getType() === 'tool')
          ];
          
          for (const toolMsg of allToolMessages) {
            ws.send(JSON.stringify({
              type: 'tool_execution',
              tool: toolMsg.name || 'unknown',
              result: toolMsg.content
            }));
          }
          
        } catch (error: any) {
          if (error.message && error.message.includes('recursion limit')) {
            ws.send(JSON.stringify({
              type: 'error',
              message: '🔄 Task too complex - trying simpler approach. Please break down your request into smaller steps.'
            }));
          } else {
            throw error; // Re-throw other errors
          }
        }
      }
    } catch (error: any) {
      console.error('❌ Error processing message:', error);
      ws.send(JSON.stringify({
        type: 'error',
        message: error.message
      }));
    }
  });
  
  ws.on('close', () => {
    console.log('🔌 WebSocket connection closed');
  });
  
  ws.on('error', (error) => {
    console.error('❌ WebSocket error:', error);
  });
});

// Start the server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 VS Code AI Assistant server running on http://localhost:${PORT}`);
  console.log(`📁 File tree API available at /api/file-tree`);
  console.log(`🤖 WebSocket ready for chat connections`);
  console.log(`📂 Serving static files from: ${path.join(__dirname, '../public')}`);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n🛑 Shutting down server gracefully...');
  server.close(() => {
    console.log('✅ Server closed');
    process.exit(0);
  });
});

export default app;