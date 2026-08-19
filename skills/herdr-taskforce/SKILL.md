---
name: herdr-taskforce
description: >-
  非同期マルチエージェントチーム運用（pi + Herdr）。ユーザーと対話する
  インターフェースが意思決定し、Herdr の新しいワークスペースに リーダー/
  サポーター/ビルダーズ/エバリュエータズ のタスクフォースを起動・指揮する。
  チームとの非同期通信は sqlite 依頼箱（~/.herdr-taskforce/box.db、
  htf_send / htf_poll）経由で行い、インターフェースは待機でブロックしない。
  Use when the user asks to run a multi-agent team, spin up a taskforce,
  delegate implementation to a team without blocking the conversation, or
  uses 'herdr-taskforce'.
---

# Herdr Taskforce

あなたは**インターフェース**です。ユーザーと直接対話し、ユーザーと共に
意思決定を行い、その決定を下位のエージェントチーム（タスクフォース）へ
命令します。ユーザーのタスク達成について責任を持ちます。

チームとのやり取りは**非同期**です。あなたは `herdr agent wait` や
`herdr agent prompt --wait` で**決してブロックしません**。ユーザーとは
いつでも会話を続けられます。

## 前提

1. このセッションが Herdr 管理下にあること:

   ```bash
   test "${HERDR_ENV:-}" = 1 && command -v herdr
   ```

2. このセッションが**インターフェースとして起動**されていること
   （配信拡張が有効になります）:

   ```bash
   HERDR_TASKFORCE_ROLE=interface HERDR_TASKFORCE_ME=interface HERDR_TASKFORCE_ROOM=main pi
   ```

3. `herdr-taskforce` パッケージがインストール済みであること
   （拡張 = box ツール + 配信、スキル = 本ファイル）。

## 役割とモデル

| 役割 | pi `--model` | thinking |
|------|--------------|----------|
| インターフェース（あなた） | 現行セッションのまま | — |
| リーダー leader | `opencode-go/deepseek-v4-pro` | `max` |
| サポーター supporter | `opencode-go/kimi-k3` | `max` |
| ビルダーズ builders | `opencode-go/deepseek-v4-flash` | `max` |
| エバリュエータズ evaluators | `opencode-go/gpt-5.6-luna` | `max` |

## 依頼箱（box）

- 場所: `~/.herdr-taskforce/box.db`（sqlite / WAL）
- ツール（拡張が提供）:
  - `htf_send` — 送信（`recipient` / `body` / `room`）
  - `htf_poll` — 自分宛の未読を取得（取得したものは既読化）
  - `htf_history` — room の履歴を表示
- 配信: 拡張が約2秒間隔で自分宛の未読を監視し、`sendUserMessage` で
  注入 + トースト通知します（`HERDR_TASKFORCE_ROLE=interface|leader` の
  セッションのみ有効）。
- 名前: インターフェースは **`interface`**。リーダーは起動時に一意な名前
  （例: `leader-1`）を付けます。room はチームごとに分離します。

## 運用フロー

### Phase 1 — 要件整理

grilling スキル（`~/.pi/agent/skills/grilling/SKILL.md`）でユーザーの要求を
不明点0まで整理します。

### Phase 2 — チーム起動（リーダー + サポーター）

新しいワークスペースを作成し、同じタブ内に**左右分割**でリーダー
（左）とサポーター（右）を起動します。リーダーのペインに box 用の
環境変数を設定します。

```bash
set -euo pipefail
WORKDIR=<プロジェクトディレクトリ>   # ユーザーと相談して決定
ROOM=<チーム識別子>                  # 例: team-1
LEADER=<一意なリーダー名>            # 例: leader-1

# ワークスペース作成（ルートペイン = リーダー用。env はルートペインに設定）
WS_JSON=$(herdr workspace create --cwd "$WORKDIR" --label "$ROOM" \
  --env HERDR_TASKFORCE_ROLE=leader --env HERDR_TASKFORCE_ME=$LEADER --env HERDR_TASKFORCE_ROOM=$ROOM \
  --no-focus)
LEADER_PANE=$(echo "$WS_JSON" | python3 -c 'import sys,json;print(json.load(sys.stdin)["result"]["root_pane"]["pane_id"])')

# 右にサポーター用ペインを分割（env なし）
SUPP_PANE=$(herdr pane split --pane "$LEADER_PANE" --direction right --cwd "$WORKDIR" --no-focus \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["result"]["pane"]["pane_id"])')

herdr pane rename "$LEADER_PANE" "$LEADER"
herdr pane rename "$SUPP_PANE"   supporter

herdr agent start "$LEADER"  --kind pi --pane "$LEADER_PANE" -- --model opencode-go/deepseek-v4-pro --thinking max --approve
herdr agent start supporter --kind pi --pane "$SUPP_PANE"   -- --model opencode-go/kimi-k3       --thinking max --approve
```

### Phase 3 — ブリーフィングと疎通確認（非同期）

起動後、役割と規約を伝えます（`--wait` なし。返答は box で受け取ります）:

```bash
herdr agent prompt "$LEADER" "You are the leader '$LEADER' in team '$ROOM'.
1. Read /home/kpn-didy/.pi/agent/skills/herdr-taskforce/references/roles.md
   and /home/kpn-didy/.pi/agent/skills/herdr/SKILL.md.
2. Reply 'leader ready' to the interface VIA THE BOX: htf_send recipient=interface
   body='leader ready' room=$ROOM."
```

サポーターにも同様に（`supporter ready`）送らせます。`htf_poll` で
`leader ready` / `supporter ready` を確認できたら疎通OKです。

### Phase 4 — 意思決定の命令

ユーザーと固めた意思決定をリーダーに命令します（`--wait` なし）:

```bash
herdr agent prompt "$LEADER" "Implement the following decision.
Read the referenced docs and follow your role protocol.
Questions to the user must go through the box (htf_send recipient=interface).
<意思決定・要求内容>"
```

### Phase 5 — 非同期監視

- **リーダーからの質問**: 配信拡張が注入します → ユーザーに中継し、
  回答を `htf_send`（recipient=$LEADER, room=$ROOM）で返します。
- **リーダーからの完了報告**: 同様に注入されます → 成果物を確認し、
  ユーザーへ完了報告します。
- **進捗確認**（ユーザーが聞いたとき）: `htf_poll` / `htf_history`、
  または非ブロッキングの `herdr agent read $LEADER --source recent-unwrapped --lines 60`。

### Phase 6 — 完了

リーダーから完了報告（box）を受けたら、成果物と `git status` を確認し、
ユーザーに報告します。必要ならリーダーを残したまま次のタスクを命令できます。

## 複数チームの並行運用

- room とリーダー名をチームごとに分ければ、複数チームを同時に指揮できます。
- 質問の注入には sender 名が含まれるので、どのチームからの質問か判別できます。
- 進捗は `htf_history --room <room>` でチームごとに確認できます。

## 注意

- **ブロック禁止**: インターフェースは `herdr agent wait` および
  `herdr agent prompt --wait` を実行しません。チームとの通信は box 経由です。
- あなたが作ったワークスペース・ペインのみ閉じます。ユーザーの既存の
  ワークスペースは触りません。
- チーム内通信（リーダー⇔サポーター/ビルダーズ/エバリュエータズ）は
  herdr 経由です。box はユーザー⇔チーム境界の専用チャネルです。
