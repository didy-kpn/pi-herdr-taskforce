# Herdr Command Cheat Sheet（herdr-taskforce 用）

チーム内通信のための最小コマンド集。詳細は `~/.pi/agent/skills/herdr/SKILL.md`。

必ず Herdr 管理下で実行: `test "${HERDR_ENV:-}" = 1`

## 状態確認

```bash
herdr agent list                                   # 生存エージェント一覧
herdr agent get <名前>                             # 個別ステータス
herdr agent read <名前> --source recent-unwrapped --lines 120   # 出力を読む
herdr pane list --workspace "$HERDR_WORKSPACE_ID"
herdr tab list --workspace "$HERDR_WORKSPACE_ID"
```

## エージェントに命令・待機

```bash
herdr agent prompt <名前> "<指示>" --wait          # 指示して完了まで待つ（リーダー用）
herdr agent prompt <名前> "<指示>"                 # 指示のみ（インターフェース用: --wait 禁止）
herdr agent wait <名前> --timeout 1800000          # 待機（最大30分）
```

## タブ・ペイン作成

```bash
# タブ作成（例: builders）
herdr tab create --workspace "$HERDR_WORKSPACE_ID" --cwd "$PWD" --label "builders" --no-focus \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["result"]["root_pane"]["pane_id"])'

# ペイン分割（複数のビルダーズ/エバリュエータズを並べる）
herdr pane split --pane <pane> --direction down --cwd "$PWD" --no-focus \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["result"]["pane"]["pane_id"])'

# ペイン名を役割に
herdr pane rename <pane> builder-1
```

## エージェント起動

モデルは `~/.herdr-taskforce/conf.json`（`roles.<role>`）から解決します。
**ツール利用（推奨）**:
`htf_agent_start(name=<名前>, role=<builder|evaluator|...>, pane=<pane>)`

CLI 直打ちの場合は conf.json の model / thinking を指定:

```bash
herdr agent start <名前> --kind pi --pane <pane> -- --model <conf.json の model> --thinking <conf.json の thinking> --approve
```

- 名前は `[a-z][a-z0-9_-]{0,31}`、生存中は一意。

## JSON パース（jq なし）

```bash
python3 -c 'import sys,json;print(json.load(sys.stdin)["result"]["root_pane"]["pane_id"])'
```

## 注意

- `--wait` はリーダーなど「待つことが責務」のエージェントのみ使用。
  インターフェースは使わない（box 経由で非同期に受け取る）。
- 自分が作ったペインだけを閉じる: `herdr pane close <pane>` / `herdr tab close <tab>`。
