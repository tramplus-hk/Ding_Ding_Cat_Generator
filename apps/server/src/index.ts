import cors from "cors";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ZodError } from "zod";
import { config } from "./config.js";
import { stickersRouter } from "./routes/stickers.js";

const app = express();
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

app.use(cors({ origin: config.webOrigin }));
app.use(express.json({ limit: "2mb" }));
app.use("/generated", express.static(path.join(projectRoot, "data/generated")));

app.get("/", (_req, res) => {
  res.type("text").send(`Sticker API server is running. Open the web app at ${config.webOrigin}`);
});

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.use("/api/stickers", stickersRouter);

app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (error instanceof ZodError) {
    res.status(400).json({ error: "Invalid request", issues: error.issues });
    return;
  }

  const message = error instanceof Error ? error.message : "Unexpected server error";
  const statusCode =
    error instanceof Error && "statusCode" in error && typeof error.statusCode === "number" ? error.statusCode : 500;

  res.status(statusCode).json({ error: message });
});

app.listen(config.port, () => {
  console.log(`Sticker server listening on http://localhost:${config.port}`);
});
