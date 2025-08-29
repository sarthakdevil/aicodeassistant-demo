import { HumanMessage, SystemMessage } from "@langchain/core/messages";
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

const THINKER_SYSTEM_MESSAGE = `You are the Investigative Thinker Agent. Your PRIMARY role is to actively investigate and understand what the user is talking about by using your tools.

YOUR INVESTIGATION PROCESS:
1. **IMMEDIATELY** use list_files to examine the project structure
2. **SEARCH FOR RELEVANT CODE** using search_in_files to find related functions, classes, or patterns the user mentions
3. **READ KEY FILES** that are relevant to the user's request (limit to 2-3 most important files)
4. **UNDERSTAND THE CONTEXT** - what exists, what's missing, what the user is referring to
5. **ANALYZE THE USER'S REQUEST** in the context of what you discovered
6. **CREATE A DETAILED PLAN** based on your investigation findings

Available investigation tools: list_files, read_file, search_in_files

CRITICAL RULES:
- Use tools efficiently - don't repeat the same investigation twice
- Focus on the most relevant files and patterns
- Stop investigating once you have enough context to create a plan
- Do NOT use tools unnecessarily or in loops

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
POTENTIAL ISSUES: [based on what you found during investigation]`;

const DOER_SYSTEM_MESSAGE = `You are the Action-Oriented Doer Agent. Your role is to execute based on the Investigative Thinker's detailed findings.

The Thinker Agent has already:
- Investigated the project structure using tools
- Read relevant files to understand context
- Created a specific plan based on real findings

Your responsibilities:
1. **EXECUTE THE PLAN** step by step using the exact file paths and details provided
2. **USE THE RECOMMENDED TOOLS** as suggested by the Thinker
3. **HANDLE ERRORS** and provide specific feedback about what went wrong
4. **REPORT PROGRESS** after each major step
5. **STOP when the task is complete** - don't continue unnecessarily

Available tools: ${vscodeTools.map(tool => tool.name).join(", ")}

CRITICAL RULES:
- Follow the plan efficiently without unnecessary tool calls
- If a step fails, try to fix it or move to the next step
- Do NOT repeat the same action multiple times
- STOP when you've completed the requested task

The Thinker will provide you with:
- INVESTIGATION FINDINGS: Real data about the project
- CONTEXT UNDERSTANDING: What the user is actually referring to
- DETAILED PLAN: Specific actions with file paths
- RECOMMENDED TOOLS: Exact tools to use for each step

Execute efficiently and report back with concrete results.`;

const thinkerAgent = createReactAgent({
  llm: llm,
  tools: [listFilesTool, readFileTool, searchInFilesTool],
  checkpointSaver: memory,
  messageModifier: THINKER_SYSTEM_MESSAGE
});


const doerAgent = createReactAgent({
  llm: llm,
  tools: vscodeTools,
  checkpointSaver: memory,
  messageModifier: DOER_SYSTEM_MESSAGE
});

async function runTwoAgentSystem() {
  console.log("🤖🔍 Two-Agent System: Investigative Thinker + Action Doer");
  console.log("�️ Thinker: Investigates project structure, searches code, analyzes context");
  console.log("🔧 Doer: Executes plans using tools -", vscodeTools.map(tool => tool.name).join(", "));
  console.log("🔍 Thinker Tools: list_files, read_file, search_in_files");
  console.log("💾 Memory enabled for both agents!");
  console.log("Type 'exit' to quit\n");


  const thinkerThreadId = `thinker-${Date.now()}`;
  const doerThreadId = `doer-${Date.now()}`;
  
  console.log(`🧵 Thinker thread: ${thinkerThreadId}`);
  console.log(`🧵 Doer thread: ${doerThreadId}\n`);

  while (true) {
    try {

      const userInput = await getUserInput("\n💬 You: ");
      
      if (userInput.toLowerCase().trim() === 'exit') {
        console.log("👋 Goodbye!");
        break;
      }

      console.log("\n" + "=".repeat(60));
      console.log("�️ INVESTIGATIVE THINKER: Examining project & analyzing request...");
      console.log("=".repeat(60));

      const thinkerResult = await thinkerAgent.invoke(
        {
          messages: [
            new HumanMessage(`User request: ${userInput}`)
          ]
        },
        {
          configurable: {
            thread_id: thinkerThreadId
          },
          recursionLimit: 10 
        }
      );


      const thinkerResponse = thinkerResult.messages[thinkerResult.messages.length - 1];
      console.log("\n🔍 Investigation Results & Plan:");
      console.log(thinkerResponse.content);

      console.log("\n" + "=".repeat(60));
      console.log("⚡ ACTION DOER: Executing the investigated plan...");
      console.log("=".repeat(60));


      const doerResult = await doerAgent.invoke(
        {
          messages: [
            new HumanMessage(`Original user request: ${userInput}\n\nThinker's plan:\n${thinkerResponse.content}\n\nPlease execute this plan step by step.`)
          ]
        },
        {
          configurable: {
            thread_id: doerThreadId
          },
          recursionLimit: 15
        }
      );


      console.log("\n🤖 Doer's Execution Result:");
      if (doerResult.messages && doerResult.messages.length > 0) {
        const lastMessage = doerResult.messages[doerResult.messages.length - 1];
        console.log(lastMessage.content);
      }

      const toolMessages = doerResult.messages.filter(msg => msg._getType() === 'tool');
      if (toolMessages.length > 0) {
        console.log("\n🔧 Tools executed by Doer:");
        toolMessages.forEach((msg, index) => {
          console.log(`${index + 1}. ${msg.content}`);
        });
      }

      console.log("\n" + "=".repeat(60));
      console.log("✅ Two-Agent Loop Completed");
      console.log("=".repeat(60));

    } catch (error: any) {
      if (error.message.includes("Recursion limit")) {
        console.log("❌ Recursion Limit Error: The agent hit the recursion limit.");
        console.log("🔧 This usually means the agent was calling tools in a loop.");
        console.log("💡 Try rephrasing your request or breaking it into smaller parts.");
      } else {
        console.log(`❌ Error: ${error.message}`);
      }
    }
  }
  
  rl.close();
}

// Start the iterative two-agent system loop
runTwoAgentSystem().catch(console.error);
