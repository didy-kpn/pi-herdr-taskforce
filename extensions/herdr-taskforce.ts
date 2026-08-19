// herdr-taskforce box + herdr tools extension
// Part of the herdr-taskforce pi package.
//
// Provides:
//  - The async message box (box): htf_send / htf_poll / htf_history tools and
//    background delivery (sendUserMessage) into interface/leader sessions.
//  - Herdr operations as tools: htf_workspace_create / htf_tab_create /
//    htf_pane_split / htf_pane_rename / htf_pane_close / htf_tab_close /
//    htf_workspace_close / htf_agent_start / htf_agent_prompt. So the
//    interface agent never deals with CLI syntax or arena JSON; it just calls
//    tools.
//  - Per-role model/thinking configuration from ~/.herdr-taskforce/conf.json
//    (auto-generated with defaults on first use). htf_agent_start resolves
//    role -> model/thinking from there, so the agent does not care about models.
//  - This package's references/*.md are copied to ~/.herdr-taskforce/docs/ so
//    team agents can read them at a stable, install-independent path.
//
// Environment:
//   HERDR_TASKFORCE_ROLE   "interface" | "leader" | "" (delivery only for
//                          interface/leader)
//   HERDR_TASKFORCE_ME     this agent's box identity (e.g. "interface")
//   HERDR_TASKFORCE_ROOM   room/team id (default "default")
//   HERDR_TASKFORCE_DB     box db path override (default ~/.herdr-taskforce/box.db)
//   HERDR_TASKFORCE_CONF   conf.json override (default ~/.herdr-taskforce/conf.json)
//   HERDR_TASKFORCE_SQLITE3  sqlite3 executable (default "sqlite3")
// @ts-nocheck
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  existsSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { Type } from "typebox";

const ROLE = process.env.HERDR_TASKFORCE_ROLE ?? "";
const ME = process.env.HERDR_TASKFORCE_ME ?? "";
const SQLITE3 = process.env.HERDR_TASKFORCE_SQLITE3 ?? "sqlite3";
const HTF_DIR = join(homedir(), ".herdr-taskforce");
const CONF_PATH = process.env.HERDR_TASKFORCE_CONF ?? join(HTF_DIR, "conf.json");
const BOX_DIR = process.env.HERDR_TASKFORCE_DB
  ? dirname(process.env.HERDR_TASKFORCE_DB)
  : HTF_DIR;
const DB_PATH = process.env.HERDR_TASKFORCE_DB ?? join(BOX_DIR, "box.db");
const DOCS_DIR = join(HTF_DIR, "docs");
const POLL_MS = 2000;

const DEFAULT_ROLES = {
  leader: { model: "opencode-go/deepseek-v4-pro", thinking: "max" },
  supporter: { model: "opencode-go/kimi-k3", thinking: "max" },
  builder: { model: "opencode-go/deepseek-v4-flash", thinking: "max" },
  evaluator: { model: "opencode-go/gpt-5.6-luna", thinking: "max" },
};

let conf = null;
let ready = false;
let inited = false;
let pollTimer = null;

// ---------- config (conf.json) ----------

function loadConf() {
  if (conf) return conf;
  mkdirSync(HTF_DIR, { recursive: true });
  let user = {};
  if (existsSync(CONF_PATH)) {
    try {
      user = JSON.parse(readFileSync(CONF_PATH, "utf8"));
    } catch (err) {
      console.error("[herdr-taskforce] conf parse error:", err.message);
    }
  } else {
    writeFileSync(CONF_PATH, JSON.stringify({ roles: DEFAULT_ROLES }, null, 2) + "\n", "utf8");
  }
  const roles = {};
  for (const [role, def] of Object.entries(DEFAULT_ROLES)) {
    const u = user?.roles?.[role] ?? {};
    roles[role] = { model: u.model ?? def.model, thinking: u.thinking ?? def.thinking };
  }
  conf = { roles };
  return conf;
}

function roleConfig(role) {
  return loadConf().roles[role] ?? { model: undefined, thinking: undefined };
}

// ---------- bundled docs -> ~/.herdr-taskforce/docs ----------

function copyBundledDocs() {
  try {
    const pkgRoot = dirname(dirname(new URL(import.meta.url).pathname)); // <pkg>/extensions/.. -> <pkg>
    const refs = join(pkgRoot, "skills", "herdr-taskforce", "references");
    mkdirSync(DOCS_DIR, { recursive: true });
    for (const f of ["roles.md", "herdr-cheatsheet.md"]) {
      const src = join(refs, f);
      if (existsSync(src)) copyFileSync(src, join(DOCS_DIR, f));
    }
  } catch (err) {
    console.error("[herdr-taskforce] docs copy:", err.message);
  }
}

function ensureReady() {
  if (ready) return;
  loadConf();
  copyBundledDocs();
  ready = true;
}

// ---------- herdr CLI helper ----------

