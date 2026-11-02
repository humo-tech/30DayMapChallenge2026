# Day 2: Lines — 実装解説

日本の新幹線全10路線を Overture Maps から取り出し、紺色の地球の上で光らせる。各路線では光の玉が始発駅から勢いよく飛び出し、ブレーキをかけながら終着駅へ滑り込む。これを繰り返す。

| ファイル | 役割 |
|---|---|
| `scripts/day02/extract_shinkansen.py` | Overture Maps の線路データから、各路線を始発→終着の1本の線にして GeoJSON に書き出す |
| `public/data/day02/shinkansen.geojson` | 上のスクリプトの出力（10路線） |
| `app/maps/day02.vue` | ページ本体。地球を作り、データを読み、部品を並べる |
| `app/maps/lib/RailGlowMeshDesc.ts` | 光る線路と走る光の玉を描く自作の Navara 部品 |
| `app/maps/lib/shaders/railLine.{vert,frag}.glsl` | 線のシェーダー（常時の光と彗星の尾） |
| `app/maps/lib/shaders/railPulse.{vert,frag}.glsl` | 玉のシェーダー（白い芯とにじみ） |

```
extract_shinkansen.py ──▶ shinkansen.geojson
                                 │ fetch
day02.vue ───────────────────────┤
  ├─ ThreeView（Navara の地球ビュー）
  ├─ 背景：大気の縁の光・星・陸地・海岸線
  ├─ RailGlowMeshDesc に路線の座標を渡す
  └─ 毎フレーム tick(秒) を呼ぶ ──▶ 玉が動く・尾が伸びる
```

---

## 1. データ：`extract_shinkansen.py`

### 何をしているか

1. Overture Maps の `transportation` テーマから、日本周辺の鉄道（`subtype = 'rail'`）の線路を DuckDB で S3 から直接読む。
   - 転送量が大きく、15分以上かかる。そのため結果を `scripts/.cache/day02_rail.parquet` に保存し、2回目以降はそれを使う（数秒で終わる）。
   - 取り直すときは `--refresh` を付ける。
2. 線路データは1路線1本の線になっていない。
   - 上り線と下り線が別々になっている。
   - 渡り線や車庫への引き込み線が混ざっている。
   - 分岐点ごとに細かく分割されている。

   そこで、線路の頂点を「点」、隣り合う頂点の間を「辺」とする**グラフ**を作る。
3. 路線ごとに、始発駅の近く（半径 1.5km 以内）の点から終着駅の近くの点までの**最短経路**を Dijkstra 法で求める。
   - これで複線や引き込み線が自然に落ち、始発→終着の順に並んだ1本の線になる。
4. 頂点を間引いて（`ST_SimplifyPreserveTopology`、約 20m）GeoJSON に書き出す。

### 使う線路の選び方

| 路線 | 使うグラフ |
|---|---|
| フル規格（東海道・山陽・九州・西九州・東北・北海道・上越・北陸） | 名前に「新幹線」または「shinkansen」を含む線路だけ |
| ミニ新幹線（山形・秋田） | 在来線を走るので、鉄道の線路全部 |

- `class = 'unknown'` の線路（中央新幹線、北海道新幹線の札幌延伸区間など、工事中や計画中のもの）は除く。
- 山陽新幹線は一部の区間の名前がローマ字（`Sanyō-Shinkansen`）になっている。「新幹線」だけで絞ると姫路付近で線がつながらず、経路が見つからない。そのため `ILIKE '%shinkansen%'` でも拾っている。

### 結果の確かめ方

実行すると各路線の長さが出る。公式の距離と比べて、取り出しが正しいか確認できる。

| 路線 | 抽出 | 公式 |
|---|---|---|
| 東海道 | 512 km | 515.4 km |
| 東北 | 672 km | 674.9 km |
| 山陽 | 550 km | 553.7 km |

---

## 2. ページ本体：`day02.vue`

### HTML

```vue
<template>
  <div ref="container" class="map-canvas" />
</template>
```

HTML は空の `<div>` が1つあるだけ。Navara がこの中に `<canvas>` を作り、WebGL で描画する。`ref="container"` を付けておくと、TypeScript から `container.value` でこの要素を取れる。

### ライフサイクル

```ts
onMounted(async () => { ... })                       // div が画面に置かれた後に初期化
onBeforeUnmount(() => { view?.dispose() })           // ページを離れる前に GPU メモリなどを解放
```

### データ読み込みと初期化を並行に

