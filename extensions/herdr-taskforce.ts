// herdr-taskforce box extension
// Part of the herdr-taskforce pi package. Provides the async message box for
// multi-agent teams: pi tools to send/poll/history + background delivery that
// injects incoming messages into interface/leader sessions.
//
// The box is a plain SQLite file read/written through the `sqlite3` CLI
// (bash + sqlite3, no daemon) — the pi runtime does not expose node:sqlite.
//
// Environment (set on the pane/session where needed):
//   HERDR_TASKFORCE_ROLE   "interface" | "leader" | "" (delivery enabled only
//                          for interface/leader)
//   HERDR_TASKFORCE_ME     this agent's box identity (e.g. "interface",
//                          "leader-1")
//   HERDR_TASKFORCE_ROOM   room/team id (default "default")
//   HERDR_TASKFORCE_DB     box db path override (default
//                          ~/.herdr-taskforce/box.db)
//   HERDR_TASKFORCE_SQLITE3  sqlite3 executable (default "sqlite3")
// @ts-nocheck
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { Type } from "typebox";

const ROLE = process.env.HERDR_TASKFORCE_ROLE ?? "";
const ME = process.env.HERDR_TASKFORCE_ME ?? "";
const SQLITE3 = process.env.HERDR_TASKFORCE_SQLITE3 ?? "sqlite3";
const BOX_DIR = process.env.HERDR_TASKFORCE_DB
  ? dirname(process.env.HERDR_TASKFORCE_DB)
  : join(homedir(), ".herdr-taskforce");
const DB_PATH = process.env.HERDR_TASKFORCE_DB ?? join(BOX_DIR, "box.db");
const POLL_MS = 2000;

let inited = false;
let pollTimer = null;

// SQL literal escaping (single quote -> doubled)
function esc(s) {
  return String(s).replaceAll("'", "''");
}

function ensureInit() {
  if (inited) return;
  mkdirSync(BOX_DIR, { recursive: true });
  execFileSync(SQLITE3, [
    DB_PATH,
    [
      "PRAGMA journal_mode = WAL;",
      "CREATE TABLE IF NOT EXISTS messages (",
      "  id INTEGER PRIMARY KEY AUTOINCREMENT,",
      "  room TEXT NOT NULL,",
      "  sender TEXT NOT NULL,",
      "  recipient TEXT NOT NULL,",
      "  body TEXT NOT NULL,",
      "  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,",
      "  delivered_at TEXT",
      ");",
      "CREATE INDEX IF NOT EXISTS idx_messages_inbox ON messages(recipient, delivered_at);",
    ].join("\n"),
  ]);
  inited = true;
}

function run(sql) {
  return execFileSync(SQLITE3, [DB_PATH, `PRAGMA busy_timeout = 3000;\n${sql}`], {
    encoding: "utf8",
  }).trim();
}

function query(sql) {
  // busy_timeout PRAGMA emits its own JSON row in -json mode (3.50+), so run it
  // in a separate call to keep the SELECT's stdout pure JSON.
  execFileSync(SQLITE3, [DB_PATH, "PRAGMA busy_timeout = 3000;"], {
    encoding: "utf8",
  });
  const out = execFileSync(SQLITE3, ["-json", DB_PATH, sql], {
    encoding: "utf8",
  }).trim();
  return out ? JSON.parse(out) : [];
}

function sendMessage(room, sender, recipient, body) {
  ensureInit();
  // busy_timeout PRAGMA echoes its value (e.g. "3000"), so take the LAST line
  // (the SELECT last_insert_rowid() result).
  const out = run(
    `INSERT INTO messages (room, sender, recipient, body) VALUES ('${esc(room)}','${esc(sender)}','${esc(recipient)}','${esc(body)}');\nSELECT last_insert_rowid();`
  );
  const last = out.split("\n").map((l) => l.trim()).filter(Boolean).pop();
  return Number(last);
}

function peekUndelivered(recipient, room, limit) {
  ensureInit();
  const roomCond = room ? ` AND room = '${esc(room)}'` : "";
  return query(
    `SELECT id, room, sender, body, created_at FROM messages WHERE recipient = '${esc(recipient)}' AND delivered_at IS NULL${roomCond} ORDER BY id ASC LIMIT ${Number(limit)};`
  );
}

function markDelivered(id) {
  ensureInit();
  run(`UPDATE messages SET delivered_at = CURRENT_TIMESTAMP WHERE id = ${Number(id)};`);
}

