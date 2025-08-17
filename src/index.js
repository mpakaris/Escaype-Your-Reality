import cors from "cors";
import dotenv from "dotenv";
import express from "express";
import { promises as fs } from "fs";
import helmet from "helmet";
import morgan from "morgan";
import path from "path";
import { beginSequence } from "./game/flow.js";
import webhookRouter from "./routes/webhook.js";
import { sendText } from "./services/whinself.js";

dotenv.config();

const app = express();
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(morgan("dev"));

app.get("/health", (req, res) => res.json({ ok: true }));
app.use("/webhooks/whatsapp", webhookRouter);
app.use("/webhook", webhookRouter); // alias

app.post("/startGame", async (req, res) => {
  try {
    const { phonenumber, gameUUID } = req.body || {};
    if (!phonenumber || !gameUUID) {
      return res.status(400).json({
        error: "invalid_body",
        message: "phonenumber and gameUUID required",
      });
    }
    const jid = `${String(phonenumber)}@s.whatsapp.net`;

    const dbRoot = path.resolve(process.cwd(), "src", "db");
    const userPath = path.join(dbRoot, "user", `${phonenumber}.json`);
    const gamePath = path.join(dbRoot, "games", `${gameUUID}.json`);

    let user, game;
    try {
      user = JSON.parse(await fs.readFile(userPath, "utf-8"));
    } catch {
      return res.status(404).json({ error: "user_not_found" });
    }
    try {
      game = JSON.parse(await fs.readFile(gamePath, "utf-8"));
    } catch {
      return res.status(404).json({ error: "game_not_found" });
    }

    user.currentGameUuid = gameUUID;
    user.currentState = user.currentState || {};
    const st =
      user.currentState[gameUUID] ||
      (user.currentState[gameUUID] = {
        chapter: 0,
        step: 0,
        location: null,
        inStructure: false,
        structureId: null,
        roomId: null,
        inventory: [],
        visitedLocations: [],
        flags: {
          introSequenceSeen: false,
          tutorialComplete: false,
          didFirstMove: false,
          unlockedObjects: {},
        },
        objectivesCompleted: [],
        activeObjective: null,
        hintCount: 0,
        lastCommand: null,
      });

    beginSequence(st, { type: "intro", seq: 0, step: 0 });
    await fs.writeFile(userPath, JSON.stringify(user, null, 2), "utf-8");

    try {
      if (game.onPurchase?.success)
        await sendText(jid, game.onPurchase.success);
      const seq = (game.sequences?.intro || [])[0];
      if (seq) {
        if (seq.header) {
          await sendText(jid, seq.header);
          st.flow._headerShown = true; // prevent duplicate header on first /next
        }
        // do not send steps here; let /next drain the entire sequence
        st.flow.step = 0;
        await fs.writeFile(userPath, JSON.stringify(user, null, 2), "utf-8");
        await sendText(jid, "Type */next* to continue, */reset* to restart.");
      } else {
        await sendText(jid, "No intro sequence defined.");
      }
    } catch {}

    return res.json({ ok: true, jid });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "server_error" });
  }
});

app.use((req, res) => res.status(404).json({ error: "not_found" }));
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "server_error" });
});

const port = process.env.PORT || 8080;
app.listen(port, () => console.log(`api on :${port}`));