```ts
const [routes] = await Promise.all([
  fetch(`${dataBase}/shinkansen.geojson`).then((r) => r.json() as Promise<Routes>),
  v.init(),
])
if (view !== v) return // unmounted while initializing
```

- GeoJSON のダウンロードと Navara の初期化（WASM の読み込みなど）を同時に進め、両方が終わるのを待つ。
- 待っている間にユーザーが別ページへ移動すると、`onBeforeUnmount` が `view` を `undefined` にする。その場合は `view !== v` になるので、続きの処理をやめる。
- `Routes` 型は、GeoJSON のうち実際に使う `features[].geometry.coordinates` だけを書いた最小限の型。

### 部品の登録・追加・アニメーション

```ts
v.registerMesh('railGlow', RailGlowMeshDesc)

const bloom = v.addEffect({ selectiveBloom: { strength: 1.8, radius: 0.6, threshold: 0 } })

const rails = v.addMesh<RailGlowMeshDesc>({
  effectIds: [bloom.id],
  railGlow: { routes: routes.features.map((f) => ({ coords: f.geometry.coordinates })) },
})
v.on('preUpdate', () => rails.ref.tick(performance.now() / 1000))
```

- **`registerMesh`**：Navara は設定オブジェクトのキー名を見て、使う部品クラスを決める。ここで「`railGlow` というキーが来たら `RailGlowMeshDesc` を使う」と登録している。
- **`selectiveBloom`**：指定した物体だけを光ってにじませる後処理エフェクト。
  - 陸地や海岸線は光らせず、線路だけを光らせたい。
  - そこで `effectIds: [bloom.id]` で線路の部品を対象に指定している。
- **`preUpdate`**：毎フレーム、描画の直前に呼ばれるイベント。
  - ページを開いてからの秒数を `tick()` に渡して、玉を動かす。
  - `rails.ref` で部品クラスのインスタンス本体を取り出せる。

---

## 3. 光る線路の部品：`RailGlowMeshDesc.ts`

### なぜ自作したか

Navara にも線を描く標準機能（`polyline` レイヤー）があり、海岸線はそれで描いている。ただし、この標準の線は**ブルームが光の強さを読み取る場所（emissive バッファ）に何も書かない**。そのため光らせられない。

そこで three.js の物体とシェーダーを自前で書き、Navara の描画パイプラインにつないだ。

### MeshDesc

`MeshDesc` は「three.js の物体を Navara の地球に載せるための部品」の基底クラス。

```ts
export class RailGlowMeshDesc extends MeshDescWithSelectiveEffect<RailGlowConfig, RailGlowUpdate, Group> {
```

- `createMesh()` を実装すると、Navara がそれを呼んでシーンに追加する。
- `MeshDescWithSelectiveEffect` は、ブルームなどの selective effect に対応した版。
- 型引数は「設定の型」「更新時の型」「`createMesh` が返す three.js オブジェクトの型」。
  - 今回は線（`LineSegments`）と玉（`Points`）の2つを返したいので、`Group` にまとめている。

設定値は、デフォルト値を利用者の指定で上書きして使う。

```ts
private get options() {
  return { ...DEFAULTS, ...this.config.railGlow }
}
```

---

## 4. `createMesh()`：GPU に渡すデータを作る

### 緯度経度 → 3D座標、累積距離

```ts
const p = geodeticToVector3(lle)                       // 経度・緯度・高さ → ECEF 座標
dists[j] = prev ? dists[j - 1]! + p.distanceTo(prev) : 0
```

- **ECEF 座標**：地球の中心を原点とする、メートル単位の 3D 座標。Navara の 3D 空間はこの座標系。
- **高さ 4km**：陸地のポリゴンと同じ高さに置くと、重なってちらつく。それを避けるために浮かせている。
- **累積距離 `dists`**：各頂点が始発駅から何 m の地点にあるか。玉の位置も尾の計算も、すべてこの「距離」を基準にしている。
- CPU 側では `Float64Array`（倍精度）で正確な値を持っておく。GPU に渡すときは `Float32Array`。

### 路線ごとの所要時間と休み

```ts
const duration = opts.baseDuration + length / opts.cruise          // 走る時間
const pause = pauseMin + rand(i + 0.5) * (pauseMax - pauseMin)      // 到着後の休み
phase: rand(i + 1) * (duration + pause)                             // 出発タイミングのずらし
```

- 長い路線ほど時間をかけて走る（東海道は約 1.6 秒、西九州は約 0.6 秒）。
- `rand` は、シード値から毎回同じ値を返す疑似乱数。全路線が同時に発車すると単調になるので、休みの長さと出発タイミングを路線ごとにばらつかせている。

