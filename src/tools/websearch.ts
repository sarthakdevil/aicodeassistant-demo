import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import * as https from "https";
import * as dotenv from "dotenv";

// Load environment variables
dotenv.config();

// Serper API Tool
export const serperSearchTool = new DynamicStructuredTool({
  name: "serper_search",
  description: "Search the web using Serper API (Google Search). Returns structured search results including organic results, answer boxes, and knowledge graph data.",
  schema: z.object({
    query: z.string().describe("The search query to perform"),
    num: z.number().optional().default(10).describe("Number of results to return (max 100)"),
    type: z.enum(["search", "images", "videos", "places", "shopping"]).optional().default("search").describe("Type of search to perform")
  }),
  func: async ({ query, num = 10, type = "search" }: { query: string; num?: number; type?: string }) => {
    try {
      const apiKey = process.env.SERPER_API_KEY;
      if (!apiKey) {
        return "Error: SERPER_API_KEY environment variable not found. Please set your Serper API key.";
      }

      // Prepare the request data
      const requestData = JSON.stringify({
        q: query,
        num: Math.min(num, 100), // Serper max is 100
        type: type
      });

      const results = await makeSerperRequest(apiKey, requestData, type);

      // Format the results for better readability
      return formatSerperResults(results, query);

    } catch (error: any) {
      return `Error performing Serper search: ${error.message}`;
    }
  }
});

// Helper function to make HTTPS request to Serper API
function makeSerperRequest(apiKey: string, requestData: string, type: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'google.serper.dev',
      path: type === 'search' ? '/search' : `/${type}`,
      method: 'POST',
      headers: {
        'X-API-KEY': apiKey,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(requestData)
      }
    };

    const req = https.request(options, (res) => {
      let data = '';

      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        try {
          const parsedData = JSON.parse(data);
          resolve(parsedData);
        } catch (error) {
          reject(new Error(`Failed to parse API response: ${error}`));
        }
      });
    });

    req.on('error', (error) => {
      reject(error);
    });

    req.write(requestData);
    req.end();
  });
}

// Helper function to format Serper results
function formatSerperResults(results: any, originalQuery: string): string {
  let formatted = `🔍 **Serper Search Results for: "${originalQuery}"**\n\n`;

  try {
    // Handle different result types
    if (results.answerBox) {
      formatted += `📦 **Answer Box:**\n${results.answerBox.title || 'N/A'}\n`;
      if (results.answerBox.answer) {
        formatted += `${results.answerBox.answer}\n`;
      }
      if (results.answerBox.snippet) {
        formatted += `${results.answerBox.snippet}\n`;
      }
      formatted += '\n';
    }

    if (results.knowledgeGraph) {
      formatted += `🧠 **Knowledge Graph:**\n`;
      if (results.knowledgeGraph.title) {
        formatted += `Title: ${results.knowledgeGraph.title}\n`;
      }
      if (results.knowledgeGraph.description) {
        formatted += `Description: ${results.knowledgeGraph.description}\n`;
      }
      if (results.knowledgeGraph.attributes) {
        Object.entries(results.knowledgeGraph.attributes).forEach(([key, value]: [string, any]) => {
          formatted += `${key}: ${value}\n`;
        });
      }
      formatted += '\n';
    }

    if (results.organic && results.organic.length > 0) {
      formatted += `🔗 **Organic Results:**\n`;
      results.organic.slice(0, 10).forEach((result: any, index: number) => {
        formatted += `${index + 1}. **${result.title}**\n`;
        formatted += `   URL: ${result.link}\n`;
        if (result.snippet) {
          formatted += `   ${result.snippet}\n`;
        }
        formatted += '\n';
      });
    }

    if (results.images && results.images.length > 0) {
      formatted += `🖼️ **Images:**\n`;
      results.images.slice(0, 5).forEach((image: any, index: number) => {
        formatted += `${index + 1}. ${image.title}\n   ${image.imageUrl}\n   Source: ${image.source}\n\n`;
      });
    }

    if (results.videos && results.videos.length > 0) {
      formatted += `🎥 **Videos:**\n`;
      results.videos.slice(0, 5).forEach((video: any, index: number) => {
        formatted += `${index + 1}. ${video.title}\n   ${video.link}\n   Channel: ${video.channel}\n\n`;
      });
    }

    if (results.places && results.places.length > 0) {
      formatted += `📍 **Places:**\n`;
      results.places.slice(0, 5).forEach((place: any, index: number) => {
        formatted += `${index + 1}. ${place.title}\n   Rating: ${place.rating || 'N/A'}\n   Address: ${place.address}\n\n`;
      });
    }

    if (results.shopping && results.shopping.length > 0) {
      formatted += `🛒 **Shopping:**\n`;
      results.shopping.slice(0, 5).forEach((item: any, index: number) => {
        formatted += `${index + 1}. ${item.title}\n   Price: ${item.price}\n   Source: ${item.source}\n\n`;
      });
    }

    // Add search metadata
    if (results.searchParameters) {
      formatted += `📊 **Search Info:**\n`;
      formatted += `Query: ${results.searchParameters.q}\n`;
      formatted += `Country: ${results.searchParameters.country || 'N/A'}\n`;
      formatted += `Language: ${results.searchParameters.language || 'N/A'}\n`;
    }

  } catch (error) {
    formatted += `⚠️ Error formatting results: ${error}\n`;
    formatted += `Raw results: ${JSON.stringify(results, null, 2)}\n`;
  }

  return formatted;
}

// Export all tools
export const webSearchTools = [
  serperSearchTool
];
