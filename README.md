# actions

自分のリポジトリで共通に使う GitHub Actions の部品。

## release-decide

main へのマージ（`push`）・定期便（`schedule`）・手動（`workflow_dispatch`）のどれで起こされたかを見て、**今この版を出すか**を決める。
版とリリースノートは Conventional Commits から決める（semantic-release の `@semantic-release/commit-analyzer` と
`@semantic-release/release-notes-generator`、書式は `conventionalcommits`）。ビルド・公開・タグと GitHub Release の作成は呼ぶ側が行う。

解きたいのは次の 2 つを同時に避けること。

- リリース PR（release-please など）は、押し忘れると出ない
- マージ即リリースは、続けてマージしたときや依存の更新で、版が大量に出る

### 判定

| きっかけ | 出す条件 |
| --- | --- |
| `push` | 版を上げる変更があり、**そのうち依存の更新（scope が `deps` / `deps-dev`）でないものが 1 つ以上**あり、**前回の公開から `cooldown-hours`（既定 6）時間以上**たっている |
| `schedule` | 版を上げる変更が 1 つでもある |
| `workflow_dispatch` | 同上（急ぎ・やり直し） |

ほかに、main が先へ進んでいる（後の run が拾う）・main 以外から起こされた・上の 3 つ以外のきっかけ、のときは出さない。
タグが 1 つも無い初回は、push でも待ち時間を見ずに出す。出さないときも、理由を `reason` と step summary に出す。

前回の公開日時は、前回のタグの GitHub Release の公開日時。Release が無ければ注釈付きタグの日時、それも無ければタグのコミットの日時を使う。

### 使い方

```yaml
name: Release

on:
  push:
    branches: [main]
  schedule:
    - cron: "23 18 * * *" # 毎日 03:23 JST（毎時 0 分は混んで遅れる）
  workflow_dispatch:

# push と定期便が重なっても 1 本ずつ。先の run は main が進んでいれば何もせず、後の run がまとめて出す
concurrency:
  group: release
  cancel-in-progress: false

permissions:
  contents: read

jobs:
  decide:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    outputs:
      version: ${{ steps.decide.outputs.version }}
      tag: ${{ steps.decide.outputs.tag }}
      notes: ${{ steps.decide.outputs.notes }}
    steps:
      - id: decide
        uses: tanmen/actions/release-decide@v1.0.0

  publish:
    needs: decide
    if: needs.decide.outputs.version != ''
    runs-on: windows-latest
    permissions:
      contents: write
    steps:
      # 書き込みのトークンを .git/config に残さない（ビルド中に動く依存から読めてしまう。gh は GH_TOKEN を使う）
      - uses: actions/checkout@v7
        with:
          persist-credentials: false
      # 1. 版（needs.decide.outputs.version）をビルドに差し込む。ファイルへは書き戻さない
      # 2. ビルドして配布先へ出す
      # 3. 出せたら、タグと GitHub Release を作る
      - shell: bash # Windows の既定の pwsh では "$TAG" が PowerShell の変数として読まれ、空になる
        run: gh release create "$TAG" --target "$GITHUB_SHA" --title "$TAG" --notes "$NOTES"
        env:
          GH_TOKEN: ${{ github.token }}
          TAG: ${{ needs.decide.outputs.tag }}
          NOTES: ${{ needs.decide.outputs.notes }}
```

- **定期便だけ**にするなら `on:` から `push` を外す。**手動だけ**なら `workflow_dispatch` だけにする（仕組みは同じで、きっかけだけ絞る）
- 判定は軽いジョブ（ubuntu・1 分弱）に分け、重いビルドは出すときだけ起こす
- **判定は専用のジョブに置く。** action は中で `actions/checkout`（`clean: true` なので、それまでの成果物と未コミットの変更が消える）と
  `actions/setup-node`（以後の step の node の版も 24 に替わる）を行う

### 入力と出力