### 線のジオメトリ

`LineSegments` は「2頂点で1本の線分」を並べて描く three.js のオブジェクト。頂点ごとに、位置以外のデータ（**attribute**）も持たせられる。

| attribute | 中身 |
|---|---|
| `position` | ECEF 座標 |
| `aDist` | 始発駅からの距離（m） |
| `aRoute` | 路線番号（0〜9） |

### 玉のジオメトリ

`Points` に、路線数ぶん（10個）の点を用意する。中身は毎フレーム `tick()` で書き換える。

| attribute | 中身 |
|---|---|
| `position` | 玉の ECEF 座標 |
| `aAlpha` | 不透明度（0 なら非表示） |
| `aScale` | 大きさの倍率（減速すると小さくなる） |

---

## 5. シェーダー

シェーダーは GPU で動く小さなプログラム（GLSL）で、2段階ある。

### ファイルの分け方と読み込み

シェーダーは `app/maps/lib/shaders/` の `.glsl` ファイルに置き、Vite の `?raw` で**文字列として** import している。

```ts
import lineVertexShader from './shaders/railLine.vert.glsl?raw'
```

- ビルド時に、ファイルの中身が JS の文字列としてバンドルに埋め込まれる。実行時に別途ダウンロードされることはない。
- `.glsl` ファイルにしておくと、エディタで GLSL の構文ハイライトが効く。
- `projectionMatrix`、`modelViewMatrix`、`position` などは宣言なしで使える。three.js の `ShaderMaterial` が、コンパイル前に自動で宣言を先頭に付け足すため。
- `ROUTE_COUNT` も宣言していない。`RailGlowMeshDesc` が `material.defines` に入れ、three.js が `#define ROUTE_COUNT 10` として先頭に付け足す。
- `setupMaterialForMRT` は「ファイル最後の `}` が `main()` の閉じ括弧」とみなして、その直前に G-buffer への書き込みを差し込む。**fragment shader では `main()` を最後に書く**こと。

| 段階 | 実行単位 | 役割 |
|---|---|---|
| vertex shader | 頂点ごと | 3D 座標を画面上の位置に変換する |
| fragment shader | ピクセルごと | そのピクセルの色を決める |

データの渡し方は3種類ある。

| 種類 | 中身 | 例 |
|---|---|---|
| **attribute** | 頂点ごとのデータ | `aDist` |
| **uniform** | 全体で共通の値。JS から毎フレーム変えられる | `uPulses` |
| **varying** | vertex から fragment へ渡す値。線分の途中では両端の値が**補間**される | `vDist` |

### 線：補間で「ピクセルごとの距離」を得る（`railLine.vert.glsl`）

```glsl
vDist = aDist;   // vertex shader
```

始点が 100,000 m、終点が 110,000 m の線分なら、真ん中のピクセルには 105,000 が届く。こうして fragment shader では、ピクセルごとに「始発駅から何 m の地点か」が分かる。

### 線：彗星の尾（`railLine.frag.glsl`）

```glsl
uniform vec2 uPulses[ROUTE_COUNT];   // 路線ごとの (玉の位置 m, 尾の長さ m)

vec2 pulse = uPulses[int(vRoute + 0.5)];
float behind = pulse.x - vDist;                      // このピクセルが玉の何 m 後ろか
float k = behind >= 0.0 && behind < pulse.y ? pow(1.0 - behind / pulse.y, 2.0) : 0.0;
gl_FragColor = vec4(uColor * 0.55 + mix(uColor, uPulseColor, k) * k * 2.5, 1.0);
```

- `uPulses` は路線ごとの値の配列。中身は `tick()` が毎フレーム書き換える。
- `behind` が 0〜尾の長さの範囲なら尾の中。玉に近いほど `k` が 1 に近づく。
- `pow(..., 2.0)` で、尾の先に向かって急に暗くなる形にしている。
- 色の内訳：
  - `uColor * 0.55`：いつも光っている線の色
  - `mix(uColor, uPulseColor, k) * k * 2.5`：玉に近いほど白く強く光る成分
- 尾の長さ（`pulse.y`）は玉の速度に比例する（後述）。走っている最中は長く伸び、止まると 0 になって消える。

### 玉：円く切り抜いて芯とにじみを描く（`railPulse.*.glsl`）

