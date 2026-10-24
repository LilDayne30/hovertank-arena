# Hover Tank Arena

最大4人で遊べる、軽量な3Dホバー戦車のブラウザ対戦ゲームです。三人称視点で、滑る・撃つ・跳ぶ操作の気持ちよさを優先しています。PC（キーボード＋マウス）とスマートフォン（タッチ、横画面）に対応しています。

- クライアント：[PlayCanvas Engine](https://developer.playcanvas.com/user-manual/engine/) 2.23（Editor は不使用、Vite でビルド）
- 対戦サーバー：[Colyseus](https://colyseus.io/) 0.18（Node.js、サーバー権威型）
- 公開：Render の無料 Web サービス1つで、画面のファイルと WebSocket サーバーを同じURLから配信（HTTPS／WSS）

## 遊び方

1. 公開URLを開き、「部屋を作る」を押す
2. 表示された招待URL（`?r=部屋ID`）を相手に送る。相手は開いて「この部屋に参加」を押す
3. 1試合5分。撃破数が最も多い人の勝ち。結果を10秒表示したあと、次の試合が自動で始まる

| 操作 | PC | スマホ（横画面） |
|---|---|---|
| 移動 | WASD／矢印キー（画面の向きが基準） | 左半分をドラッグ（その場に出る仮想スティック） |
| 照準 | マウス（画面クリックでマウスを固定、Escで解除） | 右半分をドラッグ。FIREボタンも押したままドラッグで照準できる |
| 射撃 | 左クリック（押しっぱなしで連射）／F | FIRE |
| ジャンプ | Space | JUMP |
| ドリフト | Shift／右クリック（押している間） | DRIFT（押している間） |

照準は画面中央の十字に合わせるだけで、砲弾の落下も自動で補正して砲身の角度が決まります。

## ローカルでの起動

Node.js 20 以上が必要です（22 で確認）。

```bash
npm install
npm run build      # client/ → dist/ を作る
npm start          # http://localhost:2567 でゲームとサーバーが起動
```

開発中は `npm run dev` を使うと、サーバー（:2567、変更時に自動再起動）と Vite（:5173）が同時に立ち上がります。http://localhost:5173 を開いてください。
同じLANのスマホからは `http://<PCのIP>:5173` で開けます。

## テスト

```bash
npm start &                          # 別ターミナルでも可
npm run test:bots                    # 4つのSDKクライアントで同期・命中・満室・再接続を確認
npm i --no-save playwright && npx playwright install chromium   # 初回のみ
npm run test:browser                 # 4つの独立したブラウザで招待URL参加・同期・満室・切断・再読み込み復帰
URL=https://<公開URL> npm run test:browser   # 公開環境に対して実行
MATCH_SECONDS=8 npm start            # 試合時間を短くして終了→次の試合の流れを確認（test/match-end.mjs）
```

`?debug` を付けて開くと、テスト用のカメラ操作フック（`window.__ht.setCam`）が有効になります。

## デプロイ（Render）

リポジトリ直下の `render.yaml`（Blueprint）にすべての設定が入っています。

1. Render に GitHub でサインアップ／サインインする（無料プラン）
2. https://dashboard.render.com/blueprint/new を開き、このリポジトリを選んで「Apply」
3. ビルド（`npm ci && npm run build`）と起動（`npm start`）が自動で行われ、`https://hovertank-arena-xxxx.onrender.com` のようなURLが発行される
4. 以降は `main` に push するたびに自動で再デプロイされる

無料プランの制約：15分間通信がないとスリープし、次にアクセスした人は起動まで約1分待ちます（画面に「サーバーを起動中」と表示されます）。無料枠は月750時間です。

## 構成

```
client/   画面（PlayCanvas）。main.js＝描画・予測・補間・HUD、input.js＝キーボード／マウス／タッチ
server/   Colyseus サーバー。BattleRoom.js＝部屋・試合・命中判定、index.js＝HTTP配信と起動
shared/   クライアントとサーバーで共通の移動・砲弾シミュレーション（sim.js）と、ステージ設定（arena.js）
public/   配信する素材（GLB、当たり判定用の高さマップ）とクレジットページ
tools/    元の .blend から素材を作り直すスクリプト（Blender の Python モジュール bpy を使用）
test/     自動テスト
```

### 通信のしくみ

- サーバーは毎秒30回シミュレーションし、毎秒30回スナップショットを全員に送ります。
- クライアントは入力（移動方向・照準・射撃・ジャンプ・ドリフト）だけを送ります。位置はサーバーが入力から計算するので、クライアントが位置を偽ることはできません。入力は実時間を超える速さでは処理しない（速度改造の防止）、値の範囲も検証しています。
- 自分の戦車はクライアント側で先に動かし（予測）、サーバーの結果が届いたら、まだ処理されていない入力を再計算して補正します。
- 他人の戦車と砲弾は約115ms遅れで、2つのスナップショットの間をつないで表示します（補間）。
- 切断すると20秒間は席を確保し、同じタブで再読み込みすれば同じ戦車で復帰します。満室（4人）のときは参加を断ります。

### 素材の作り直し

```bash
pip install bpy==5.2.3                # Blender の Python モジュール（Python 3.13）
tools/build_assets.sh <arena.blend> <Tank3.blend>
```

ステージは3倍に拡大し、当たり判定用の高さマップ（0.5m間隔）を同時に作ります。戦車は車体と砲塔の2つに分け、砲塔だけを回転させます。

## 素材クレジット

ゲーム内の「クレジット・ライセンス」（`/credits.html`）にも掲載しています。

- ステージ：**Low Poly Desert Arena** by **H4kor** — https://h4kor.itch.io/low-poly-desert-arena — [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)
  - 変更点：.blend から GLB に変換、3倍に拡大、カメラとライトを削除、法線を再計算、マテリアルを元の単色のまま glTF 用に再構成、頂点を量子化、当たり判定用の高さマップを生成
- 戦車：**Tank Pack（Animated Tanks Pack）** by **Quaternius** — https://quaternius.com/packs/animatedtanks.html — [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/)
  - Tank3 を使用。車体と履帯、砲塔と砲身をそれぞれ結合し、アニメーションを除去、プレイヤーごとに色を変更
- PlayCanvas Engine、Colyseus、Express：MIT License

ソースコード自体のライセンスはまだ決めていません（`UNLICENSED`）。

## 既知の制約

- ステージは平らな約60m四方の囲まれた闘技場で、遮蔽物がほぼありません（元の素材の形のまま。障害物の追加はしていません）。
- ラグ補償（撃った時点の相手の位置で当たりを判定し直す処理）はありません。通信の遅れが大きいと、動いている相手に当てにくくなります。
- 照準の上下は砲身の角度として計算されますが、見た目では砲身が上下しません（砲塔が左右に回るだけ）。
- 戦車同士の押し合いはサーバー側だけで処理するため、ぶつかったとき自分の戦車が少し補正されることがあります。
- iOS Safari は全画面表示と画面の向きの固定に対応していないため、縦向きのときは「横向きにしてください」と表示します。
- 部屋はサーバーのメモリ上にあるため、サーバーの再起動やスリープで部屋は消えます。
