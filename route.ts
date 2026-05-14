import { z } from "zod";
import { createMcpHandler } from "mcp-handler";

type SearchResult = {
  index: number;
  title: string;
  url: string;
  description: string;
};

type FetchedPage = {
  url: string;
  title: string;
  text: string;
  chars: number;
};

function needEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing env variable: ${name}`);
  }
  return value;
}

function cleanHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function getTitle(html: string, fallback: string): string {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match?.[1]?.replace(/\s+/g, " ").trim() || fallback;
}

async function webSearch(query: string, count: number): Promise<SearchResult[]> {
  const apiKey = needEnv("BRAVE_SEARCH_API_KEY");

  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(Math.min(Math.max(count, 1), 10)));

  const res = await fetch(url, {
    headers: {
      Accept: "application/json",
      "X-Subscription-Token": apiKey
    }
  });

  if (!res.ok) {
    throw new Error(`Brave search failed: ${res.status} ${await res.text()}`);
  }

  const data = await res.json();

  return (data.web?.results ?? []).map((r: any, i: number) => ({
    index: i + 1,
    title: r.title ?? "",
    url: r.url ?? "",
    description: r.description ?? ""
  }));
}

async function fetchUrl(url: string, maxChars: number): Promise<FetchedPage> {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 goblin-web-reader",
      Accept: "text/html,application/xhtml+xml,application/xml,text/plain,*/*"
    }
  });

  if (!res.ok) {
    throw new Error(`Fetch failed: ${res.status} ${await res.text()}`);
  }

  const raw = await res.text();
  const title = getTitle(raw, url);
  const text = cleanHtml(raw).slice(0, maxChars);

  return {
    url,
    title,
    text,
    chars: text.length
  };
}

const handler = createMcpHandler(
  (server) => {
    server.tool(
      "web_search",
      "Search the web for current facts, docs, releases, model info, APIs, and anything likely outdated.",
      {
        query: z.string().min(1).describe("Search query"),
        count: z.number().int().min(1).max(10).default(5)
      },
      async ({ query, count }) => {
        const results = await webSearch(query, count);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  tool: "web_search",
                  query,
                  results
                },
                null,
                2
              )
            }
          ]
        };
      }
    );

    server.tool(
      "fetch_url",
      "Fetch readable text from a specific source URL supplied by the user.",
      {
        url: z.string().url().describe("URL to fetch"),
        maxChars: z.number().int().min(1000).max(120000).default(60000)
      },
      async ({ url, maxChars }) => {
        const page = await fetchUrl(url, maxChars);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  tool: "fetch_url",
                  page
                },
                null,
                2
              )
            }
          ]
        };
      }
    );

    server.tool(
      "search_and_fetch",
      "Search web and fetch top pages. Best for grounded answers from real source pages, not only snippets.",
      {
        query: z.string().min(1).describe("Search query"),
        count: z.number().int().min(1).max(8).default(5),
        fetchTop: z.number().int().min(1).max(5).default(3),
        maxCharsPerPage: z.number().int().min(1000).max(120000).default(40000)
      },
      async ({ query, count, fetchTop, maxCharsPerPage }) => {
        const results = await webSearch(query, count);

        const fetched = [];

        for (const result of results.slice(0, fetchTop)) {
          try {
            const page = await fetchUrl(result.url, maxCharsPerPage);
            fetched.push({
              search_result: result,
              page
            });
          } catch (error: any) {
            fetched.push({
              search_result: result,
              error: error?.message ?? String(error)
            });
          }
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  tool: "search_and_fetch",
                  query,
                  results,
                  fetched
                },
                null,
                2
              )
            }
          ]
        };
      }
    );
  },
  {},
  {
    basePath: "/api"
  }
);

export { handler as GET, handler as POST, handler as DELETE };