```glsl
gl_PointSize = uSize * aScale * uPixelRatio;   // vertex shader：大きさに倍率を掛ける

float d = length(gl_PointCoord - 0.5) * 2.0;   // 中心からの距離（0〜1）
if (d > 1.0 || vAlpha <= 0.0) discard;         // 円の外は描かない
float core = smoothstep(0.45, 0.0, d);         // 中心の白い芯
float halo = pow(1.0 - d, 2.0);                // 外側の、線の色のにじみ
```

`Points` は本来四角いスプライト。それを中心からの距離で円く切り抜き、白い芯の周りを線の色でぼかしている。

---

## 6. `tick()`：イージングで玉を動かす

### 今どの段階か（`u`）

```ts
const cycle = r.duration + r.pause
const local = (time - r.phase) % cycle   // negative before the first run
const u = (local < 0 ? local + cycle : local) / r.duration
if (u > 1) { /* 休憩中：玉も尾も消す */ }
```

1回の周期は「走る時間 + 休み」。`u` は走行の進み具合で、0 が発車、1 が到着。1 を超えていれば休憩中なので、玉と尾を消す。

JavaScript の `%` は負の数に負の結果を返す。ページを開いた直後は `time - phase` が負になるので、`cycle` を足して正の範囲に戻している。

### イージング：easeOutExpo

「最初にシュッと飛び出して、ブレーキをかけながら止まる」動きは **easeOutExpo** で作っている。

```ts
const EXPO = 10
const EXPO_SCALE = 1 / (1 - 2 ** -EXPO)
function ease(u: number): number {        // 進んだ割合（0〜1）
  return (1 - 2 ** (-EXPO * u)) * EXPO_SCALE
}
function easeSpeed(u: number): number {   // ease の微分＝その瞬間の速さ
  return EXPO * Math.LN2 * 2 ** (-EXPO * u) * EXPO_SCALE
}
```

- `1 - 2^(-10u)` は、最初に急上昇して、あとはゆっくり 1 に近づく曲線。
- `u = 1` でもちょうど 1 にはならない（0.999）。そこで `EXPO_SCALE` を掛けて、ぴったり 1（終着駅）で終わるようにしている。
- `easeSpeed` は `ease` の微分で、その瞬間の速さを表す。発車直後が最大で、平均の約 7 倍。

| `u`（時間の進み） | 0 | 0.1 | 0.2 | 0.33 | 0.5 | 1 |
|---|---|---|---|---|---|---|
| 進んだ距離 | 0% | 50% | 75% | 90% | 97% | 100% |

時間の最初の 1/3 で路線の 9 割を走り抜け、残りの時間はずっと減速している。

### 速さを見た目に使う

```ts
const d = r.length * ease(u)                          // 玉の位置（m）
const speed = (r.length * easeSpeed(u)) / r.duration  // 速さ（m/s）
pulses[i]!.set(d, speed * tailTime)                   // 尾の長さ = 速さ × 0.09 秒
scale.setX(i, pulseMinScale + (1 - pulseMinScale) * Math.sqrt(easeSpeed(u) / easeSpeed(0)))
alpha.setX(i, Math.min(1, u / 0.015, (1 - u) / 0.3))
```

| 見た目 | 決め方 | 効果 |
|---|---|---|
| 尾の長さ | 速さ × `tailTime` | 発車直後は約 200km の長い尾、止まると消える |
| 玉の大きさ | 発車時の速さとの比の平方根 | 減速とともに 100% → 35% まで小さくなる |
| 不透明度 | 最初の 1.5% で出現、最後の 30% でフェードアウト | 発車は一瞬で現れ、ほぼ止まった状態で静かに消える |

大きさを速さの比そのものにすると、発車直後にすぐ縮んでしまう。平方根を取ると、しばらく大きいまま進んでから小さくなる。

| `u` | 0 | 0.1 | 0.2 | 0.4 | 1 |
|---|---|---|---|---|---|
| 大きさ | 100% | 81% | 67% | 51% | 35% |

### 距離から 3D 座標へ

```ts
let j = 1
while (j < r.dists.length - 1 && r.dists[j]! < d) j++    // d を挟む2頂点を探す
const t = (d - d0) / (r.dists[j]! - d0)                   // 2頂点間の比率
position.setXYZ(i, p[a] + (p[b] - p[a]) * t, ...)         // 直線補間
```

累積距離の配列から、距離 `d` を挟む2頂点を探し、その間を直線補間して玉の 3D 座標を出す。書き換えたら `needsUpdate = true` にして、three.js に GPU への再送を指示する。