function history(room, limit) {
  ensureInit();
  return query(
    `SELECT id, room, sender, recipient, body, created_at FROM messages WHERE room = '${esc(room)}' ORDER BY id DESC LIMIT ${Number(limit)};`
  ).reverse();
}

function fmt(row) {
  return `[herdr-taskforce box] room: ${row.room} | from: ${row.sender}\n${row.body}`;
}

function startDelivery(pi, ctx) {
  if (!["interface", "leader"].includes(ROLE) || !ME) return;
  if (ctx.hasUI !== true) return; // delivery only in interactive TUI sessions (not -p/print)
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(() => {
    try {
      const rows = peekUndelivered(ME, undefined, 5);
      for (const row of rows) {
        try {
          ctx.ui?.notify?.(`box: ${row.sender} (${row.room})`, "info");
          if (ctx.isIdle()) {
            pi.sendUserMessage(fmt(row));
          } else {
            pi.sendUserMessage(fmt(row), { deliverAs: "followUp" });
          }
          markDelivered(row.id);
        } catch (err) {
          console.error("[herdr-taskforce] deliver one:", err);
        }
      }
    } catch (err) {
      console.error("[herdr-taskforce] delivery loop:", err);
    }
  }, POLL_MS);
  pollTimer.unref?.(); // never keep the process alive (esp. -p/print mode); TUI keeps it alive in interactive sessions
}

export default function (pi) {
  pi.registerTool({
    name: "htf_send",
    label: "Taskforce box: send",
    description:
      "Send a message to another agent via the herdr-taskforce box (~/.herdr-taskforce/box.db). Sender is this agent (" +
      (ME || "unset") +
      ").",
    parameters: Type.Object({
      recipient: Type.String({
        description: "Recipient agent name (e.g. 'interface' or a leader name)",
      }),
      body: Type.String({ description: "Message body (markdown)" }),
      room: Type.Optional(
        Type.String({ description: "Room/team id (default 'default')" })
      ),
      sender: Type.Optional(
        Type.String({
          description: "Sender override (default: this agent's identity)",
        })
      ),
    }),
    async execute(_toolCallId, params) {
      try {
        const id = sendMessage(
          params.room ?? "default",
          params.sender ?? ME,
          params.recipient,
          params.body
        );
        return {
          content: [{ type: "text", text: `sent message id=${id}` }],
          details: { id },
        };
      } catch (err) {
        return { content: [{ type: "text", text: `htf_send error: ${err.message}` }], details: {} };
      }
    },
  });

  pi.registerTool({
    name: "htf_poll",
    label: "Taskforce box: poll inbox",
    description:
      "Fetch undelivered messages addressed to this agent (" +
      (ME || "unset") +
      ") in the herdr-taskforce box and mark them delivered.",
    parameters: Type.Object({
      room: Type.Optional(Type.String({ description: "Room filter" })),
      limit: Type.Optional(Type.Number({ description: "Max messages (default 20)" })),
    }),
    async execute(_toolCallId, params) {
      try {
        const rows = peekUndelivered(ME, params.room, params.limit ?? 20);
        for (const row of rows) markDelivered(row.id);
        return {
          content: [
            {
              type: "text",
              text: rows.length
                ? rows.map((r) => `[${r.id}] ${r.room} ${r.sender}: ${r.body}`).join("\n")
                : "(no messages)",
            },
          ],
          details: { count: rows.length },
        };
      } catch (err) {
        return { content: [{ type: "text", text: `htf_poll error: ${err.message}` }], details: {} };
      }
    },
  });

  pi.registerTool({
    name: "htf_history",
    label: "Taskforce box: room history",
    description:
      "Show the most recent messages in a room of the herdr-taskforce box (does not mark delivered).",
    parameters: Type.Object({
      room: Type.Optional(
        Type.String({ description: "Room/team id (default 'default')" })
      ),
      limit: Type.Optional(
        Type.Number({ description: "Max messages (default 20)" })
      ),
    }),
    async execute(_toolCallId, params) {
      try {
        const rows = history(params.room ?? "default", params.limit ?? 20);
        return {
          content: [
            {
              type: "text",
              text: rows.length
                ? rows
                    .map(
                      (r) =>
                        `[${r.id}] ${r.created_at} ${r.sender} -> ${r.recipient}: ${r.body}`
                    )
                    .join("\n")
                : "(empty room)",
            },
          ],
          details: { count: rows.length },
        };
      } catch (err) {
        return { content: [{ type: "text", text: `htf_history error: ${err.message}` }], details: {} };
      }
    },
  });

  pi.on("session_start", (_event, ctx) => startDelivery(pi, ctx));
  pi.on("session_shutdown", () => {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  });
}
