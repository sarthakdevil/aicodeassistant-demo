import { HumanMessage, SystemMessage, AIMessage } from "@langchain/core/messages";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { MemorySaver } from "@langchain/langgraph";
import llm from "./gemini/gemini.js";
import { vscodeTools, listFilesTool, readFileTool, searchInFilesTool } from "./tools/vscode-tools.js";
import * as readline from "readline";

// Create readline interface for user input
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function getUserInput(question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      resolve(answer);
    });
  });
}

const memory = new MemorySaver();

// Enhanced system messages for iterative collaboration
const ANALYST_SYSTEM_MESSAGE = `You are the Strategic Analyst Agent in an iterative collaborative system.

YOUR ROLE IN EACH ITERATION:
- **INVESTIGATE** using your tools (list_files, read_file, search_in_files)
- **ANALYZE** the current situation and progress
- **THINK STRATEGICALLY** about the next concrete steps
- **PROVIDE SPECIFIC GUIDANCE** to the Executor agent

CRITICAL RULES:
- ALWAYS use tools to investigate before giving guidance
- Be SPECIFIC about files, folders, and actions needed
- Don't just think - INVESTIGATE and DISCOVER
- Give the Executor clear, actionable instructions

ITERATION BEHAVIOR:
1. **First Iteration**: Use list_files and read_file to understand the project
2. **Subsequent Iterations**: 
   - Review what the Executor accomplished using tools
   - Search for specific patterns or files as needed
   - Provide refined, specific guidance based on actual investigation

Available tools: list_files, read_file, search_in_files

RESPONSE FORMAT:
ITERATION STATUS: [Current iteration number and overall progress]
INVESTIGATION: [What tools you used and what you discovered]
ANALYSIS: [What you've learned from your investigation]
STRATEGIC THINKING: [Your reasoning about next steps]
SPECIFIC GUIDANCE FOR EXECUTOR: [Exact file paths, commands, or actions needed]`;

const EXECUTOR_SYSTEM_MESSAGE = `You are the Executor Agent in an iterative collaborative system.

YOUR ROLE IN EACH ITERATION:
- **EXECUTE** the specific guidance from the Analyst using your tools
- **TAKE ACTION** - don't just plan, DO IT
- **USE TOOLS** to create files, edit code, run commands, etc.
- **REPORT BACK** detailed results of your actual actions

CRITICAL RULES:
- ALWAYS use tools to perform the requested actions
- Don't just describe what you would do - DO IT
- Create files, edit code, run terminal commands as instructed
- Report the actual results of your tool usage

ITERATION BEHAVIOR:
1. **Read** the guidance from Analyst carefully
2. **Execute** the recommended actions using appropriate tools
3. **Use tools** like create_file, edit_file, execute_in_terminal, etc.
4. **Report** exactly what tools you used and what happened

Available tools: ${vscodeTools.map(tool => tool.name).join(", ")}

RESPONSE FORMAT:
ACTIONS TAKEN: [List of specific tools you used and what you did]
EXECUTION RESULTS: [Exact results from each tool - file contents, terminal output, etc.]
FILES CREATED/MODIFIED: [List any files you created or changed]
STATUS: [Current state after your actions]
READY FOR NEXT ITERATION: [What the Analyst should focus on next]`;

// Create agents with shared memory
const analystAgent = createReactAgent({
  llm: llm,
  tools: [listFilesTool, readFileTool, searchInFilesTool],
  checkpointSaver: memory,
  messageModifier: ANALYST_SYSTEM_MESSAGE
});

const executorAgent = createReactAgent({
  llm: llm,
  tools: vscodeTools,
  checkpointSaver: memory,
  messageModifier: EXECUTOR_SYSTEM_MESSAGE
});

