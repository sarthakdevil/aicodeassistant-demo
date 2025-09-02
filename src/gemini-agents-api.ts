import { GoogleGenerativeAI, SchemaType } from "@google/generative-ai";
import { vscodeTools } from "./tools/vscode-tools.js";
import { serperSearchTool } from "./tools/websearch.js";
import * as dotenv from "dotenv";

// Load environment variables
dotenv.config();

// Get API key from environment as fallback
const fallbackApiKey = process.env.GOOGLE_API_KEY;

// Dynamic Gemini API initialization
function createGeminiInstance(apiKey: string) {
  return new GoogleGenerativeAI(apiKey);
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
  private currentPlan: string = "";
  private maxEntries = 10;

  addEntry(iteration: number, agent: string, action: string, result: string) {
    this.entries.push({
      iteration,
      agent,
      action,
      result: result.substring(0, 200),
      timestamp: new Date()
    });

    if (iteration > 0 && iteration % 3 === 0) {
      this.createSummary(iteration);
    }

    if (this.entries.length > this.maxEntries) {
      this.entries = this.entries.slice(-this.maxEntries);
    }
  }

  private createSummary(currentIteration: number) {
    const lastThreeIterations = this.entries.filter(entry =>
      entry.iteration >= currentIteration - 2 && entry.iteration <= currentIteration
    );

    if (lastThreeIterations.length === 0) return;

    const summary = lastThreeIterations
      .map(entry => `${entry.agent}: ${entry.action} → ${entry.result.substring(0, 80)}`)
      .join(" | ");

    this.summaries.push(`[Iter ${currentIteration - 2}-${currentIteration}]: ${summary}`);

    if (this.summaries.length > 3) {
      this.summaries = this.summaries.slice(-3);
    }
  }

  getRecentContext(currentIteration: number): string {
    const recentEntries = this.entries
      .filter(entry => entry.iteration < currentIteration)
      .slice(-4);

    if (this.entries.length === 0 && this.summaries.length === 0 && !this.hasPlan()) return "";

    let context = "";

    // Always include the current plan if it exists
    if (this.hasPlan()) {
      context += "\n🎯 CURRENT PLAN (FOLLOW THIS EXACTLY):\n" + this.currentPlan + "\n";
    }

    if (this.summaries.length > 0) {
      context += "\nSUMMARIES:\n" + this.summaries.slice(-2).join("\n") + "\n";
    }

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
    this.currentPlan = "";
  }

  getEntryCount(): number {
    return this.entries.length;
  }

  getRecentEntries(count: number = 2): MemoryEntry[] {
    return this.entries.slice(-count);
  }

  setPlan(plan: string) {
    this.currentPlan = plan;
  }

  getPlan(): string {
    return this.currentPlan;
  }

  clearPlan() {
    this.currentPlan = "";
  }

  hasPlan(): boolean {
    return this.currentPlan.trim().length > 0;
  }
}

interface EventStream {
  write: (data: any) => void;
  end: () => void;
}

interface PlanEditRequest {
  action: 'approve' | 'edit';
  editedPlan?: string;
}

// Global memory instance (persistent like terminal version)
const globalAgentMemory = new AgentMemory();

// Tool execution function
async function executeTool(toolName: string, args: any, eventStream: EventStream) {
  eventStream.write({
    type: 'tool_execution',
    tool: toolName,
    args: args
  });

  const tool = vscodeTools.find(t => t.name === toolName);
  if (!tool) {
    const error = `Tool ${toolName} not found!`;
    eventStream.write({
      type: 'tool_result',
      success: false,
      result: error
    });
    return error;
  }

  try {
    const result = await tool.func(args);
    eventStream.write({
      type: 'tool_result',
      success: true,
      result: result.substring(0, 200) + (result.length > 200 ? '...' : '')
    });
    return result;
  } catch (error: any) {
    const errorMsg = `Error executing ${toolName}: ${error.message}`;
    eventStream.write({
      type: 'tool_result',
      success: false,
      result: errorMsg
    });
    return errorMsg;
  }
}

