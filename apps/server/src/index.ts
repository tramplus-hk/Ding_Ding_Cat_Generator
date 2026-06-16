import cors from "cors";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ZodError } from "zod";
import { config } from "./config.js";
import { stickersRouter } from "./routes/stickers.js";

const app = express();
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const allowedOrigins = new Set([config.webOrigin, "http://127.0.0.1:5173", "http://localhost:5173"]);

app.use(
  cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.has(origin)) {
        callback(null, true);
        return;
      }

      callback(new Error(`Origin not allowed by CORS: ${origin}`));
    },
  }),
);
app.use(express.json({ limit: "2mb" }));
app.use("/generated", express.static(path.join(projectRoot, "data/generated")));
app.use("/runtime/generated", express.static(path.join(projectRoot, ".runtime/generated")));

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
  console.log(`Nano Banana generation: ${config.nanoBananaApiKey ? "configured" : "not configured, using placeholder"}`);
});