// Function to detect if agent should have used tools but didn't
function shouldHaveUsedTools(agentResponse: string, agentType: 'analyst' | 'executor'): boolean {
  const response = agentResponse.toLowerCase();
  
  if (agentType === 'executor') {
    // Executor should use tools for these actions
    const actionKeywords = [
      'create', 'write', 'add', 'modify', 'edit', 'update',
      'run', 'execute', 'install', 'build', 'start',
      'check', 'read', 'view', 'list', 'search'
    ];
    
    const hasActionKeywords = actionKeywords.some(keyword => response.includes(keyword));
    const hasToolMentions = response.includes('tool') || response.includes('file') || response.includes('command');
    
    return hasActionKeywords && hasToolMentions && !response.includes('tool call') && !response.includes('executed');
  }
  
  if (agentType === 'analyst') {
    // Analyst should use tools for investigation
    const investigationKeywords = [
      'check', 'examine', 'look at', 'read', 'view', 'list', 'search', 'find'
    ];
    
    return investigationKeywords.some(keyword => response.includes(keyword)) && 
           !response.includes('tool call') && !response.includes('executed');
  }
  
  return false;
}

// Function to force tool usage with explicit instructions
async function forceToolUsage(agent: any, threadId: string, guidance: string, agentType: 'analyst' | 'executor'): Promise<any> {
  const toolInstructions = agentType === 'executor' 
    ? `URGENT: You must use tools to execute this guidance. Do not just describe - actually use create_file_or_folder, edit_file, read_file, or execute_in_terminal tools.

GUIDANCE TO EXECUTE: ${guidance}

Step by step:
1. Use read_file tool to check current state
2. Use appropriate tools to make the changes
3. Verify with tools that changes worked

YOU MUST ACTUALLY CALL TOOLS - NO DESCRIPTIONS ALLOWED!`
    : `URGENT: You must use investigation tools. Do not just think - actually use list_files, read_file, or search_in_files tools.

GUIDANCE TO INVESTIGATE: ${guidance}

Step by step:
1. Use list_files to see project structure
2. Use read_file to examine relevant files
3. Use search_in_files if needed

YOU MUST ACTUALLY CALL TOOLS - NO THINKING WITHOUT TOOLS!`;

  return await agent.invoke(
    {
      messages: [new HumanMessage(toolInstructions)]
    },
    {
      configurable: { thread_id: threadId },
      recursionLimit: 15
    }
  );
}

// Conversation history for context sharing
interface IterationContext {
  iterationCount: number;
  originalRequest: string;
  conversationHistory: Array<{
    agent: 'analyst' | 'executor';
    message: string;
    timestamp: Date;
  }>;
  taskStatus: 'in-progress' | 'completed' | 'needs-clarification';
}