class GeminiAgent {
  private name: string;
  private systemPrompt: string;
  private availableFunctions: any[];
  private model: any;

  constructor(name: string, systemPrompt: string, tools: any[], apiKey: string) {
    this.name = name;
    this.systemPrompt = systemPrompt;
    this.availableFunctions = convertToGeminiFunctions(tools);

    const genAI = createGeminiInstance(apiKey);
    this.model = genAI.getGenerativeModel({
      model: "gemini-2.0-flash",
      tools: [{ functionDeclarations: this.availableFunctions }]
    });
  }

  async run(prompt: string, iteration: number, agentMemory: AgentMemory, eventStream: EventStream): Promise<{ response: string; toolsUsed: string[] }> {
    eventStream.write({
      type: 'agent_start',
      agent: this.name.toLowerCase(),
      iteration: iteration
    });

    const memoryContext = agentMemory.getRecentContext(iteration);
    const fullPrompt = `${this.systemPrompt}${memoryContext}\n\nTASK: ${prompt}`;

    try {
      const chat = this.model.startChat();
      const result = await chat.sendMessage(fullPrompt);

      let finalResponse = "";
      const toolsUsed: string[] = [];

      const functionCalls = result.response.functionCalls();
      if (functionCalls && functionCalls.length > 0) {
        for (const functionCall of functionCalls) {
          const { name, args } = functionCall;
          toolsUsed.push(name);

          const functionResult = await executeTool(name, args, eventStream);
          agentMemory.addEntry(iteration, this.name, `${name}(${JSON.stringify(args)})`, functionResult);

          try {
            const followUpResult = await chat.sendMessage([{
              functionResponse: {
                name,
                response: { result: functionResult }
              }
            }]);

            finalResponse += followUpResult.response.text() || "";
          } catch (error: any) {
            finalResponse = `Executed ${name} successfully. Result: ${functionResult.substring(0, 100)}...`;
          }
        }
      } else {
        finalResponse = result.response.text() || "";
        if (!finalResponse || finalResponse.trim().length === 0) {
          finalResponse = "Task acknowledged.";
        }

        agentMemory.addEntry(iteration, this.name, "thinking", finalResponse);
      }

      eventStream.write({
        type: 'agent_response',
        agent: this.name.toLowerCase(),
        response: finalResponse,
        toolsUsed: toolsUsed
      });

      eventStream.write({
        type: 'memory_update',
        count: agentMemory.getEntryCount()
      });

      return { response: finalResponse, toolsUsed };

    } catch (error: any) {
      if (error.message.includes('429') || error.message.includes('quota')) {
        await new Promise(resolve => setTimeout(resolve, 10000));
        return { response: `Quota limit reached, waiting before retry.`, toolsUsed: [] };
      }

      eventStream.write({
        type: 'error',
        message: `Error in ${this.name}: ${error.message}`
      });

      return { response: `Error: ${error.message}`, toolsUsed: [] };
    }
  }
}
// Function to create agents with API key
function createAgents(apiKey: string) {
  const plannerAgent = new GeminiAgent(
    "Planner",
    `You are a Strategic Planner. Create numbered, step-by-step plans that agents can follow exactly.

🎯 PLAN FORMAT REQUIREMENTS:
• Use numbered steps (1., 2., 3., etc.) - NOT bullet points
• Make each step specific and actionable
• One clear task per numbered step
• Include which tool to use for each step
• Make steps easy to reference and track

📋 PLAN STRUCTURE EXAMPLE:
1. Check current project structure (tool: list_files)
2. Read package.json to understand setup (tool: read_file)
3. Create components folder if missing (tool: create_file_or_folder)
4. Create Button component file (tool: create_file_or_folder)
5. Add Button component code (tool: edit_file)
6. Edit Button component styles (tool: edit_file)
7. Test the component works (tool: execute_in_terminal)

🎯 REQUIREMENTS:
• Start each step with a number (1., 2., 3.)
• Include the tool name in parentheses
• Be specific about what to create/modify
• Follow logical sequence
• Make each step trackable

ALWAYS use this numbered format so agents can reference "step 3" or "step 5" specifically.`,
    [
      vscodeTools.find(t => t.name === 'list_files')!,
      vscodeTools.find(t => t.name === 'read_file')!,
      vscodeTools.find(t => t.name === 'search_in_files')!,
      serperSearchTool
    ],
    apiKey
  );

  const analystAgent = new GeminiAgent(
    "Analyst",
    `You are an Analyst. Your ONLY job is to look at THE PLAN and figure out what step should be done next.

🎯 CRITICAL RULES:
• follow the plan
• Don't get distracted by existing project files unless the plan says to examine them
• Your job is to track progress through the plan step-by-step
• Each iteration should advance one step in the plan
• Reference specific plan steps by their bullet points

🔍 YOUR PROCESS:
1. Read the plan carefully
2. Check what's been completed so far
3. Find the next step that needs work
4. Use tools ONLY if needed to check something specific
5. Tell Executor exactly which plan step to execute

⚠️ DON'T:
• Change plan entirely

✅ DO:
• Reference specific plan bullets/steps
• Stay focused on the plan progression
• Be specific about what step comes next
• If all plan steps are completed, say "All plan steps completed"

🏁 PLAN COMPLETION:
• After each iteration, check if all numbered steps in the plan are done
• If the plan is fully executed, state clearly "All plan steps completed"
• This helps the system know the entire plan is finished`,
    [
      vscodeTools.find(t => t.name === 'list_files')!,
      vscodeTools.find(t => t.name === 'read_file')!,
      vscodeTools.find(t => t.name === 'search_in_files')!,
      serperSearchTool
    ],
    apiKey
  );

  const executorAgent = new GeminiAgent(
    "Executor",
    `You are an Executor. Your ONLY job is to DO exactly what the Analyst tells you to do.

🎯 CRITICAL RULES:
• Follow the Analyst's guidance exactly - no interpretation
• Execute the specific plan step they reference
• Use only the tools they recommend for that step
• Don't explore or analyze - just execute
• Complete one specific task per iteration

⚡ YOUR PROCESS:
1. Read the Analyst's guidance
2. Identify the specific plan step they want you to do
3. Use the exact tools they suggest
4. Execute that one step completely
5. Report what you accomplished

⚠️ DON'T:
• Explore project files unless specifically told to
• Add extra features not in the plan
• Do multiple steps at once
• Make assumptions about what to do

✅ DO:
• Execute exactly what Analyst says
• Use the specific tools they mention
• Focus on the one plan step they identified
• Report completion clearly
• If you've completed the final step of the plan, say "Plan executed successfully"

🏁 PLAN COMPLETION:
• When you finish the last step in the numbered plan, explicitly state "Plan executed successfully"
• Check if all numbered steps have been completed
• This helps the system know the entire plan is done`,
    vscodeTools, // Remove serperSearchTool since it's already in vscodeTools
    apiKey
  );

  return { plannerAgent, analystAgent, executorAgent };
}