**尾は GPU、玉は CPU** に分けている理由：

- 尾はピクセルごとの色付けなので、シェーダーが向いている。
- 玉は「距離 → 3D 座標」の変換に路線の形が必要。CPU なら配列を探すだけで済み、玉は 10 個なので負荷も軽い。

---

## 7. ブルームにつなぐ：`makeMaterial`

Navara は1回の描画で、複数の画像（**G-buffer**）に同時に書き込む（**MRT**：Multiple Render Targets）。

| バッファ | 中身 |
|---|---|
| color | 普通の色 |
| effectId | このピクセルがどのエフェクトの対象かを表すビット |
| emissive | どれだけ光っているか |

ブルームは effectId と emissive を読んで、光る部分だけをにじませる。

```ts
material.defines.USE_SELECTIVE_EFFECT = 1
material.userData.uEffectIdsMask = { value: 0 }
material.uniforms.uEffectIdsMask = material.userData.uEffectIdsMask
material.uniforms.uEmissiveColor = { value: new Vector3() }
material.uniforms.uEmissiveIntensity = { value: 1 }
setupMaterialForMRT(material)
```

- **`setupMaterialForMRT`**：Navara の関数。自作シェーダーの `main()` の最後に、G-buffer へ書き込むコードを自動で付け足す。
  - 付け足されたコードは `normal` という変数を読む。そのため fragment shader 側で `vec3 normal = vec3(0.0, 0.0, 1.0);` を定義している。
- **`USE_SELECTIVE_EFFECT`**：付け足されたコードのうち、effectId と emissive を書く分岐を有効にする。
- **`uEmissiveColor = 0`、`uEmissiveIntensity = 1`**：
  - emissive には `(シェーダーの出力色 + uEmissiveColor) × uEmissiveIntensity` が書かれる。
  - この値にしておくと、出力色がそのまま光の強さになる。
- **`uEffectIdsMask`**：どのエフェクトの対象かを表すビットマスク。
  - `userData` と `uniforms` に**同じオブジェクト**を入れる。
  - そうすると、Navara が `userData` 側の値を書き換えたときに、シェーダーにもそのまま反映される。

親クラスの `updateEffectIdsMask()` は、マテリアルが1つの Mesh しか想定していない。今回は線と玉の2つのマテリアルがあるので、上書きして両方にマスクを設定している。

```ts
protected override updateEffectIdsMask(): void {
  const mask = this._effectIds.length > 0 ? registry.computeMask(this._effectIds) : 0
  for (const m of [this.lineMaterial, this.pointMaterial]) {
    if (m) m.userData.uEffectIdsMask.value = mask
  }
}
```

### その他の設定

| 設定 | 理由 |
|---|---|
| `blending: AdditiveBlending` | 色を上書きせず足し算する。光が重なるほど明るくなり、発光らしく見える |
| `depthWrite: false` | 光が奥行きを書き込まないので、後ろの光が隠れない |
| `frustumCulled = false` | three.js の「画面外なら描かない」判定を切る。ECEF 座標で毎フレーム動く物体だと判定がずれ、見えているのに消えることがある |

---

## 8. 調整ポイント

`RailGlowMeshDesc.ts` の `DEFAULTS`：

| 設定 | 今の値 | 効果 |
|---|---|---|
| `color` | `#1ee8ff` | 線の色（玉のにじみもこの色） |
| `pulseColor` | `#f2fdff` | 玉の芯と尾の先端の色 |
| `cruise` | 450 km/s | 大きいほど速く走り抜ける |
| `baseDuration` | 0.5 s | 走行時間に足す固定時間 |
| `pause` | [0.6, 1.8] s | 到着から次の発車までの休み |
| `tailTime` | 0.09 s | 大きいほど尾が長い |
| `pulseSize` | 26 px | 発車時の玉の大きさ |
| `pulseMinScale` | 0.35 | 止まったときの玉の大きさ（発車時に対する比） |

コード内の値：

| 場所 | 今の値 | 効果 |
|---|---|---|
| `EXPO` | 10 | 大きいほど飛び出しが鋭く、ブレーキが長い（6〜8 で穏やか、12〜15 で鋭い） |
| `railLine.frag.glsl` の `uColor * 0.55` | 0.55 | 常に光っている線の明るさ |
| `tick()` の `(1 - u) / 0.3` | 0.3 | 到着後、消えるまでにかける時間の割合 |
| `day02.vue` の `selectiveBloom.strength` | 1.8 | にじみの強さ |
