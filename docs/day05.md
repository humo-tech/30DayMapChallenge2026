# Day 5: Senses: Sight — 実装解説

夜の東京スカイツリーを、PLATEAU の 3D 都市モデル（墨田区 LOD3）で描く。カメラは 3km 先の浅草側から寄っていき、東京ソラマチの屋上に降りて塔を見上げる。視線の先を白い光の帯が昇り、塔に沿って上昇してアンテナの上から見下ろすと、ライトアップが上から下へ「粋」（水色）と「雅」（紫）で塗り替わる。最後に引いて戻り、次の周回は別の方角から入る。

| ファイル | 役割 |
|---|---|
| `scripts/day05/extract_skytree.py` | PLATEAU のスカイツリーのタイルを読み、塔の壁面に LED の点を撒く |
| `public/data/day05/skytree_leds.json` | LED 9,000 点の位置（塔の足元基準、デシメートル整数、115KB） |
| `app/maps/day05.vue` | ページ本体。PLATEAU の読み込み、夜の演出、カメラのツアー |
| `app/maps/lib/SkytreeLedsMeshDesc.ts` | LED を描き、瞬き・光の帯・色の塗り替えをする自作の Navara 部品 |
| `app/maps/lib/shaders/skytreeLed.{vert,frag}.glsl` | LED のシェーダー |

```
PLATEAU tileset.json ──────────────── 3d-tiles レイヤー（街とスカイツリー）
PLATEAU data396.b3dm ─ extract_skytree.py ─▶ skytree_leds.json ─ fetch ─▶ day05.vue
                                                                     │
  毎フレーム（preUpdate）                                              │
   ├─ ツアー時刻 → キーフレームを補間 → setCamera                       │
   └─ tick(時刻, 光の帯の高さ, 塗り替えの高さ) ──▶ SkytreeLedsMeshDesc ◀┘
```

---

## 1. PLATEAU の 3D Tiles を Navara に載せる

PLATEAU の 2025 年度墨田区モデルには、LOD3（テクスチャ付き）の 3D Tiles が公開されている。`tileset.json` は CORS が開いている（`access-control-allow-origin: *`）ので、URL をそのまま Navara の `3d-tiles` ソースに渡せる。

```ts
const tiles = v.addSource({ type: '3d-tiles', url: SUMIDA_LOD3 })
v.addLayer({ type: '3d-tiles', source: tiles, model: { height: -GEOID_M } })
```

### ジオイド高のずれ

PLATEAU の高さは**楕円体高**（標高 + ジオイド高）で入っている。一方、背景の地図は楕円体の上に貼られるので、そのままだと建物が約 37m 浮く。押上付近のジオイド高 36.7m だけ `model.height` で下げて、地図の上に立たせている。LED も同じだけ下げる（3 章）。

### スカイツリーは 1 つのフィーチャー

スカイツリーは `gml:name = 東京スカイツリー` の単独フィーチャーで、`data/4/data396.b3dm`（1.3MB）に 1 棟だけ入っている。ただしこのフィーチャーには、足元の**東京ソラマチ**の建物も含まれている。evaluator で `emissive` を付けると塔と一緒にソラマチまで光ってしまうので、本体は光らせず、LED とブルームだけで光らせている。

### 夜の空

Navara の写実的な空（`addDefaultPhotorealScene`）は大気のデータだけで約 8MB あり、このサイトの本番ビルドには含めていない（`nuxt.config.ts`）。Day 2〜4 と同じく、濃紺の背景と自作の `StarfieldMeshDesc` で夜空にした。

街は真っ暗だと何も見えないので、青みの環境光を弱く（`intensity: 0.25`）当てている。テクスチャの鉄骨がうっすら浮かぶ程度の明るさ。

---

## 2. LED を撒く：`extract_skytree.py`

塔の形にぴったり沿わせるため、LED は PLATEAU のメッシュの上に置く。