export async function runGeminiAgentsAPI(userInput: string, eventStream: EventStream, apiKey?: string, planEdit?: PlanEditRequest) {
  // Use provided API key or fallback to environment variable
  const effectiveApiKey = apiKey || fallbackApiKey;
  
  if (!effectiveApiKey) {
    eventStream.write({
      type: 'error',
      message: 'No Gemini API key provided. Please configure your API key.'
    });
    eventStream.end();
    return;
  }

  // Create agents with the API key
  const { plannerAgent, analystAgent, executorAgent } = createAgents(effectiveApiKey);
  
  // Use global persistent memory instead of creating new one
  const agentMemory = globalAgentMemory;
  let iterationCount = 0;
  const maxIterations = 8;

  try {
    // Handle special commands like terminal version
    if (userInput.toLowerCase().trim() === 'status') {
      const analystToolUsage = agentMemory.getRecentEntries(20).filter(e => e.agent === 'Analyst').length;
      const executorToolUsage = agentMemory.getRecentEntries(20).filter(e => e.agent === 'Executor').length;

      eventStream.write({
        type: 'status_info',
        analystToolUsage,
        executorToolUsage,
        memoryEntries: agentMemory.getEntryCount()
      });

      eventStream.end();
      return;
    }

    if (userInput.toLowerCase().trim() === 'memory') {
      const memoryContext = agentMemory.getRecentContext(999);
      eventStream.write({
        type: 'memory_dump',
        content: memoryContext || "No memory entries"
      });

      eventStream.end();
      return;
    }

    if (userInput.toLowerCase().trim() === 'clear') {
      agentMemory.clear();
      eventStream.write({
        type: 'memory_cleared',
        message: "Memory cleared successfully"
      });

      eventStream.end();
      return;
    }

    if (userInput.toLowerCase().trim() === 'clear plan') {
      agentMemory.clearPlan();
      eventStream.write({
        type: 'plan_cleared',
        message: "Plan cleared successfully. Next task will create a new plan."
      });

      eventStream.end();
      return;
    }

    // Don't clear memory - keep building on existing memory
    let finalPlan: string;
    
    // Check if we already have a plan in memory
    const existingPlan = agentMemory.getPlan();
    
    // Check if this is a plan edit request
    if (planEdit) {
      if (planEdit.action === 'approve') {
        // User approved the plan, proceed with execution
        eventStream.write({
          type: 'plan_approved',
          message: 'Plan approved by user, proceeding with execution...'
        });
        // Get the plan from memory (it should already be stored there)
        finalPlan = agentMemory.getPlan();
        if (!finalPlan) {
          eventStream.write({
            type: 'error',
            message: 'No plan found in memory to execute'
          });
          eventStream.end();
          return;
        }
      } else if (planEdit.action === 'edit' && planEdit.editedPlan) {
        // User edited the plan
        finalPlan = planEdit.editedPlan;
        
        // Store the edited plan in memory
        agentMemory.setPlan(finalPlan);
        
        eventStream.write({
          type: 'plan_edited',
          plan: finalPlan,
          message: 'Plan updated by user, proceeding with execution...'
        });
      } else {
        eventStream.write({
          type: 'error',
          message: 'Invalid plan edit request'
        });
        eventStream.end();
        return;
      }
    } else if (existingPlan) {
      // We already have a plan in memory, use it and proceed with execution
      finalPlan = existingPlan;
      eventStream.write({
        type: 'plan_exists',
        plan: finalPlan,
        message: 'Using existing plan from memory, proceeding with execution...'
      });
    } else {
      // Phase 1: PLANNING (Create initial plan only if none exists)
      eventStream.write({
        type: 'planning_start',
        message: 'Creating structured plan for the task...'
      });

      const planningPrompt = `Create a simple, clear plan for this user request: "${userInput}"

IMPORTANT: Use simple bullet points (•) only. NO markdown, NO numbers, NO complex formatting.

PLANNING STEPS:
• First understand the current workspace state (use list_files, read_file as needed)
• Research best practices if this involves coding/development (use serper_search)
• Break down the task into clear, sequential steps
• Specify which tools will be needed

FORMAT YOUR PLAN LIKE THIS EXAMPLE:
• Check current project structure
• Create main component file
• Add necessary imports
• Implement component logic
• Test the component
• Update any configuration files

KEEP IT SIMPLE:
• Use bullet points only
• One action per bullet point
• Clear, specific actions
• Tools mentioned when relevant
• No sub-bullets or complex structure

The Analyst and Executor will follow this plan step by step.`;

      const planResult = await plannerAgent.run(planningPrompt, 0, agentMemory, eventStream);
      finalPlan = planResult.response;

      // Store the plan in memory so it's always available
      agentMemory.setPlan(finalPlan);

      eventStream.write({
        type: 'plan_created',
        plan: finalPlan,
        requiresApproval: true
      });

      // Stop here and wait for user approval/editing
      eventStream.end();
      return;
    }

    // Phase 2: EXECUTION (Follow the plan)
    let shouldContinue = true;

    while (shouldContinue && iterationCount < maxIterations) {
      iterationCount++;

      eventStream.write({
        type: 'iteration_start',
        iteration: iterationCount
      });

      // Analyst phase - now works with the plan
      const analystPrompt = buildAnalystPromptWithPlan(iterationCount, userInput, agentMemory);
      const analystResult = await analystAgent.run(analystPrompt, iterationCount, agentMemory, eventStream);

      await new Promise(resolve => setTimeout(resolve, 2000));

      // Executor phase - follows plan and analyst guidance
      const executorPrompt = buildExecutorPromptWithPlan(iterationCount, userInput, analystResult.response, agentMemory);
      const executorResult = await executorAgent.run(executorPrompt, iterationCount, agentMemory, eventStream);

      // Check if we should continue and handle plan completion
      const combinedText = (analystResult.response + ' ' + executorResult.response).toLowerCase();
      const planBeforeCheck = agentMemory.getPlan();
      
      shouldContinue = shouldContinueIterating(analystResult.response, executorResult.response, agentMemory);
      
      const planAfterCheck = agentMemory.getPlan();
      
      // Check if plan was cleared (indicating completion)
      if (planBeforeCheck && !planAfterCheck) {
        eventStream.write({
          type: 'plan_completed',
          iteration: iterationCount,
          message: 'Plan executed successfully and has been cleared from memory!'
        });
      }

      if (!shouldContinue) {
        eventStream.write({
          type: 'task_complete',
          iteration: iterationCount
        });
      }

      await new Promise(resolve => setTimeout(resolve, 3000));
    }

    if (iterationCount >= maxIterations) {
      eventStream.write({
        type: 'task_complete',
        iteration: iterationCount,
        reason: 'max_iterations'
      });
    }

  } catch (error: any) {
    eventStream.write({
      type: 'error',
      message: error.message
    });
  } finally {
    eventStream.end();
  }
}