async function runIterativeAgentSystem() {
  console.log("🤖🔄 Iterative Two-Agent Collaboration System");
  console.log("🧠 Analyst: Strategic thinking, analysis, guidance");
  console.log("⚡ Executor: Action-oriented, execution, reporting");
  console.log("🔄 Process: Think → Act → Think → Act → ... until completion");
  console.log("💾 Shared memory across iterations!");
  console.log("Type 'exit' to quit, 'status' for current progress\n");

  const analystThreadId = `analyst-${Date.now()}`;
  const executorThreadId = `executor-${Date.now()}`;
  
  console.log(`🧵 Analyst thread: ${analystThreadId}`);
  console.log(`🧵 Executor thread: ${executorThreadId}\n`);

  let context: IterationContext = {
    iterationCount: 0,
    originalRequest: '',
    conversationHistory: [],
    taskStatus: 'in-progress'
  };

  while (true) {
    try {
      const userInput = await getUserInput("\n💬 You: ");
      
      if (userInput.toLowerCase().trim() === 'exit') {
        console.log("👋 Goodbye!");
        break;
      }

      if (userInput.toLowerCase().trim() === 'status') {
        console.log(`\n📊 Current Status:`);
        console.log(`   Iterations: ${context.iterationCount}`);
        console.log(`   Task Status: ${context.taskStatus}`);
        console.log(`   History Length: ${context.conversationHistory.length} exchanges`);
        continue;
      }

      // Initialize or update context
      if (context.iterationCount === 0) {
        context.originalRequest = userInput;
      }

      // Start iterative process
      let shouldContinue = true;
      let maxIterations = 10; // Prevent infinite loops

      while (shouldContinue && context.iterationCount < maxIterations) {
        context.iterationCount++;
        
        console.log(`\n${"=".repeat(80)}`);
        console.log(`🔄 ITERATION ${context.iterationCount}`);
        console.log(`${"=".repeat(80)}`);

        // ANALYST PHASE
        console.log(`\n🧠 ANALYST PHASE: Strategic thinking and guidance...`);
        console.log("-".repeat(60));

        const analystContext = buildAnalystContext(context, userInput);
        
        const analystResult = await analystAgent.invoke(
          {
            messages: [new HumanMessage(analystContext)]
          },
          {
            configurable: { thread_id: analystThreadId },
            recursionLimit: 15
          }
        );

        const analystResponse = analystResult.messages[analystResult.messages.length - 1];
        console.log("🧠 Analyst Output:");
        console.log(analystResponse.content);
        
        // Check if analyst actually used tools
        const analystToolUsage = analystResult.messages.filter(msg => 
          msg.additional_kwargs?.tool_calls && msg.additional_kwargs.tool_calls.length > 0
        );
        if (analystToolUsage.length > 0) {
          console.log(`📊 Analyst used ${analystToolUsage.length} tool call(s) this iteration`);
        } else {
          console.log("⚠️  Analyst didn't use any tools this iteration");
          
          // Force tool usage if analyst should have used tools
          if (shouldHaveUsedTools(analystResponse.content as string, 'analyst')) {
            console.log("🔧 Forcing analyst to use tools...");
            const forcedResult = await forceToolUsage(analystAgent, analystThreadId, analystContext, 'analyst');
            const forcedResponse = forcedResult.messages[forcedResult.messages.length - 1];
            console.log("🧠 Analyst Output (with forced tools):");
            console.log(forcedResponse.content);
            
            // Update the response to use the forced one
            analystResponse.content = forcedResponse.content;
          }
        }

        // Record analyst's response
        context.conversationHistory.push({
          agent: 'analyst',
          message: analystResponse.content as string,
          timestamp: new Date()
        });

        // Check if analyst wants to ask user something
        if (shouldAskUser(analystResponse.content as string)) {
          console.log("\n❓ Analyst wants clarification from you.");
          shouldContinue = false;
          continue;
        }

        // EXECUTOR PHASE
        console.log(`\n⚡ EXECUTOR PHASE: Taking action based on guidance...`);
        console.log("-".repeat(60));

        const executorContext = buildExecutorContext(context);
        
        const executorResult = await executorAgent.invoke(
          {
            messages: [new HumanMessage(executorContext)]
          },
          {
            configurable: { thread_id: executorThreadId },
            recursionLimit: 20
          }
        );

        const executorResponse = executorResult.messages[executorResult.messages.length - 1];
        console.log("⚡ Executor Output:");
        console.log(executorResponse.content);
        
        // Check if executor actually used tools
        const executorToolUsage = executorResult.messages.filter(msg => 
          msg.additional_kwargs?.tool_calls && msg.additional_kwargs.tool_calls.length > 0
        );
        if (executorToolUsage.length > 0) {
          console.log(`🔧 Executor used ${executorToolUsage.length} tool call(s) this iteration`);
        } else {
          console.log("⚠️  Executor didn't use any tools this iteration - just thinking!");
          
          // Force tool usage if executor should have used tools
          if (shouldHaveUsedTools(executorResponse.content as string, 'executor')) {
            console.log("🔧 Forcing executor to use tools...");
            const forcedResult = await forceToolUsage(executorAgent, executorThreadId, executorContext, 'executor');
            const forcedResponse = forcedResult.messages[forcedResult.messages.length - 1];
            console.log("⚡ Executor Output (with forced tools):");
            console.log(forcedResponse.content);
            
            // Update the response to use the forced one
            executorResponse.content = forcedResponse.content;
          }
        }

        // Record executor's response
        context.conversationHistory.push({
          agent: 'executor',
          message: executorResponse.content as string,
          timestamp: new Date()
        });

        // Determine if we should continue
        shouldContinue = shouldContinueIterating(
          analystResponse.content as string, 
          executorResponse.content as string
        );

        if (shouldContinue) {
          console.log("\n🔄 Continuing to next iteration...");
          await new Promise(resolve => setTimeout(resolve, 1000)); // Brief pause
        } else {
          console.log("\n✅ Task appears to be completed or needs user input.");
          context.taskStatus = 'completed';
        }
      }

      if (context.iterationCount >= maxIterations) {
        console.log("\n⚠️  Reached maximum iterations. Please provide more specific guidance or break the task into smaller parts.");
      }

      console.log(`\n${"=".repeat(80)}`);
      console.log(`🏁 ITERATION CYCLE COMPLETED (${context.iterationCount} iterations)`);
      console.log(`${"=".repeat(80)}`);

    } catch (error: any) {
      if (error.message.includes("Recursion limit")) {
        console.log("❌ Recursion Limit Error: An agent hit the recursion limit.");
        console.log("🔧 This usually means an agent was calling tools in a loop.");
        console.log("💡 The system will continue with the next iteration.");
      } else {
        console.log(`❌ Error in iteration ${context.iterationCount}: ${error.message}`);
      }
    }
  }
  
  rl.close();
}

