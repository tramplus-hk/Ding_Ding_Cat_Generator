import "dotenv/config";

export const config = {
  port: Number(process.env.SERVER_PORT ?? 4000),
  webOrigin: process.env.WEB_ORIGIN ?? "http://localhost:5173",
  nanoBananaApiKey: process.env.NANO_BANANA_API_KEY ?? "",
  nanoBananaApiUrl: process.env.NANO_BANANA_API_URL ?? "",
  notionToken: process.env.NOTION_TOKEN ?? "",
  notionDatabaseId: process.env.NOTION_DATABASE_ID ?? "",
};