function buildAnalystPrompt(iteration: number, originalRequest: string, agentMemory: AgentMemory): string {
  let prompt = `ITERATION: ${iteration}
REQUEST: ${originalRequest}`;

  const recentEntries = agentMemory.getRecentEntries(2);
  if (recentEntries.length > 0) {
    const lastExecutor = recentEntries.find(e => e.agent === 'Executor');
    if (lastExecutor) {
      prompt += `\n\nLAST EXECUTOR: ${lastExecutor.result}`;
    }
  }

  prompt += `\n\nInvestigate and provide guidance for next step.`;
  return prompt;
}

function buildAnalystPromptWithPlan(iteration: number, originalRequest: string, agentMemory: AgentMemory): string {
  const plan = agentMemory.getPlan();
  
  let prompt = `ITERATION: ${iteration}
USER QUERY: "${originalRequest}"

🎯 THE PLAN (REFERENCE BUT DON'T BLINDLY FOLLOW):
${plan}

📋 WHAT YOU'VE DONE SO FAR:
${agentMemory.getRecentContext(iteration)}

🔍 YOUR ANALYST TASK:
1. Remember the user's original request: "${originalRequest}"
2. Look at the PLAN above - but don't blindly follow it
3. ASSESS: Does anything need attention before continuing the plan?
   - Are there errors that need fixing?
   - Is the current state different than expected?
   - Are there dependencies missing?
   - Does the plan need adjustment based on what you discover?
4. Check what has already been completed from the plan
5. If issues are found, address them first before continuing the plan
6. Otherwise, identify the NEXT SPECIFIC STEP from the plan that needs work
7. Use your tools to investigate what's needed for that step
8. Tell the Executor exactly what to do (fix issues OR continue with plan step)

CRITICAL: 
- DON'T blindly follow the plan - be smart and adaptive
- Check for problems/errors that need attention first
- Reference the specific bullet point from the plan when appropriate
- Be specific about what needs to be done next
- Always keep the user's goal in mind: "${originalRequest}"

Example responses: 
- "I found an error in the build process that needs fixing before we continue with step 3 of the plan..."
- "Everything looks good, we should proceed with step 3: 'Create new component file' from the plan..."`;

  return prompt;
}

