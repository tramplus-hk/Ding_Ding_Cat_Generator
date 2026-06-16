import cors from "cors";
import express from "express";
import { config } from "./config.js";
import { stickersRouter } from "./routes/stickers.js";

const app = express();

app.use(cors({ origin: config.webOrigin }));
app.use(express.json({ limit: "2mb" }));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.use("/api/stickers", stickersRouter);

app.listen(config.port, () => {
  console.log(`Sticker server listening on http://localhost:${config.port}`);
});
