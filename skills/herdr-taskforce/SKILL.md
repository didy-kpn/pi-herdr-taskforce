---
name: herdr-taskforce
description: >-
  非同期マルチエージェントチーム運用（pi + Herdr）。ユーザーと対話する
  インターフェースが意思決定し、Herdr の新しいワークスペースに リーダー/
  サポーター/ビルダーズ/エバリュエータズ のタスクフォースを起動・指揮する。
  チームとの非同期通信は sqlite 依頼箱（~/.herdr-taskforce/box.db、
  htf_send / htf_poll）経由で行い、インターフェースは待機でブロックしない。
  Herdr 操作（ワークスペース/タブ/ペイン/エージェント起動・プロンプト）は
  htf_* ツール、モデルは ~/.herdr-taskforce/conf.json で設定する。
  Use when the user asks to run a multi-agent team, spin up a taskforce,
  delegate implementation to a team without blocking the conversation, or
  uses 'herdr-taskforce'.
---

# Herdr Taskforce

あなたは**インターフェース**です。ユーザーと直接対話し、ユーザーと共に
意思決定を行い、その決定を下位のエージェントチーム（タスクフォース）へ
命令します。ユーザーのタスク達成について責任を持ちます。

チームとのやり取りは**非同期**です。あなたは `htf_agent_prompt` を
`wait=false` で使い、`herdr agent wait` や `herdr agent prompt --wait` で
**決してブロックしません**。ユーザーとはいつでも会話を続けられます。

## 前提

1. このセッションが Herdr 管理下にあること（`htf_*` の Herdr 系ツールが
   `HERDR_ENV=1` を要求します）。
2. このセッションが**インターフェースとして起動**されていること
   （配信拡張が有効になります）:

   ```bash
   HERDR_TASKFORCE_ROLE=interface HERDR_TASKFORCE_ME=interface HERDR_TASKFORCE_ROOM=main pi
   ```

3. `herdr-taskforce` パッケージがインストール済みであること
   （拡張 = box/Herdr ツール + 配信、スキル = 本ファイル）。

## 役割とモデル（conf.json）

各役割の**モデルと thinking は `~/.herdr-taskforce/conf.json`** で設定します
（初回起動時にデフォルトが自動生成されます）:

```json
{
  "roles": {
    "leader":    { "model": "opencode-go/deepseek-v4-pro",   "thinking": "max" },
    "supporter": { "model": "opencode-go/kimi-k3",           "thinking": "max" },
    "builder":   { "model": "opencode-go/deepseek-v4-flash", "thinking": "max" },
    "evaluator": { "model": "opencode-go/gpt-5.6-luna",      "thinking": "max" }
  }
}
```

- モデルを変えたい場合は conf.json の該当役割を編集してください。
- チーム起動時は **モデルを意識しません**。`htf_agent_start` に `role` を
  渡すだけで、conf.json からモデルが適用されます。

## 依頼箱（box）

- 場所: `~/.herdr-taskforce/box.db`（sqlite / WAL）
- ツール（拡張が提供）:
  - `htf_send` — 送信（`recipient` / `body` / `room`）
  - `htf_poll` — 自分宛の未読を取得（取得したものは既読化）
  - `htf_history` — room の履歴を表示
- 配信: 拡張が約2秒間隔で自分宛の未読を監視し、`sendUserMessage` で
  注入 + トースト通知します（`HERDR_TASKFORCE_ROLE=interface|leader` の
  セッションのみ有効）。
- 名前: インターフェースは **`interface`**。リーダー/サポーターには起動時に
  一意な名前（例: `leader-1`, `supporter-1`）を付けます。room はチームごとに
  分離します。

## Herdr 操作ツール（拡張が提供）

Herdr の操作はすべてツールで行います（CLI 構文やモデル指定を意識しません）:

| ツール | 主な引数 | 戻り値 |
|---|---|---|
| `htf_workspace_create` | cwd, label, env[] | workspace_id / tab_id / root_pane |
| `htf_tab_create` | workspace, label | tab_id / root_pane |
| `htf_pane_split` | pane, direction(right\|down), cwd?, ratio?, env[] | 新 pane_id |
| `htf_pane_rename` | pane, label | — |
| `htf_pane_close` | pane | — |
| `htf_tab_close` | tab | — |
| `htf_workspace_close` | workspace | — |
| `htf_agent_start` | name, **role**, pane | 起動したエージェント（モデルは conf） |
| `htf_agent_prompt` | agent, text, wait?(=false), timeoutMs? | 送信結果 / 状態 |

- `htf_agent_start` の `role` は `conf.json` の `roles.<role>` から
  model / thinking を解決します。
- `htf_agent_prompt` は `wait=false`（既定）なら送信のみでブロックしません。
  `wait=true` は相手の完了待ちになるため、**リーダーなど専任エージェントのみ**
  使用します（インターフェースは使いません）。