function buildExecutorPrompt(iteration: number, originalRequest: string, analystGuidance: string): string {
  return `ITERATION: ${iteration}
REQUEST: ${originalRequest}

ANALYST GUIDANCE:
${analystGuidance.substring(0, 300)}

Execute the guidance using your tools.`;
}

function buildExecutorPromptWithPlan(iteration: number, originalRequest: string, analystGuidance: string, agentMemory: AgentMemory): string {
  const plan = agentMemory.getPlan();
  
  return `ITERATION: ${iteration}
USER QUERY: "${originalRequest}"

🎯 THE PLAN (THIS IS WHAT WE'RE FOLLOWING):
${plan}

🧠 ANALYST SAYS TO DO THIS:
${analystGuidance}

⚡ YOUR EXECUTOR TASK:
1. Remember the user asked for: "${originalRequest}"
2. Read what the Analyst told you to do
3. Look at the specific step from the plan they referenced
4. Execute that exact step using your tools to help fulfill the user's request
5. Don't do anything else - just that one step
6. Report completion and how it advances toward the user's goal

CRITICAL RULES:
- Follow the Analyst's guidance exactly
- Reference the plan step they mentioned
- Use the tools they recommended
- Don't explore random files unless the plan calls for it
- Complete the specific task, nothing more
- Keep the user's original request in mind: "${originalRequest}"

EXECUTE EXACTLY WHAT THE ANALYST TOLD YOU TO DO TO HELP ACHIEVE: "${originalRequest}"

Be sure to use at least one tool to complete the task.`;
}

