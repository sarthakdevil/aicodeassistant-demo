import { GoogleGenerativeAI, SchemaType } from "@google/generative-ai";
import { vscodeTools } from "./tools/vscode-tools.js";
import * as readline from "readline";
import * as dotenv from "dotenv";

// Load environment variables
dotenv.config();

// Initialize Gemini
const apiKey = process.env.GOOGLE_API_KEY;
if (!apiKey) {
  console.error("❌ ERROR: No Google API key found!");
  console.error("Please set GOOGLE_API_KEY or GEMINI_API_KEY in your environment or .env file");
  process.exit(1);
}

const genAI = new GoogleGenerativeAI(apiKey);

// Create readline interface
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

// Convert vscode tools to Gemini function calling format
function convertToGeminiFunctions(tools: any[]) {
  return tools.map(tool => ({
    name: tool.name,
    description: tool.description,
    parameters: {
      type: SchemaType.OBJECT,
      properties: Object.entries(tool.schema.shape).reduce((props: any, [key, value]: [string, any]) => {
        props[key] = {
          type: SchemaType.STRING,
          description: value.description || `${key} parameter`
        };
        return props;
      }, {}),
      required: Object.keys(tool.schema.shape)
    }
  }));
}

// Memory management for agents
interface MemoryEntry {
  iteration: number;
  agent: string;
  action: string;
  result: string;
  timestamp: Date;
}

class AgentMemory {
  private entries: MemoryEntry[] = [];
  private summaries: string[] = [];
  private maxEntries = 10; // Keep last 10 entries to avoid quota issues

  addEntry(iteration: number, agent: string, action: string, result: string) {
    this.entries.push({
      iteration,
      agent,
      action,
      result: result.substring(0, 200), // Truncate to save tokens
      timestamp: new Date()
    });

    // Summarize every 3 iterations to save memory
    if (iteration > 0 && iteration % 3 === 0) {
      this.createSummary(iteration);
    }

    // Keep only recent entries
    if (this.entries.length > this.maxEntries) {
      this.entries = this.entries.slice(-this.maxEntries);
    }
  }

  private createSummary(currentIteration: number) {
    const lastThreeIterations = this.entries.filter(entry => 
      entry.iteration >= currentIteration - 2 && entry.iteration <= currentIteration
    );

    if (lastThreeIterations.length === 0) return;

    // Create a concise summary of the last 3 iterations
    const summary = lastThreeIterations
      .map(entry => `${entry.agent}: ${entry.action} → ${entry.result.substring(0, 80)}`)
      .join(" | ");

    this.summaries.push(`[Iter ${currentIteration-2}-${currentIteration}]: ${summary}`);

    // Keep only last 3 summaries
    if (this.summaries.length > 3) {
      this.summaries = this.summaries.slice(-3);
    }
  }

  getRecentContext(currentIteration: number): string {
    const recentEntries = this.entries
      .filter(entry => entry.iteration < currentIteration)
      .slice(-4); // Last 4 entries for current context

    if (this.entries.length === 0 && this.summaries.length === 0) return "";

    let context = "";
    
    // Add summaries first
    if (this.summaries.length > 0) {
      context += "\nSUMMARIES:\n" + this.summaries.slice(-2).join("\n") + "\n";
    }
    
    // Add recent entries
    if (recentEntries.length > 0) {
      context += "\nRECENT:\n" + recentEntries.map(entry => 
        `${entry.agent}: ${entry.action} → ${entry.result.substring(0, 100)}...`
      ).join("\n");
    }

    return context;
  }

  clear() {
    this.entries = [];
    this.summaries = [];
  }

  getEntryCount(): number {
    return this.entries.length;
  }
}

// Global memory instance
const agentMemory = new AgentMemory();

// Tool execution function
async function executeTool(toolName: string, args: any) {
  console.log(`\n🔧 Executing tool: ${toolName}`);
  console.log(`📥 Args: ${JSON.stringify(args, null, 2)}`);
  
  const tool = vscodeTools.find(t => t.name === toolName);
  if (!tool) {
    const error = `Tool ${toolName} not found!`;
    console.log(`❌ ${error}`);
    return error;
  }

  try {
    const result = await tool.func(args);
    console.log(`✅ Result: ${result.substring(0, 200)}${result.length > 200 ? '...' : ''}`);
    return result;
  } catch (error: any) {
    const errorMsg = `Error executing ${toolName}: ${error.message}`;
    console.log(`❌ ${errorMsg}`);
    return errorMsg;
  }
}

class SimpleGeminiAgent {
  private name: string;
  private systemPrompt: string;
  private availableFunctions: any[];
  private model: any;