function buildAnalystContext(context: IterationContext, currentInput: string): string {
  let contextMsg = `ITERATION: ${context.iterationCount}
ORIGINAL REQUEST: ${context.originalRequest}`;

  if (context.iterationCount === 1) {
    contextMsg += `\nCURRENT INPUT: ${currentInput}`;
  }

  if (context.conversationHistory.length > 0) {
    contextMsg += `\n\nPREVIOUS CONVERSATION:`;
    // Include last few exchanges for context
    const recentHistory = context.conversationHistory.slice(-4);
    recentHistory.forEach((entry, index) => {
      contextMsg += `\n${entry.agent.toUpperCase()}: ${entry.message}`;
    });
  }

  contextMsg += `\n\nPlease provide strategic analysis and specific guidance for the Executor.`;
  return contextMsg;
}

function buildExecutorContext(context: IterationContext): string {
  const lastAnalystMessage = context.conversationHistory
    .filter(entry => entry.agent === 'analyst')
    .slice(-1)[0];

  let contextMsg = `ITERATION: ${context.iterationCount}
ORIGINAL REQUEST: ${context.originalRequest}

LATEST ANALYST GUIDANCE:
${lastAnalystMessage?.message || 'No guidance available'}`;

  if (context.conversationHistory.length > 2) {
    contextMsg += `\n\nRECENT PROGRESS:`;
    const recentProgress = context.conversationHistory.slice(-3, -1);
    recentProgress.forEach((entry) => {
      if (entry.agent === 'executor') {
        contextMsg += `\nPrevious execution: ${entry.message.substring(0, 200)}...`;
      }
    });
  }

  contextMsg += `\n\nPlease execute the analyst's guidance and provide detailed feedback.`;
  return contextMsg;
}

function shouldAskUser(analystMessage: string): boolean {
  const askPatterns = [
    'QUESTIONS FOR USER:',
    'need clarification',
    'please specify',
    'which approach',
    'more details',
    'unclear about'
  ];
  
  return askPatterns.some(pattern => 
    analystMessage.toLowerCase().includes(pattern.toLowerCase())
  );
}

function shouldContinueIterating(analystMsg: string, executorMsg: string): boolean {
  const combinedText = (analystMsg + ' ' + executorMsg).toLowerCase();
  
  // ONLY stop if explicitly completed or needs user input
  const definiteStopPatterns = [
    'task is completely finished',
    'everything is done',
    'no more work needed',
    'waiting for user input',
    'need clarification from user',
    'ask the user',
    'user needs to decide'
  ];
  
  // Check for definite stop conditions
  if (definiteStopPatterns.some(pattern => combinedText.includes(pattern))) {
    return false;
  }
  
  // Continue by default - let the agents work!
  // The system should keep iterating unless there's a clear reason to stop
  return true;
}

// Start the iterative system
console.log("🚀 Starting Iterative Two-Agent System...\n");
runIterativeAgentSystem().catch(console.error);