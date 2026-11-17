# Day 17: Light & dark — 実装解説

関東平野と富士山を、標高データだけから作った陰影の地図にする。日付（カレンダー）と時刻（スライダー）を動かすと太陽が動き、山の影が伸び縮みする。色は海と陸の 2 色だけで、見えているものはすべて光と影。

| ファイル | 役割 |
|---|---|
| `app/maps/day17.vue` | ページ本体。Navara のレイヤー、日付・時刻の操作、太陽の読み出し |
| `app/maps/lib/solar.ts` | 太陽の高度・方位と日の出・日の入り（表示用の純粋な計算） |

データの前処理はなし。標高は [Mapterhorn](https://mapterhorn.com/attribution) のタイル（Terrarium 形式の WebP、512 px）をブラウザから直接読む。

## 仕組み

- `raster-dem` ソース 1 つ（Mapterhorn、maxZoom 12）を 3 つのレイヤーで使う。
  1. `terrain`：地形の形（`castShadow` / `receiveShadow`）
  2. `raster` + `hillshade`：DEM から法線を作る。地形タイルは法線がないと光が当たらず影も落ちないので、これが太陽の光と影の元になる
  3. `raster` + `elevationHeatmap`：0 m 付近を境に、海（濃い青灰）と陸（明るい灰）の 2 色に塗る
- `ThreeView({ shadow: true })` で影を有効にし、`sun` ライトが影を落とす。太陽の向きは `atmosphere.date` から決まる。
- 時刻は日本標準時（UTC+9）。`new Date('YYYY-MM-DDTHH:MM:00+09:00')` を `atmosphere.date` に入れるだけで、太陽がその日時の位置に動く。
- 画面下の「Sun 26° up, from the WNW · ↑ 04:28 ↓ 19:02」は `solar.ts` の計算（NOAA の簡易式）。スライダーの帯は日の出から日の入りまでを明るく塗る。地点は表示の中心あたり（35.5°N, 139.3°E）。
- ▶ で 1 日を約 20 秒で再生する。

## URL パラメータ（調整用）

`?cam=lng,lat,height,heading,pitch`（カメラ）、`?d=2026-12-22`（日付）、`?t=420`（0 時からの分）。

## 注意

- 初期表示で太陽が地平線の近くにあるときは、影が長く、山頂だけが光る。日没直後も山頂に光が残るのは、Navara の太陽が地平線すれすれまで光を当てるため。
