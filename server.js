import express from "express";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import feedbackHandler from "./api/feedback.js";
import subscribeHandler from "./api/subscribe.js";

const app = express();
const port = Number(process.env.PORT || 3000);
const __dirname = dirname(fileURLToPath(import.meta.url));
const distDir = join(__dirname, "dist");
const staticDir = existsSync(distDir) ? distDir : __dirname;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(staticDir));

// Handle malformed JSON payloads without turning into server errors.
app.use((error, req, res, next) => {
  if (error instanceof SyntaxError && "body" in error) {
    return res.status(400).json({
      message: "Invalid JSON payload."
    });
  }
  return next(error);
});

app.post("/api/subscribe", (req, res) => subscribeHandler(req, res));
app.post("/api/feedback", (req, res) => feedbackHandler(req, res));

app.get("/", (req, res) => {
  res.sendFile(join(staticDir, "index.html"));
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