function herdr(...args) {
  if (process.env.HERDR_ENV !== "1") {
    throw new Error("not running inside Herdr (HERDR_ENV != 1)");
  }
  const out = execFileSync("herdr", args, { encoding: "utf8" }).trim();
  if (!out) return null;
  try {
    return JSON.parse(out);
  } catch {
    return { raw: out };
  }
}

function envArgs(env) {
  if (!Array.isArray(env)) return [];
  return env.flatMap((kv) => ["--env", String(kv)]);
}

function errResult(name, err) {
  return {
    content: [{ type: "text", text: `${name} error: ${err && err.message ? err.message : err}` }],
    details: {},
  };
}

function okResult(name, details, text) {
  return {
    content: [{ type: "text", text: `${name}: ${text ?? JSON.stringify(details)}` }],
    details,
  };
}

// ---------- box (sqlite via sqlite3 CLI) ----------

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
  // NOTE: never prepend a PRAGMA here. In -json mode a PRAGMA emits its own
  // result array (e.g. [{"timeout":3000}]) that corrupts JSON.parse; and when
  // the SELECT matches nothing, that array alone is parsed as a fake message.
  const out = execFileSync(SQLITE3, ["-json", DB_PATH, sql], {
    encoding: "utf8",
  }).trim();
  return out ? JSON.parse(out) : [];
}

function sendMessage(room, sender, recipient, body) {
  ensureInit();
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
  const n = Number(id);
  if (!Number.isInteger(n)) return; // never UPDATE ... WHERE id = NaN
  ensureInit();
  run(`UPDATE messages SET delivered_at = CURRENT_TIMESTAMP WHERE id = ${n};`);
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
          if (!Number.isInteger(row.id)) continue; // only deliver real messages
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
  pollTimer.unref?.(); // never keep the process alive (esp. -p); TUI keeps it alive interactively
}

