# Day 4: Clusters — 実装解説

ハローサイクリングのステーション 15,616 か所をクラスタにまとめ、黄色いストライプの 3D 球として地球の上に置く。カメラは日本全体から都心へ寄っては戻るループで、ズームの段階が変わるたびに球が子のクラスタへ分裂し、ズームアウトでは親へ合体する。

| ファイル | 役割 |
|---|---|
| `public/data/day04/stations.geojson` | 全ステーションの座標とドック数（15,616 点、1.6MB） |
| `app/maps/day04.vue` | ページ本体。クラスタ計算、ズーム判定、数字ラベル、カメラのツアー |
| `app/maps/lib/ClusterSpheresMeshDesc.ts` | 球と足元の光を描き、分裂・合体のアニメーションをする自作の Navara 部品 |
| `public/fonts/inter-latin-700-normal.woff2` | 数字用のフォント（Inter Bold、latin サブセット、SIL OFL 1.1） |

```
stations.geojson ── fetch ──▶ day04.vue
  ├─ supercluster に全ステーションを読み込む
  ├─ 毎フレーム（preUpdate）
  │    ├─ カメラからズームを推定 ── 段階が変わったら ──┐
  │    └─ tick(時刻, m/px) ──▶ ClusterSpheresMeshDesc  │
  │                                 ▲                   │
  │         transition(移動元→先) ──┘◀── 親子を対応付け ┘
  └─ 球が落ち着いたら数字ラベルのレイヤーを作り直す
```

---

## 1. Navara にクラスタリングはない

Navara（`@navaramap/three` 0.2.1）には、MapLibre の `cluster: true` のような点の集約機能がない。近い機能に **declutter** があるが、これは画面上で重なったラベルやスプライトを**隠す**だけで、件数をまとめてはくれない。