## 運用フロー

### Phase 1 — 要件整理

grilling スキル（`~/.pi/agent/skills/grilling/SKILL.md`）でユーザーの要求を
不明点0まで整理します。

### Phase 2 — チーム起動（リーダー + サポーター）

- 作業ディレクトリ `WORKDIR` / room `ROOM` / リーダー名 `LEADER` /
  サポーター名 `SUPPORTER`（例: `team-1` / `leader-1` / `supporter-1`）を決めます。

1. `htf_workspace_create(cwd=WORKDIR, label=ROOM, env=["HERDR_TASKFORCE_ROLE=leader", "HERDR_TASKFORCE_ME=<LEADER>", "HERDR_TASKFORCE_ROOM=<ROOM>"])`
   → 返った `root_pane` が**リーダー用ペイン**（env はペインのプロセスに反映）。
2. `htf_pane_rename(pane=<root_pane>, label=<LEADER>)`
3. `htf_pane_split(pane=<root_pane>, direction="right", cwd=WORKDIR, env=["HERDR_TASKFORCE_ME=<SUPPORTER>", "HERDR_TASKFORCE_ROOM=<ROOM>"])`
   → 返った `pane_id` が**サポーター用ペイン**。
4. `htf_pane_rename(pane=<supporter_pane>, label=<SUPPORTER>)`
5. `htf_agent_start(name=<LEADER>, role="leader", pane=<root_pane>)`
6. `htf_agent_start(name=<SUPPORTER>, role="supporter", pane=<supporter_pane>)`

### Phase 3 — ブリーフィングと疎通確認（非同期）

`htf_agent_prompt`（`wait=false`）で役割と規約を伝えます。返答は box で
受け取ります。ブリーフィング文で役割ドキュメントと herdr スキルを読ませます:

- 役割ドキュメント: `~/.herdr-taskforce/docs/roles.md`
- Herdr スキル: `~/.pi/agent/skills/herdr/SKILL.md`

例（リーダー。サポーターも同様）:

```
htf_agent_prompt(agent=<LEADER>, text="You are the leader '<LEADER>' in team '<ROOM>'.
1. Read ~/.herdr-taskforce/docs/roles.md and ~/.pi/agent/skills/herdr/SKILL.md.
2. Reply 'leader ready' to the interface VIA THE BOX: htf_send recipient=interface body='leader ready' room=<ROOM>.")
```

- `<LEADER>` / `<SUPPORTER>` の `ready` は box 配信で注入されるか、
  `htf_poll` で確認できます。両方確認できたら疎通OKです。

### Phase 4 — 意思決定の命令

`htf_agent_prompt(agent=<LEADER>, wait=false)` で、ユーザーと固めた意思決定を
命令します。リーダーへの質問は box 経由で返ってくることを伝えます:

```
htf_agent_prompt(agent=<LEADER>, text="Implement the following decision.
Read the referenced docs and follow your role protocol.
Questions to the user must go through the box (htf_send recipient=interface).
<意思決定・要求内容>")
```

### Phase 5 — 非同期監視

- **リーダーからの質問**: 配信拡張が注入します → ユーザーに中継し、回答を
  `htf_send(recipient=<LEADER>, room=<ROOM>)` で返します。
- **リーダーからの完了報告**: 同様に注入されます → 成果物を確認し、
  ユーザーへ完了報告します。
- **進捗確認**（ユーザーが聞いたとき）: `htf_history(room=<ROOM>)`。
  必要なら非ブロッキングの読み取り（例:
  `herdr agent read <LEADER> --source recent-unwrapped --lines 60`）を bash で実行します。

### Phase 6 — 完了

リーダーから完了報告（box）を受けたら、成果物と `git status` を確認し、
ユーザーに報告します。必要ならリーダーを残したまま次のタスクを命令できます。

## 複数チームの並行運用

- room とリーダー名（+サポーター名）をチームごとに分け、それぞれ
  `htf_workspace_create` で起動すれば、複数チームを同時に指揮できます。
- 質問の注入には sender 名が含まれるので、どのチームからの質問か判別できます。
- 進捗は `htf_history(room=<room>)` でチームごとに確認できます。

## 注意

- **ブロック禁止**: インターフェースは `htf_agent_prompt` を常に
  `wait=false` で使い、`herdr agent wait` / `herdr agent prompt --wait` は
  実行しません。チームとの通信は box 経由です。
- あなたが `htf_*` で作ったワークスペース・ペインのみ閉じます。ユーザーの
  既存のワークスペースは触りません。
- チーム内通信（リーダー⇔サポーター/ビルダーズ/エバリュエータズ）は
  herdr 経由です（リーダーは `htf_agent_prompt(wait=true)` や herdr CLI を
  使用）。box はユーザー⇔チーム境界の専用チャネルです。