  constructor(name: string, systemPrompt: string, tools: any[]) {
    this.name = name;
    this.systemPrompt = systemPrompt;
    this.availableFunctions = convertToGeminiFunctions(tools);
    
    // Create model with function calling - using stable Gemini 1.5 Pro
    this.model = genAI.getGenerativeModel({
      model: "gemini-2.0-flash",
      tools: [{ functionDeclarations: this.availableFunctions }]
    });
  }

  async run(prompt: string, iteration: number = 0): Promise<{ response: string; toolsUsed: string[] }> {
    console.log(`\n🤖 ${this.name} processing with memory context...`);
    
    // Add memory context to the prompt
    const memoryContext = agentMemory.getRecentContext(iteration);
    const fullPrompt = `${this.systemPrompt}${memoryContext}\n\nTASK: ${prompt}`;
    
    try {
      // Start the chat session
      const chat = this.model.startChat();
      const result = await chat.sendMessage(fullPrompt);
      
      let finalResponse = "";
      const toolsUsed: string[] = [];

      // Handle function calls
      const functionCalls = result.response.functionCalls();
      if (functionCalls && functionCalls.length > 0) {
        for (const functionCall of functionCalls) {
          const { name, args } = functionCall;
          toolsUsed.push(name);
          
          // Execute the function
          const functionResult = await executeTool(name, args);
          
          // Add to memory
          agentMemory.addEntry(iteration, this.name, `${name}(${JSON.stringify(args)})`, functionResult);
          
          // Send function result back to continue the conversation
          try {
            const followUpResult = await chat.sendMessage([{
              functionResponse: { 
                name, 
                response: { result: functionResult } 
              }
            }]);
            
            finalResponse += followUpResult.response.text() || "";
          } catch (error: any) {
            // If function response fails, just use the basic response
            finalResponse = `Executed ${name} successfully. Result: ${functionResult.substring(0, 100)}...`;
          }
        }
      } else {
        // No function calls - get basic response
        finalResponse = result.response.text() || "";
        if (!finalResponse || finalResponse.trim().length === 0) {
          console.log(`⚠️  ${this.name} didn't use any tools - that's okay for some responses`);
          finalResponse = "Task acknowledged.";
        }
        
        // Add thinking to memory too
        agentMemory.addEntry(iteration, this.name, "thinking", finalResponse);
      }

      console.log(`\n${this.name} Response: ${finalResponse.substring(0, 300)}${finalResponse.length > 300 ? '...' : ''}`);
      
      return { response: finalResponse, toolsUsed };
      
    } catch (error: any) {
      // Handle quota errors gracefully
      if (error.message.includes('429') || error.message.includes('quota')) {
        console.log(`⚠️ Quota limit reached for ${this.name}. Waiting 10 seconds...`);
        await new Promise(resolve => setTimeout(resolve, 10000));
        return { response: `Quota limit reached, waiting before retry.`, toolsUsed: [] };
      }
      
      console.log(`❌ Error in ${this.name}: ${error.message}`);
      return { response: `Error: ${error.message}`, toolsUsed: [] };
    }
  }
}

// Create simplified agents
const analystAgent = new SimpleGeminiAgent(
  "Analyst",
  `You are a Strategic Analyst. Use your tools to investigate and provide guidance. Keep responses brief.`,
  [
    vscodeTools.find(t => t.name === 'list_files')!,
    vscodeTools.find(t => t.name === 'read_file')!,
    vscodeTools.find(t => t.name === 'search_in_files')!
  ]
);

const executorAgent = new SimpleGeminiAgent(
  "Executor",
  `You are an Action Executor. Use your tools to make actual changes. Create files, edit files, run commands. Be brief.`,
  vscodeTools
);

interface IterationContext {
  count: number;
  originalRequest: string;
  history: Array<{
    agent: 'analyst' | 'executor';
    message: string;
    toolsUsed: string[];
    timestamp: Date;
  }>;
}

