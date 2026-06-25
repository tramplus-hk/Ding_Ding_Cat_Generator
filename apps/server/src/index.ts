import { app } from "./app.js";
import { config } from "./config.js";

app.listen(config.port, () => {
  console.log(`Sticker server listening on http://localhost:${config.port}`);
  console.log(`Image generation: ${config.imageGenerationApiKey ? "configured" : "not configured, using placeholder"}`);
  console.log(`Notion sync: ${config.notionToken && config.notionDatabaseId ? "configured" : "not configured"}`);
});