そこでクラスタの計算は [supercluster](https://github.com/mapbox/supercluster) で行い、Navara には描画だけを任せている。

### supercluster の設定

```ts
const index = new Supercluster<StationProps, { capacity: number }>({
  radius: CLUSTER_RADIUS_PX, // 60
  maxZoom: MAX_ZOOM,         // 16
  map: (p) => ({ capacity: p.capacity }),
  reduce: (acc, p) => { acc.capacity += p.capacity },
})
```

- `radius`：画面上でこの距離（px）以内の点を 1 つにまとめる。
- `map` / `reduce`：クラスタごとに `capacity` を合計する。件数（`point_count`）は supercluster が自動で数える。
- クラスタは `getClusters([-180, -85, 180, 85], zoom)` で全世界ぶんを取る。日本だけのデータなので、ズーム 13 でも 6,600 件ほどで済む。

### 球の見た目に何を使っているか

| 見た目 | 指標 | 式 |
|---|---|---|
| 球の大きさ | ドック数の合計（`capacity`） | 直径 px = `8 + 3.8 × log2(1 + capacity / 5)` |
| 球の上の数字 | ステーション数（`point_count`） | そのまま。単独のステーションには出さない |
| 足元の光の強さ | ステーション数 | `min(1, log10(count) / 4)`（1 万件で最大） |

ドック数は数個から数万まで幅があるので、大きさは対数にしている。

---

## 2. カメラからズームを推定する

supercluster は Web メルカトルのズーム（整数）でクラスタを返す。3D の地球ではズームという概念がないので、カメラから推定する。

```ts
const centreZoom = () => {
  const pitch = Math.abs(v.camera.orientation.pitch ?? -90)
  return (v.camera.zoom ?? 0) + Math.log2(Math.sin((pitch * Math.PI) / 180))
}
const z = Math.floor(centreZoom() - ZOOM_BIAS)
```

- **`v.camera.zoom`**：Navara が持っている「今の見え方に相当する Web メルカトルのズーム」。ただしカメラの**高度**から計算している。
- **傾きの補正**：カメラが傾くと、画面中央の地面までの距離は高度より長い（高度 ÷ sin(俯角)）。その分ズームを下げる。
- **`ZOOM_BIAS = 1`**：傾いた画面の上の方は中央よりさらに遠く、そこではクラスタ同士が画面上で近づいて球が重なる。1 段粗くクラスタすることで避けている。

同じ式から「画面中央で 1px が何 m か」も出せる。これを毎フレーム球の部品に渡し、px で決めた大きさを m に直している（3 章）。

```ts
const metersPerPx = (156_543.03 * Math.cos(lat)) / 2 ** centreZoom()
```

---

## 3. 球の部品：`ClusterSpheresMeshDesc.ts`

Day 2 の `RailGlowMeshDesc` と同じく、Navara の `MeshDescWithSelectiveEffect` を継承した自作部品。three.js のメッシュを自分で作り、シェーダーも自分で書く。

### 1 回の描画で全部の球を出す（インスタンス描画）

- 単位球（`SphereGeometry(1, 40, 24)`）を 1 つだけ作り、`InstancedBufferGeometry` で最大 16,384 個複製して描く。
- 球ごとに違う値は「インスタンス属性」として GPU に渡す。

| 属性 | 中身 |
|---|---|
| `aCenter` | 球の真下の地面の位置（ECEF、アンカーからの差分） |
| `aUp` | その地点の鉛直上向き（`geodeticSurfaceNormal`） |
| `aSize` | 直径（画面中央での px） |
| `aHeat` | 0〜1。足元の光の強さ |

- 足元の光（平面の円）も同じ属性を共有する。

### 座標の精度：アンカーからの差分にする

ECEF 座標は 600 万 m 台の大きな数で、GPU の float32 では 0.5m 程度の誤差が出る。そこで日本の中央（137.5°E, 36°N）を**アンカー**にして `group.position` に置き、各球の位置はアンカーからの差分で持つ。差分は沖縄まででも 1,700km 程度なので、誤差は 10cm 程度に収まる（球の半径は数十 m 以上あるので見えない）。

### px で決めた大きさを m に直す

```glsl
float r = 0.5 * aSize * uMetersPerPx;
vec4 mv = modelViewMatrix * vec4(aCenter + aUp * r + position * r, 1.0);
```

- 半径 `r`（m）＝ 直径 px の半分 × 1px あたりの m。`uMetersPerPx` は毎フレーム `tick()` で更新する uniform。
- 球の中心を地面から `r` だけ持ち上げ、地面に乗っているように置く。
- 画面中央での px を基準に m に直しているので、ズームしても見た目の大きさはほぼ一定のまま、傾いた画面では奥の球ほど小さく見える（3D らしい遠近感が出る）。

### 陰影：黒ではなく暖色に沈める

```glsl
vec3 L = normalize(vec3(-0.45, 0.7, 0.55));  // 視点座標系で左上・手前からの光
float light = smoothstep(-0.9, 1.0, dot(normal, L)) * mix(0.8, 1.0, 0.5 + 0.5 * dot(normal, up));
vec3 c = albedo * mix(uShade, vec3(1.0), light);
```

- 光源は**視点座標系**に固定している。カメラがどこを向いても、球は常に左上から照らされて見える。
- 影側は黒へ暗くするのではなく、`shadeColor`（`#bf7a00`）へ寄せる。黒を混ぜると黄色が茶色く濁るため。
  - `uShade` は「影の色 ÷ 地の色」の比率。地の色 `#fabe00` は青成分が 0 なので、割り算の分母には下限（0.01）を入れてゼロ除算を防いでいる。
- 鉛直上向きとの角度で、球の下側をさらに少し暗くし、地面に置かれた感じを出している。

### 光沢：プラスチックに見せる

```glsl
c += vec3(pow(nh, 40.0) * 0.32 + pow(nh, 6.0) * 0.05);
```

- 少しぼけたハイライト ＋ 広く薄い照り。
- 鋭いハイライトの点と、縁の強い照り返しは入れない。この 2 つがあると**金属球**に見えた。逆に照りをほぼなくすと**ピンポン玉**に見えた。

### ストライプ

```glsl
vec3 stripeAxis = normalize(up * cos(tilt) - east * sin(tilt));
float s = (asin(dot(normal, stripeAxis)) / PI + 0.5) * uStripes;  // k 本目の中心は k + 0.5
float d = abs(fract(s) - 0.5);
```

- 緯線のように、軸の周りを回る帯を `stripes`（4）本、角度で等間隔に置く。軸は鉛直上向きを東へ `stripeTilt`（15°）倒したもので、少し斜めの水平縞になる。
- 白の幅は `stripeWidth`（帯の間隔に対する比、0.33）。
- `fwidth` で輪郭をアンチエイリアスし、さらに帯が数 px より細くなる小さな球では、ちらつかないよう帯を地の色へ溶かしている。
- 注意：真上近くから見下ろすと、球のてっぺん付近を回る帯は**同心円（的）**に見える。

試して捨てた案：

| 案 | 捨てた理由 |
|---|---|
| 水玉（緯度の輪ごとに入るだけ並べる） | 小さい球では粒が細かすぎて模様に見えない |
| 球に固定した水平軸の周りの帯 | 軸の方向から見ると的に見える |
| 画面に平行な軸の周りの帯 | どの角度でも平行な縞になるが、「地面と水平に」という意図と合わない |

### 足元の光とブルーム

- 球の下の地面に、半径の 2 倍の円を貼り、中心ほど明るいグラデーションを**加算合成**で描く（ステーション数が多いほど明るい）。
- この円だけをブルーム（`selectiveBloom`）の対象にして、光をにじませる。球自体はにじませない。
- 仕組みは Day 2 と同じで、マテリアルに `USE_SELECTIVE_EFFECT` を定義し、`setupMaterialForMRT` を呼ぶ。ブルームに書かれる量は `gl_FragColor` に比例するので、光の強さはシェーダーの出力の明るさで決まる。

### 分裂と合体のアニメーション

```ts
spheres.ref.transition(moves, next, z > zoom ? 'split' : 'merge')
```

- `moves` は「移動元の球 → 移動先の球」の組のリスト。`tick()` が毎フレーム、緯度経度・大きさを補間して属性を書き直す。700ms 後に `next`（新しいズームのクラスタ）に切り替える。
- イージングは 2 種類：
  - 分裂：`easeOutBack`。子が定位置を少し行き過ぎてから戻り、弾けるように見える。
  - 合体：`easeInOutCubic`。子が加速して親へ吸い込まれる。
- アニメーション中以外は属性を書き直さない。毎フレームの更新は uniform（`uMetersPerPx`）1 つだけ。

---

## 4. 分裂・合体の親子を対応付ける

ズームが変わると、supercluster は新しいクラスタの一覧を返すだけで、「どの球がどの球に分かれたか」は教えてくれない。そこで**ステーション（葉）を目印にして**対応付ける。

1. 読み込み時、各ステーションに通し番号 `i` を振る。
2. `ownersOf(items)`：その一覧の各クラスタについて `getLeaves(clusterId, Infinity)` で全ステーションを取り出し、「ステーション番号 → それを含むクラスタ」の表を作る。
3. `leafOf(item)`：クラスタに含まれるステーションを 1 つ取り出す（`getLeaves(clusterId, 1)`）。

```ts
z > zoom
  // ズームイン：新しい各球の移動元 = それを含んでいた古い球
  ? (owners = ownersOf(current), next.map((n) => ({ from: owners.get(leafOf(n)), to: n })))
  // ズームアウト：古い各球の移動先 = それを含む新しい球
  : (owners = ownersOf(next), current.map((o) => ({ from: o, to: owners.get(leafOf(o)) })))
```

- ズームインでは、子の球が親の位置・大きさから出発して自分の位置へ移る。
- ズームアウトでは、古い球が親の位置・大きさへ集まり、最後に親の球 1 つに置き換わる。位置も大きさも一致しているので、切り替わりは見えない。
- 高速に飛んでいて一度に 2 段以上ズームが変わっても、葉で対応付けているのでそのまま動く。

---

## 5. 数字ラベル

数字は Navara の `text` レイヤーで描いている。Navara まわりで引っかかった点が多い。

### `Source.update()` では中身を差し替えられない

`source.update({ type: 'geojson', data })` でインラインのデータを渡しても、表示が変わらなかった。そこでズームが変わるたびに、**新しいソースとレイヤーを作ってから古い方を消す**。数字は球のアニメーションが終わった 700ms 後に作り直す（移動中は数字を消している）。

### テキストのはまりどころ

| 設定 | 理由 |
|---|---|
| `font: FONT` | Navara のテキストは**フォントファイルの指定が必須**。ないと何も描かれない（`material.font is required` の警告だけ出る）。Inter Bold の latin サブセット（24KB）を `public/fonts/` に同梱した |
| `sizeInMeters: true` ＋ `size = fontPx × metersPerPx` | `size` の既定の単位は **m**。px のつもりで 12 を渡すと、宇宙からは見えない。ここでは逆に m 単位を利用して、球と同じく奥ほど小さくなるようにしている |
| `height = 半径 × metersPerPx` | 数字を球の中心の高さに置く |
| `depthTest: false` | 球の手前の面が数字を隠さないように |
| `transparent: true` | 半透明パスで描かせる。これがないと、後から描かれる物体の下に隠れることがあった |
| `center` は指定しない | テキストの `center` は −0.5〜0.5 の範囲で、既定が中央揃え。0.5 を渡すとずれる |

### 文字サイズ

```ts
const fontSize = Math.min(16, (0.8 * size) / (0.62 * text.length))
if (count === 1 || fontSize < 8) return []
```

- 球の直径の 80% に収まる大きさにする（Inter Bold の数字の幅は約 0.62em）。
- 単独のステーションと、8px 未満になってしまう小さな球には数字を出さない。
- `metersPerPx` が 2% 以上変わったときだけ `forceUpdate()` で高さと大きさを計算し直す（毎フレームは計算しない）。

---

## 6. カメラのツアーと停止ボタン

- 日本全体（高度 340 万 m、俯角 70°）と都心（3 万 m、俯角 50°、方位 20°）の間を、9 秒かけて往復する。端で 2.5 秒止まる。
- `flyTo` は、ユーザーがカメラを掴んだり別の `setCamera` が呼ばれたりして中断されると `false` で終わる。そのときはツアーを止める。
- **停止ボタン**：今のカメラ位置と向きで `setCamera` を呼び、飛行を途中で止める。Navara には飛行を止める専用の API が見当たらなかったため、この方法をとっている。
- **再開**：今の高度が 50 万 m より上なら都心へ、下なら日本全体へ向かってループを再開する。
- ツアーの各回に番号を振り、止めるたびに番号を進める。古い回のループは次の段階で自分が古いと気づいて終わる。

---

## 7. 調整ポイント

`ClusterSpheresMeshDesc.ts` の `DEFAULTS`：

| 設定 | 今の値 | 効果 |
|---|---|---|
| `color` | `#fabe00` | 球の地の色 |
| `shadeColor` | `#bf7a00` | 影側の色。濃くすると立体感が強まる |
| `stripeColor` | `#ffffff` | ストライプの色 |
| `stripes` | 4 | ストライプの本数 |
| `stripeWidth` | 0.33 | 白の幅（帯の間隔に対する比） |
| `stripeTilt` | 15° | ストライプの傾き |
| `glowColor` | `#ffe39a` | 足元の光の色 |
| `glow` | 0.55 | 足元の光の強さ |
| `glowScale` | 2 | 足元の光の半径（球の半径に対する比） |
| `duration` | 700 ms | 分裂・合体にかける時間（`day04.vue` の `TRANSITION_MS` から渡している） |

`day04.vue`：

| 場所 | 今の値 | 効果 |
|---|---|---|
| `CLUSTER_RADIUS_PX` | 60 | 大きいほどまとまりやすい（球の数が減る） |
| `ZOOM_BIAS` | 1 | 大きいほど粗くクラスタする。傾いた画面で球が重なるなら上げる |
| `sizeOf` | `8 + 3.8 × log2(1 + capacity / 5)` | 球の大きさ |
| `selectiveBloom.strength` | 1.1 | 足元の光のにじみの強さ |
| シェーダーの `pow(nh, 40.0) * 0.32` | 0.32 | ハイライトの強さ。上げすぎると金属っぽくなる |