async function runSimpleGeminiSystem() {
  console.log("🚀 SIMPLE GEMINI ITERATIVE SYSTEM (With Memory)");
  console.log("🧠 Analyst: Investigates project structure");
  console.log("⚡ Executor: Creates and edits files");
  console.log("💾 Memory: Tracks actions across iterations");
  console.log("⏱️ Rate-limited to avoid quota issues");
  console.log("\nCommands: 'exit', 'status', 'memory'\n");

  let context: IterationContext = {
    count: 0,
    originalRequest: '',
    history: []
  };

  while (true) {
    try {
      const userInput = await getUserInput("\n💬 You: ");
      
      if (userInput.toLowerCase().trim() === 'exit') {
        console.log("👋 Goodbye!");
        break;
      }

      if (userInput.toLowerCase().trim() === 'status') {
        console.log(`\n📊 Status: ${context.count} iterations completed`);
        const analystToolUsage = context.history.filter(h => h.agent === 'analyst').reduce((sum, h) => sum + h.toolsUsed.length, 0);
        const executorToolUsage = context.history.filter(h => h.agent === 'executor').reduce((sum, h) => sum + h.toolsUsed.length, 0);
        console.log(`📈 Analyst tools used: ${analystToolUsage}`);
        console.log(`📈 Executor tools used: ${executorToolUsage}`);
        console.log(`🧠 Memory entries: ${agentMemory.getEntryCount()}`);
        continue;
      }

      if (userInput.toLowerCase().trim() === 'memory') {
        console.log("\n🧠 AGENT MEMORY:");
        console.log(agentMemory.getRecentContext(999) || "No memory entries");
        continue;
      }

      if (context.count === 0) {
        context.originalRequest = userInput;
        // Clear memory for new task
        agentMemory.clear();
        console.log("🧠 Memory cleared for new task");
        
        // INITIAL OBSERVATION PHASE
        console.log(`\n${"=".repeat(60)}`);
        console.log(`👁️  INITIAL WORKSPACE OBSERVATION`);
        console.log(`${"=".repeat(60)}`);
        
        const observationPrompt = `Before starting any task, observe and understand the current workspace structure and files. 
Use list_files to see the folder structure, then read key files to understand the project context.

TASK TO PREPARE FOR: ${userInput}

First, examine the workspace to understand what we're working with.`;
        
        const observationResult = await analystAgent.run(observationPrompt, 0);
        console.log(`\n👁️  WORKSPACE OBSERVATION:\n${observationResult.response}`);
        
        // Add observation to memory
        agentMemory.addEntry(0, "Analyst", "initial_observation", observationResult.response);
        
        console.log("\n📋 Workspace observed. Starting task execution...");
      }

      let shouldContinue = true;
      let maxIterations = 6; // Reduced to avoid quota issues

      while (shouldContinue && context.count < maxIterations) {
        context.count++;
        
        console.log(`\n${"=".repeat(60)}`);
        console.log(`🔄 ITERATION ${context.count}`);
        console.log(`${"=".repeat(60)}`);

        // ANALYST PHASE
        console.log(`\n🧠 ANALYST PHASE...`);
        console.log("-".repeat(40));
        
        const analystPrompt = buildAnalystPrompt(context, userInput);
        const analystResult = await analystAgent.run(analystPrompt, context.count);
        
        context.history.push({
          agent: 'analyst',
          message: analystResult.response,
          toolsUsed: analystResult.toolsUsed,
          timestamp: new Date()
        });

        // Rate limiting
        await new Promise(resolve => setTimeout(resolve, 2000));

        // EXECUTOR PHASE  
        console.log(`\n⚡ EXECUTOR PHASE...`);
        console.log("-".repeat(40));
        
        const executorPrompt = buildExecutorPrompt(context, analystResult.response);
        const executorResult = await executorAgent.run(executorPrompt, context.count);
        
        context.history.push({
          agent: 'executor',
          message: executorResult.response,
          toolsUsed: executorResult.toolsUsed,
          timestamp: new Date()
        });

        // Check if we should continue
        shouldContinue = shouldContinueIterating(analystResult.response, executorResult.response);
        
        if (shouldContinue) {
          console.log("\n🔄 Continuing to next iteration...");
          await new Promise(resolve => setTimeout(resolve, 3000)); // Longer wait to avoid quota
        } else {
          console.log("\n✅ Task completed!");
        }
      }

      if (context.count >= maxIterations) {
        console.log("\n⚠️  Reached maximum iterations to avoid quota issues.");
      }

    } catch (error: any) {
      console.log(`❌ Main loop error: ${error.message}`);
      await new Promise(resolve => setTimeout(resolve, 5000)); // Wait on error
    }
  }

  rl.close();
}

function buildAnalystPrompt(context: IterationContext, currentInput: string): string {
  let prompt = `ITERATION: ${context.count}
REQUEST: ${context.originalRequest}`;

  if (context.count === 1) {
    prompt += `\nCURRENT INPUT: ${currentInput}`;
  }

  if (context.history.length > 0) {
    const lastExecutor = context.history.filter(h => h.agent === 'executor').slice(-1)[0];
    if (lastExecutor) {
      prompt += `\n\nLAST EXECUTOR: ${lastExecutor.message.substring(0, 200)}`;
      if (lastExecutor.toolsUsed.length > 0) {
        prompt += `\nTools used: ${lastExecutor.toolsUsed.join(', ')}`;
      }
    }
  }

  prompt += `\n\nInvestigate and provide guidance for next step.`;
  
  return prompt;
}