1. `data396.b3dm` を取得し、`gml:name` が `東京スカイツリー` だけであることを確かめる（タイルの構成が変わったら止まる）。
2. glTF の Draco 圧縮を [DracoPy](https://github.com/seung-lab/DracoPy) で展開する。glTF は Y-up なので Z-up に直し、`CESIUM_RTC` の中心を足して ECEF にする。
3. アンテナの先端（最高点から 5m 以内）の頂点の重心を、塔の軸とする。軸の真下（最低点の高さ）を原点にした **West-Up-North** 座標に変換する。これは Navara の `geodetic` 配置の座標系と同じ。
4. 三角形を面積に比例して選び、その中に一様に点を打つ（面積あたりの密度がそろう）。
5. 壁面から 0.4m だけ外へずらす。塔の表面と z-fighting しないようにするため。
6. 下から順に並べ、デシメートルの整数にして書き出す。

### ソラマチを除く

メッシュは三角形 2,096 枚と粗く、鉄骨はテクスチャで描かれている。形は半径約 18m の円筒の芯と、下に向かって広がる裾でできている。ソラマチも同じメッシュにあるので、点を打つ面を絞っている。

| 条件 | 値 | 理由 |
|---|---|---|
| 壁（`|法線・上| ≤ 0.7`）で、軸から | 45m 以内 | 塔の壁面 |
| ただし高さ 40m 未満は | 35m 以内 | ソラマチが塔の足元に張り付いているため |
| 水平な面は | 高さ 100m 超のみ | デッキやアンテナの天面。ソラマチの屋上は除く |

---

## 3. LED の部品：`SkytreeLedsMeshDesc.ts`

### 配置

点は塔のローカル座標（West-Up-North、m）のまま `Points` に入れ、メッシュ全体を Navara の `geodetic` で塔の足元に置く。

```ts
geodetic: { ...leds.origin, height: leds.origin.height - GEOID_M },
```

Day 2 の `RailGlowMeshDesc` は ECEF 座標を float32 で直接持っていたが、地上 1.6m まで寄るこの地図では、ECEF の float32 の精度（約 0.5m）では足りない。`geodetic` なら変換行列は JS の倍精度で組まれるので、地面すれすれでも点が震えない。

### 大きさ：m で決めて px にクランプ

```glsl
float px = uSize * projectionMatrix[1][1] * uHalfHeight / max(-mv.z, 1.0);
gl_PointSize = clamp(px, uMinPx, uMaxPx) * (1.0 + vSpark) * uPixelRatio;
```

`projectionMatrix[1][1]` は `cot(画角 / 2)` で、距離 1m にある 1m が画面の半分の高さの何倍に見えるかを表す。これに画面の半分の高さ（CSS px）を掛けると、1.1m の LED が今の距離で何 px かが出る。足元で巨大にならないよう、遠景で消えないよう、1.5〜6px にクランプしている。

### 明るさ：瞬き + 光の帯

```glsl
float rate = 0.6 + fract(aSeed * 7.31) * 1.6;
float tw = pow(0.5 + 0.5 * sin(uTime * rate * 6.2832 + aSeed * 40.0), 6.0);
```

- **瞬き**：LED ごとの乱数 `aSeed` で周期と位相をずらす。`pow(…, 6)` で尖らせ、ほとんどの時間は暗く、ときどき光るようにする。
- **光の帯**：高さ `uSweep` を中心とするガウス型の帯（半幅 18m）と、その下に薄く残る尾。帯の中は白に寄り、点も最大 2 倍に膨らむ。

### 色の塗り替え（ワイプ）

`uColor`（今の色）と `uNextColor`（次の色）を持ち、高さ `uWipe` より上の LED は次の色で描く。`uWipe` を頂上の上から足元の下まで下ろすと、上から下へ色が塗り替わる。境目は白く光らせる。塗り替えが終わったら、両方の色を次の色にそろえる。

### ブルーム

`RailGlowMeshDesc` と同じく、`USE_SELECTIVE_EFFECT` を立てて `setupMaterialForMRT` を通すと、シェーダーの色がそのまま emissive バッファに書かれ、`selectiveBloom` でにじむ。

---

## 4. カメラのツアー

### キーフレーム

カメラの姿勢を、塔の軸を中心にした 4 つの値で表す。

| 値 | 意味 |
|---|---|
| `bearing` | 軸から見たカメラの方位（°） |
| `dist` | 軸からの水平距離（m） |
| `height` | カメラの高さ（m） |
| `look` | 視線を向ける、軸上の高さ（m） |

カメラは常に軸を向き（`heading = bearing + 180`）、俯仰は `atan2(look − height, dist)` で決まる。`look` を上げていけば、それだけで「見上げる」動きになる。

1 周 50 秒のキーフレーム：

| t（秒） | 場面 |
|---|---|
| 0〜5 | 3km 先の浅草側（方位 250°、隅田川越し）から塔を見る |
| 10〜17 | 寄りながら高度を下げる |
| 20〜30 | ソラマチの屋上（高さ 48m、軸から 55m）で塔の周りを回りながら、`look` を 110m → 634m へ上げる |
| 33〜37 | 塔に沿って上昇する |
| 40 | アンテナの上（950m）から真下を見る |
| 45 | 引いて戻る |

次の周回は方位を −140° ずらすので、毎回違う方角から寄っていく。

### 補間

キーフレームの間は 3 次 Hermite 曲線でつなぐ。接線は Catmull-Rom 式で、前後のキーの時間間隔で割ってから区間の長さを掛ける。こうすると、間隔の違うキーの境目でも速度が途切れない。

`dist` と `height` は**対数**で補間する。3,000m → 55m のような寄りでも、遠いうちは速く、近づくほどゆっくりになる。

周回はキーの番号 `i` で無限に続く。`key(i)` は `i` を周回数と周回内の番号に分け、周回数に応じて時刻と方位をずらしたキーを返す。

### 光の帯と塗り替えのタイミング

- t = 19〜31 の間は、光の帯の高さ ＝ 視線の高さ（`look`）。見上げた視線の先を光が昇る。
- t = 34〜41 で塗り替える。ちょうどアンテナの上から見下ろしている場面なので、色が塔を下っていくのが見える。

### 停止と再開

- 毎フレーム `setCamera` で動かしているので、`flyTo` の中断は使えない。代わりに、地図の上で `pointerdown` / `wheel` / `touchstart` があったらツアーを止める。
- **再開**：次の周回の頭の姿勢へ `flyTo` で 3 秒かけて飛び、着いたらそこから時計を進める。
- 右上の表示は今のライトアップ（Iki 粋 / Miyabi 雅）。塗り替えが始まった時点で次の名前に変わる。

---

## 5. 調整ポイント

`SkytreeLedsMeshDesc.ts` の `DEFAULTS`：

| 設定 | 今の値 | 効果 |
|---|---|---|
| `color` | `#8fd8ff` | LED の色（`day05.vue` の `LIGHTINGS` から渡している） |
| `sparkColor` | `#f4fbff` | 光の帯と塗り替えの境目の色 |
| `size` | 1.1 m | LED の大きさ |
| `minPx` / `maxPx` | 1.5 / 6 px | 画面上の大きさの下限・上限 |
| `sweepWidth` | 18 m | 光の帯の半幅 |

`day05.vue`：

| 場所 | 今の値 | 効果 |
|---|---|---|
| `LIGHTINGS` | 粋 `#8fd8ff`、雅 `#b689ff` | ライトアップの色と順番 |
| `KEYS` | — | カメラの道筋。上の表を参照 |
| `ROUND_S` / `ROUND_TURN` | 50 秒 / −140° | 1 周の長さと、周回ごとの方位のずれ |
| `CLIMB` / `WIPE` | 19〜31 秒 / 34〜41 秒 | 光の帯と塗り替えのタイミング |
| `ambient.intensity` | 0.25 | 街の明るさ。上げると鉄骨のテクスチャがよく見える |
| `selectiveBloom.strength` | 1.4 | LED のにじみ |
| `GEOID_M` | 36.7 m | 建物を下げる量。建物が浮く・沈むときに直す |

`extract_skytree.py`：

| 設定 | 今の値 | 効果 |
|---|---|---|
| `--count` | 9,000 | LED の数 |
| `TOWER_RADIUS` / `FOOT_RADIUS` / `FOOT_HEIGHT` | 45 / 35 / 40 m | LED を置く範囲（ソラマチの除き方） |
| `LIFT` | 0.4 m | 壁面から浮かす量。LED がちらつくなら上げる |
