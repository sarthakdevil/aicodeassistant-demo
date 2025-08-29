import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { config } from "dotenv";

config();
process.env.GEMINI_API_KEY;
const llm = new ChatGoogleGenerativeAI({
  model: "gemini-2.0-flash",
  temperature: 0,
  maxRetries: 2,
});

export default llm;