function shouldContinueIterating(analystMsg: string, executorMsg: string, agentMemory: AgentMemory): boolean {
  const combinedText = (analystMsg + ' ' + executorMsg).toLowerCase();

  // Check for plan completion patterns first
  const planCompletionPatterns = [
    'plan completed successfully',
    'plan executed successfully', 
    'all plan steps completed',
    'plan is now complete',
    'successfully completed the plan',
    'plan has been executed',
    'finished executing the plan',
    'all steps in the plan are done',
    'plan execution complete'
  ];

  // Check if plan is completed and clear it
  for (const pattern of planCompletionPatterns) {
    if (combinedText.includes(pattern)) {
      console.log(`🎯 Detected PLAN COMPLETION pattern: "${pattern}" - clearing plan and stopping iteration`);
      agentMemory.clearPlan();
      return false; // Stop iteration
    }
  }

  // Check for explicit stop patterns (task completion)
  const stopPatterns = [
    'No further action is needed',
    'No further action needed',
    'quota limit'
  ];

  // Check if any stop pattern is found and log which one
  for (const pattern of stopPatterns) {
    if (combinedText.includes(pattern)) {
      console.log(`🎯 Detected STOP pattern: "${pattern}" - stopping iteration`);
      return false; // Stop iteration
    }
  }

  // Check for explicit continue patterns
  const continuePatterns = [
    'next step',
    'continue',
    'create',
    'add',
    'need to',
    'should',
    'will',
    'let me',
    'i need to',
    'i should'
  ];

  // Check if any continue pattern is found and log which one
  for (const pattern of continuePatterns) {
    if (combinedText.includes(pattern)) {
      console.log(`⚡ Detected CONTINUE pattern: "${pattern}" - continuing iteration`);
      return true; // Continue iteration
    }
  }

  // Default: continue if no clear signal (fail-safe for complex tasks)
  console.log('🤔 No completion/continue patterns detected, continuing to be safe');
  return true;
}