function buildExecutorPrompt(context: IterationContext, analystGuidance: string): string {
  let prompt = `ITERATION: ${context.count}
REQUEST: ${context.originalRequest}

ANALYST GUIDANCE:
${analystGuidance.substring(0, 300)}`;

  prompt += `\n\nExecute the guidance using your tools.`;
  
  return prompt;
}

function shouldContinueIterating(analystMsg: string, executorMsg: string): boolean {
  const combinedText = (analystMsg + ' ' + executorMsg).toLowerCase();
  
  // Stop indicators
  const stopPatterns = [
    'task completed',
    'all files created',
    'calculator complete',
    'finished',
    'done',
    'quota limit'
  ];

  if (stopPatterns.some(pattern => combinedText.includes(pattern))) {
    return false;
  }

  // Continue indicators
  const continuePatterns = [
    'next step',
    'continue',
    'create',
    'add',
    'need to',
    'should',
    'html',
    'javascript',
    'calculator'
  ];

  return continuePatterns.some(pattern => combinedText.includes(pattern));
}

// Start the system
console.log("🚀 Starting Simple Gemini System...\n");

// Check if we have a CLI prompt from environment (for web bridge)
const cliPrompt = process.env.CLI_PROMPT;
if (cliPrompt) {
  console.log(`📨 Received prompt from web bridge: ${cliPrompt}`);
  runSingleIteration(cliPrompt).catch(console.error);
} else {
  runSimpleGeminiSystem().catch(console.error);
}

// Function to run a single iteration for web bridge
async function runSingleIteration(userPrompt: string) {
  console.log("🚀 SIMPLE GEMINI ITERATIVE SYSTEM (Web Bridge Mode)");
  console.log("🧠 Analyst: Investigates project structure");
  console.log("⚡ Executor: Creates and edits files");
  console.log("💾 Memory: Tracks actions across iterations");
  
  let context: IterationContext = {
    count: 0,
    originalRequest: userPrompt,
    history: []
  };

  // Clear memory for new task
  agentMemory.clear();
  console.log("🧠 Memory cleared for new task");
  
  // INITIAL OBSERVATION PHASE
  console.log(`\n${"=".repeat(60)}`);
  console.log(`👁️  INITIAL WORKSPACE OBSERVATION`);
  console.log(`${"=".repeat(60)}`);
  
  const observationPrompt = `Before starting any task, observe and understand the current workspace structure and files. 
Use list_files to see the folder structure, then read key files to understand the project context.

TASK TO PREPARE FOR: ${userPrompt}

First, examine the workspace to understand what we're working with.`;
  
  const observationResult = await analystAgent.run(observationPrompt, 0);
  console.log(`\n👁️  WORKSPACE OBSERVATION:\n${observationResult.response}`);
  
  // Add observation to memory
  agentMemory.addEntry(0, "Analyst", "initial_observation", observationResult.response);
  
  console.log("\n📋 Workspace observed. Starting task execution...");

  let shouldContinue = true;
  let maxIterations = 6;

  while (shouldContinue && context.count < maxIterations) {
    context.count++;
    
    console.log(`\n${"=".repeat(60)}`);
    console.log(`🔄 ITERATION ${context.count}`);
    console.log(`${"=".repeat(60)}`);

    // ANALYST PHASE
    console.log(`\n🧠 ANALYST PHASE...`);
    console.log("-".repeat(40));
    
    const analystPrompt = buildAnalystPrompt(context, userPrompt);
    const analystResult = await analystAgent.run(analystPrompt, context.count);
    
    context.history.push({
      agent: 'analyst',
      message: analystResult.response,
      toolsUsed: analystResult.toolsUsed,
      timestamp: new Date()
    });

    // Rate limiting
    await new Promise(resolve => setTimeout(resolve, 2000));

    // EXECUTOR PHASE  
    console.log(`\n⚡ EXECUTOR PHASE...`);
    console.log("-".repeat(40));
    
    const executorPrompt = buildExecutorPrompt(context, analystResult.response);
    const executorResult = await executorAgent.run(executorPrompt, context.count);
    
    context.history.push({
      agent: 'executor',
      message: executorResult.response,
      toolsUsed: executorResult.toolsUsed,
      timestamp: new Date()
    });

    // Check if we should continue
    shouldContinue = shouldContinueIterating(analystResult.response, executorResult.response);
    
    if (shouldContinue) {
      console.log("\n🔄 Continuing to next iteration...");
      await new Promise(resolve => setTimeout(resolve, 3000));
    } else {
      console.log("\n✅ Task completed!");
    }
  }

  if (context.count >= maxIterations) {
    console.log("\n⏹️ Reached maximum iterations");
  }

  console.log(`\n📊 Final Status: ${context.count} iterations completed`);
  console.log("🎯 Task execution finished");
}