| 入力 | 既定 | 中身 |
| --- | --- | --- |
| `cooldown-hours` | `6` | push で即時に出すのは、前回の公開からこの時間がたっているときだけ。`0` なら待ち時間を見ない（依存の更新だけの push は、0 でも定期便に回す） |
| `tag-format` | `v${version}` | タグの形（例 `site-v${version}`）。合わないタグと先行版（`1.0.0-dev.1` など）は前回の版として見ない |
| `branch` | `main` | 出す元のブランチ |
| `initial-version` | `1.0.0` | タグが 1 つも無いときの最初の版 |
| `github-token` | `${{ github.token }}` | main の先頭と前回の Release を引く。contents read で足りる |

| 出力 | 中身 |
| --- | --- |
| `release` | 出すなら `true` |
| `version` / `tag` | 出す版とタグ。出さないなら空 |
| `notes` | 前回からの変更の一覧（Markdown） |
| `next-version` | 出さないときも、出すなら何になるか（`cooldown` / `deps-only` のとき） |
| `last-version` | 前回の版 |

`behind` / `branch` / `event` は版を数える前に止まるので、`next-version` と `last-version` も空になる。
| `reason` | `release` / `cooldown` / `deps-only` / `no-changes` / `behind` / `branch` / `event` |

### 気をつけること

- **参照は版で固定する**（`@v1.0.0`）。更新は dependabot（`github-actions`）に任せる。タグは書き換えないので、動く `v1` は無い
- **タグは配布先へ出したあとに作る。** 先に作ると、出すのに失敗してもその版は「出た」扱いになり、次の run が拾わない。
  タグが無いまま失敗すれば、次の定期便か手動の run が同じ版でやり直す
- **`GITHUB_TOKEN` で作ったタグでは、ほかのワークフローは起動しない。** タグで動く処理を後ろに置かない
- 判定は `push` された時点の main を見る。main が先へ進んでいれば何もしない（緑のまま）ので、成否は run の色ではなく `reason` で見る
- 0.x での破壊的変更（`feat!:` / `BREAKING CHANGE`）は 1.0.0 に上がる（semantic-release と同じ。release-please の `bump-minor-pre-major` とは違う）
- dependabot の接頭辞は、配布物に入る依存を `fix(deps)`（版を上げる・定期便で出る）、入らないものを `chore(deps)` / `chore(deps-dev)`（出さない）にする
- public のリポジトリの `schedule` は、60 日間活動が無いと GitHub が止める

### release-please から移すとき

- `release-please-config.json`・`.release-please-manifest.json`・release-please を回すワークフローを消す
- タグの形が同じ（`v1.2.3`）なら、前回の版はタグからそのまま引き継がれる
- `CHANGELOG.md` は以後更新されない。変更の一覧は GitHub Release に載る
- 版は出すときにビルドへ差し込むので、ファイルの版（`package.json` など）は書き戻さない

### 手元で試す

```bash
npm ci --prefix release-decide
GITHUB_EVENT_NAME=schedule GITHUB_REF=refs/heads/main GITHUB_REPOSITORY=<owner>/<repo> GITHUB_WORKSPACE=<その clone> \
  GITHUB_TOKEN=$(gh auth token) node release-decide/decide.mjs
```

`GITHUB_OUTPUT` が無いと、結果を JSON で標準出力に出す。

### 開発

```bash
npm ci --prefix release-decide
GITHUB_TOKEN=$(gh auth token) node --test "test/*.test.mjs"   # トークンが無いと GitHub の API のテストだけ飛ばす（CI では落ちる）
```

このリポジトリ自身も同じ形で出す（[`.github/workflows/release.yml`](.github/workflows/release.yml)）。

依存の更新（dependabot）は、[`test.yml`](.github/workflows/test.yml) が緑なら major も含めて Kodiak が自動でマージする。
人が差分を読む代わりに、壊れうるものを全部テストで通す。

| 壊れうるもの | 通しているテスト |
| --- | --- |
| 版の決め方・ノートの生成（プラグインの挙動） | `test/decide.test.mjs`（作り物の履歴） |
| GitHub の API（main の先頭・前回の公開日時） | `test/github.test.mjs`（本物の API。基準は immutable な v1.0.0） |
| `main()` と出力の書き出し | test.yml「main の履歴で判定を最後まで通す」 |
| action.yml の配線（checkout・setup-node・npm ci） | test.yml の `uses: ./release-decide` |

## License

MIT
