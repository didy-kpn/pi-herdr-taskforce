# herdr-taskforce

非同期マルチエージェントタスクフォース（pi + Herdr）。ユーザーと対話する
**interface** が意思決定し、Herdr のワークスペースに起動したチーム
（**leader / supporter / builders / evaluators**）を指揮します。
interface は `herdr agent wait` で**ブロックせず**、チームとの通信は
sqlite の**依頼箱**を介して非同期に行います。

## 特徴

- **ノンブロッキング**: interface は待機せず、いつでもユーザーと会話できます。
- **依頼箱**: `~/.herdr-taskforce/box.db`（SQLite / WAL / bash + `sqlite3`、
  デーモンなし）。
- **pi 拡張**: box ツール（`htf_send` / `htf_poll` / `htf_history`）、Herdr 操作
  ツール（ワークスペース/タブ/ペイン/エージェント起動・プロンプト）、
  および box の新着を `sendUserMessage` で interface / leader セッションへ自動配信。
- **複数チーム並行**: `room` 単位でチームを分離し、並行運用できます。

## 役割とモデル

| 役割 | pi `--model` | thinking | 責務 |
|---|---|---|---|
| interface（ユーザー対話） | 現行セッション | — | 意思決定・チームへの命令・タスク達成責任 |
| leader | `opencode-go/deepseek-v4-pro` | `max` | 計画・統制・タスク分解・ビルダーズ/エバリュエータズの指揮 |
| supporter | `opencode-go/kimi-k3` | `max` | 調査・ナレッジ供給・作戦立案補佐（leader とのみ通信） |
| builders | `opencode-go/deepseek-v4-flash` | `max` | リーダーの指示どおり実装 |
| evaluators | `opencode-go/gpt-5.6-luna` | `max` | 検証・テスト・QA・日本語の推敲 |

上表は**初期デフォルト**です。モデルは `~/.herdr-taskforce/conf.json` の
`roles.<役割>` で変更できます（初回起動時に自動生成）。チーム起動時はモデルを
意識せず、`htf_agent_start(role=<役割>)` を呼ぶだけです。

## 設定（conf.json）

`~/.herdr-taskforce/conf.json`（`HERDR_TASKFORCE_CONF` で変更可）:

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

欠けている役割・キーはデフォルトにフォールバックします。

## Herdr 操作ツール

Herdr の操作はすべて pi ツールで行えます（CLI 構文・モデル指定・JSON パースを
意識しない）:

| ツール | 説明 |
|---|---|
| `htf_workspace_create` / `htf_workspace_close` | ワークスペース作成 / クローズ |
| `htf_tab_create` / `htf_tab_close` | タブ作成 / クローズ |
| `htf_pane_split` / `htf_pane_rename` / `htf_pane_close` | ペイン分割 / リネーム / クローズ |
| `htf_agent_start` | role から conf.json のモデルを適用してエージェント起動 |
| `htf_agent_prompt` | プロンプト送信（`wait` 既定 `false`、ブロックしない） |

## インストール

```bash
pi install git:github.com/didy-kpn/pi-herdr-taskforce   # GitHub から
# またはローカルパスで
pi install /path/to/pi-herdr-taskforce
```

インストール後の再起動で、拡張（box ツール + 配信）とスキル
（`/skill:herdr-taskforce`）が利用できます。

## 使い方

1. **interface セッションを起動**（配信拡張が有効になります）:

   ```bash
   HERDR_TASKFORCE_ROLE=interface HERDR_TASKFORCE_ME=interface HERDR_TASKFORCE_ROOM=main pi
   ```

2. 会話で依頼（例:「タスクフォースで実装して」、または `/skill:herdr-taskforce`）。
   interface が `htf_*` ツールで新しい Herdr ワークスペースに team を起動し、
   指示します（モデルは conf.json から自動適用）。

3. 以降は非同期: leader からの質問は box 経由で配信され、インターフェースが
   ユーザーに中継します。完了報告も box 経由で届きます。

## 依頼箱（box）

- 場所: `~/.herdr-taskforce/box.db`（`HERDR_TASKFORCE_DB` で変更可）
- スキーマ:

  ```sql
  CREATE TABLE messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room TEXT NOT NULL,          -- チーム識別子
    sender TEXT NOT NULL,        -- 送信者名
    recipient TEXT NOT NULL,     -- 受信者名（例: "interface", "leader-1"）
    body TEXT NOT NULL,          -- 本文（markdown）
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    delivered_at TEXT            -- 配信済みマーカー
  );
  ```

- 環境変数:

  | 変数 | 説明 |
  |---|---|
  | `HERDR_TASKFORCE_ROLE` | `interface` または `leader`（この値のとき配信が有効） |
  | `HERDR_TASKFORCE_ME` | このエージェントの box 上の名前 |
  | `HERDR_TASKFORCE_ROOM` | room/チーム識別子 |
  | `HERDR_TASKFORCE_DB` | box の DB パス上書き |
  | `HERDR_TASKFORCE_SQLITE3` | `sqlite3` 実行ファイル（既定 `sqlite3`） |

- ツール: `htf_send`（送信）/ `htf_poll`（未読取得・既読化）/ `htf_history`（room 履歴）。

## 動作確認済み

- `pi install` → `pi list` で認識
- 拡張ロード・ツールの実動作（`htf_send` → `htf_history`）
- 配信のライブ検証（box 投入 → トースト通知 → `sendUserMessage` 注入 →
  自動ターン開始 → 返信）
- 複数 room の分離・既読化・履歴

## 注意

- 配信は**対話セッション（TUI）のみ**有効です（`-p` / プリントモードでは起動しません）。
- interface は `herdr agent wait` や `herdr agent prompt --wait` を使いません。
- セキュリティ: pi パッケージはフルシステムアクセスで動作します。ソースを
  確認してからインストールしてください。

## ライセンス

MIT
