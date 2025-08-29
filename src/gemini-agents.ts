import { GoogleGenerativeAI, SchemaType } from "@google/generative-ai";
import { vscodeTools } from "./tools/vscode-tools.js";
import * as readline from "readline";
import * as dotenv from "dotenv";

// Load environment variables
dotenv.config();

// Initialize Gemini
const apiKey = process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY;
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
      model: "gemini-1.5-pro",
      tools: [{ functionDeclarations: this.availableFunctions }]
    });
  }

  async run(prompt: string): Promise<{ response: string; toolsUsed: string[] }> {
    console.log(`\n🤖 ${this.name} processing...`);
    
    const fullPrompt = `${this.systemPrompt}\n\nTASK: ${prompt}`;
    
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
  console.log("🚀 SIMPLE GEMINI ITERATIVE SYSTEM (Quota-Friendly)");
  console.log("🧠 Analyst: Investigates project structure");
  console.log("⚡ Executor: Creates and edits files");
  console.log("⏱️ Rate-limited to avoid quota issues\n");

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
        continue;
      }

      if (context.count === 0) {
        context.originalRequest = userInput;
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
        const analystResult = await analystAgent.run(analystPrompt);
        
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
        const executorResult = await executorAgent.run(executorPrompt);
        
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
runSimpleGeminiSystem().catch(console.error);