export default function (pi) {
  // herdr tools --------------------------------------------------

  pi.registerTool({
    name: "htf_workspace_create",
    label: "Herdr: create workspace",
    description:
      "Create a new Herdr workspace (new team/room). env sets pane env vars (e.g. HERDR_TASKFORCE_ROLE=leader). Returns workspace_id, tab_id, root_pane (pane_id).",
    parameters: Type.Object({
      cwd: Type.String({ description: "Working directory for the workspace" }),
      label: Type.Optional(Type.String({ description: "Workspace label" })),
      env: Type.Optional(Type.Array(Type.String({ description: "KEY=VALUE pane env vars" }))),
    }),
    async execute(_t, p) {
      try {
        ensureReady();
        const args = ["workspace", "create", "--cwd", p.cwd];
        if (p.label) args.push("--label", p.label);
        args.push(...envArgs(p.env), "--no-focus");
        const r = herdr(...args)?.result ?? {};
        return okResult("htf_workspace_create", {
          workspace_id: r.workspace?.workspace_id,
          tab_id: r.tab?.tab_id,
          root_pane: r.root_pane?.pane_id,
        });
      } catch (e) {
        return errResult("htf_workspace_create", e);
      }
    },
  });

  pi.registerTool({
    name: "htf_tab_create",
    label: "Herdr: create tab",
    description:
      "Create a new tab in a workspace. Returns tab_id and root_pane (pane_id).",
    parameters: Type.Object({
      workspace: Type.String({ description: "Workspace id" }),
      label: Type.Optional(Type.String({ description: "Tab label" })),
      env: Type.Optional(Type.Array(Type.String({ description: "KEY=VALUE pane env vars" }))),
    }),
    async execute(_t, p) {
      try {
        ensureReady();
        const args = ["tab", "create", "--workspace", p.workspace];
        if (p.label) args.push("--label", p.label);
        args.push(...envArgs(p.env), "--no-focus");
        const r = herdr(...args)?.result ?? {};
        return okResult("htf_tab_create", {
          tab_id: r.tab?.tab_id,
          root_pane: r.root_pane?.pane_id,
        });
      } catch (e) {
        return errResult("htf_tab_create", e);
      }
    },
  });

  pi.registerTool({
    name: "htf_pane_split",
    label: "Herdr: split pane",
    description:
      "Split a pane to create a new pane. direction: 'right' or 'down'. env sets pane env vars for the new pane. Returns the new pane_id.",
    parameters: Type.Object({
      pane: Type.String({ description: "Pane id to split" }),
      direction: Type.String({ description: "'right' or 'down'" }),
      cwd: Type.Optional(Type.String({ description: "Working directory for the new pane" })),
      ratio: Type.Optional(Type.Number({ description: "Split ratio (0..1)" })),
      env: Type.Optional(Type.Array(Type.String({ description: "KEY=VALUE pane env vars" }))),
    }),
    async execute(_t, p) {
      try {
        ensureReady();
        const args = ["pane", "split", "--pane", p.pane, "--direction", p.direction];
        if (p.cwd) args.push("--cwd", p.cwd);
        if (typeof p.ratio === "number") args.push("--ratio", String(p.ratio));
        args.push(...envArgs(p.env), "--no-focus");
        const r = herdr(...args)?.result ?? {};
        return okResult("htf_pane_split", { pane_id: r.pane?.pane_id });
      } catch (e) {
        return errResult("htf_pane_split", e);
      }
    },
  });

  pi.registerTool({
    name: "htf_pane_rename",
    label: "Herdr: rename pane",
    description: "Set a pane's label (e.g. a role name).",
    parameters: Type.Object({
      pane: Type.String({ description: "Pane id" }),
      label: Type.String({ description: "New label" }),
    }),
    async execute(_t, p) {
      try {
        ensureReady();
        herdr("pane", "rename", p.pane, p.label);
        return okResult("htf_pane_rename", { pane: p.pane, label: p.label });
      } catch (e) {
        return errResult("htf_pane_rename", e);
      }
    },
  });

  pi.registerTool({
    name: "htf_pane_close",
    label: "Herdr: close pane",
    description: "Close a pane (and its process).",
    parameters: Type.Object({
      pane: Type.String({ description: "Pane id" }),
    }),
    async execute(_t, p) {
      try {
        ensureReady();
        herdr("pane", "close", p.pane);
        return okResult("htf_pane_close", { pane: p.pane });
      } catch (e) {
        return errResult("htf_pane_close", e);
      }
    },
  });

  pi.registerTool({
    name: "htf_tab_close",
    label: "Herdr: close tab",
    description: "Close a tab (and all panes in it).",
    parameters: Type.Object({
      tab: Type.String({ description: "Tab id" }),
    }),
    async execute(_t, p) {
      try {
        ensureReady();
        herdr("tab", "close", p.tab);
        return okResult("htf_tab_close", { tab: p.tab });
      } catch (e) {
        return errResult("htf_tab_close", e);
      }
    },
  });

  pi.registerTool({
    name: "htf_workspace_close",
    label: "Herdr: close workspace",
    description: "Close a workspace (and all its tabs/panes).",
    parameters: Type.Object({
      workspace: Type.String({ description: "Workspace id" }),
    }),
    async execute(_t, p) {
      try {
        ensureReady();
        herdr("workspace", "close", p.workspace);
        return okResult("htf_workspace_close", { workspace: p.workspace });
      } catch (e) {
        return errResult("htf_workspace_close", e);
      }
    },
  });

  pi.registerTool({
    name: "htf_agent_start",
    label: "Herdr: start agent (model from conf)",
    description:
      "Start a pi agent in a pane. role selects model/thinking from ~/.herdr-taskforce/conf.json (roles.<role>.model/.thinking). role: leader | supporter | builder | evaluator.",
    parameters: Type.Object({
      name: Type.String({ description: "Unique agent name (a-z0-9_-)" }),
      role: Type.String({ description: "Role -> conf model (leader/supporter/builder/evaluator)" }),
      pane: Type.String({ description: "Pane id to start in" }),
    }),
    async execute(_t, p) {
      try {
        ensureReady();
        const rc = roleConfig(p.role);
        if (!rc.model) {
          return errResult("htf_agent_start", new Error(`role '${p.role}' is not configured in ${CONF_PATH}`));
        }
        const out = herdr("agent", "start", p.name, "--kind", "pi", "--pane", p.pane, "--",
          "--model", rc.model, "--thinking", rc.thinking, "--approve");
        const a = out?.result?.agent ?? {};
        return okResult("htf_agent_start", {
          name: a.name ?? p.name,
          pane: a.pane_id ?? p.pane,
          model: rc.model,
          thinking: rc.thinking,
          status: a.agent_status,
        });
      } catch (e) {
        return errResult("htf_agent_start", e);
      }
    },
  });

  pi.registerTool({
    name: "htf_agent_prompt",
    label: "Herdr: send prompt to agent",
    description:
      "Send a prompt/command to another agent. wait=false submits without blocking (use for the interface). wait=true waits for the target to settle (timeoutMs, default 600000) — only dedicated agents (e.g. a leader supervising) should block.",
    parameters: Type.Object({
      agent: Type.String({ description: "Agent name" }),
      text: Type.String({ description: "Prompt text" }),
      wait: Type.Optional(Type.Boolean({ description: "Wait for settlement (default false)" })),
      timeoutMs: Type.Optional(Type.Number({ description: "Wait timeout in ms (default 600000)" })),
    }),
    async execute(_t, p) {
      try {
        ensureReady();
        const args = ["agent", "prompt", p.agent, p.text];
        if (p.wait) {
          args.push("--wait", "--timeout", String(p.timeoutMs ?? 600000));
        }
        const out = herdr(...args);
        const status = out?.result?.agent?.agent_status;
        return okResult("htf_agent_prompt", {
          agent: p.agent,
          wait: Boolean(p.wait),
          status,
        }, status ? `agent=${p.agent} status=${status}` : "sent");
      } catch (e) {
        return errResult("htf_agent_prompt", e);
      }
    },
  });

  // box tools -----------------------------------------------------

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
        return okResult("htf_send", { id }, `sent message id=${id}`);
      } catch (err) {
        return errResult("htf_send", err);
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
        return errResult("htf_poll", err);
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
        return errResult("htf_history", err);
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
