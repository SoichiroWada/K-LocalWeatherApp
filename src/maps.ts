// 雨雲（降水ナウキャスト）と気象衛星（ひまわり）の地図

import L from "leaflet";
import "leaflet/dist/leaflet.css";

const BOSAI = "https://www.jma.go.jp/bosai";
// 全球（10分ごと）の時刻を使う。日本域（2.5分ごと）にも同じ時刻の画像がある
const HIMAWARI_TIMES = `${BOSAI}/himawari/data/satimg/targetTimes_fd.json`;
const NOWCAST_TIMES = `${BOSAI}/jmatile/data/nowc/targetTimes_N1.json`;

/** 日本全体（沖縄〜北海道）が入る範囲 */
const JAPAN_BOUNDS: L.LatLngBoundsExpression = [
  [24, 123],
  [46, 146],
];

interface TargetTime {
  basetime: string;
  validtime: string;
  elements?: string[];
}

/** 最新の画像の時刻（気象庁の UTC 表記 "20261025165000"） */
export interface LatestTimes {
  satellite: string;
  radar: string;
}

/** "20261025165000"（UTC）を Date にする */
export function parseJmaTime(time: string): Date {
  const [, y, mo, d, h, mi] = time.match(
    /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})/,
  )!;
  return new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi));
}

async function latestTime(url: string, element?: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`画像の時刻を取得できませんでした（${res.status}）`);
  }
  const times: TargetTime[] = await res.json();
  // 並び順はファイルによって昇順・降順が違うので、一番新しいものを選ぶ
  return times
    .filter((t) => !element || t.elements?.includes(element))
    .map((t) => t.basetime)
    .reduce((a, b) => (a > b ? a : b));
}

export async function fetchLatestTimes(): Promise<LatestTimes> {
  const [satellite, radar] = await Promise.all([
    latestTime(HIMAWARI_TIMES),
    latestTime(NOWCAST_TIMES, "hrpns"),
  ]);
  return { satellite, radar };
}

// 赤外画像（夜も雲が見える）。fd は全球（ズーム 5 まで）、jp は日本域（ズーム 6）
const satelliteUrl = (t: string, area: "fd" | "jp") =>
  `${BOSAI}/himawari/data/satimg/${t}/${area}/${t}/B13/TBB/{z}/{x}/{y}.jpg`;
// 降水ナウキャスト（5分ごとのレーダー実況）
const radarUrl = (t: string) =>
  `${BOSAI}/jmatile/data/nowc/${t}/none/${t}/surf/hrpns/{z}/{x}/{y}.png`;

/**
 * ズームの範囲ごとに使うタイルを切り替えるレイヤー。
 * 気象庁のタイルは一部のズームにしか画像がない（レーダーは偶数のズームだけ、
 * 衛星の日本域はズーム 6 まで）ので、ない段は下の段の画像を拡大して使う。
 */
function zoomedLayers(
  ranges: { minZoom: number; maxZoom?: number; native: number }[],
  url: string,
  options: L.TileLayerOptions,
): { group: L.LayerGroup; setUrl(url: string): void } {
  const layers = ranges.map((r) =>
    L.tileLayer(url, {
      ...options,
      minZoom: r.minZoom,
      maxZoom: r.maxZoom ?? 18,
      maxNativeZoom: r.native,
    }),
  );
  return {
    group: L.layerGroup(layers),
    setUrl: (next) => layers.forEach((l) => l.setUrl(next)),
  };
}

export interface WeatherMap {
  map: L.Map;
  /** 新しい時刻の画像に切り替える */
  update(times: LatestTimes): void;
  /** 日本全体が入るように表示し直す */
  reset(): void;
}

export function createWeatherMap(
  container: HTMLElement,
  times: LatestTimes,
  { interactive }: { interactive: boolean },
): WeatherMap {
  const map = L.map(container, {
    zoomControl: interactive,
    dragging: interactive,
    scrollWheelZoom: interactive,
    doubleClickZoom: interactive,
    touchZoom: interactive,
    boxZoom: interactive,
    keyboard: interactive,
    attributionControl: interactive,
    minZoom: 4,
    maxZoom: 10,
    zoomSnap: interactive ? 1 : 0.25,
  });

  const base = L.tileLayer(
    "https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png",
    {
      attribution:
        '<a href="https://maps.gsi.go.jp/development/ichiran.html">国土地理院</a>',
    },
  ).addTo(map);
  const satelliteOptions = { opacity: 0.65, attribution: "気象庁" };
  const satelliteFd = L.tileLayer(satelliteUrl(times.satellite, "fd"), {
    ...satelliteOptions,
    maxZoom: 5,
    maxNativeZoom: 5,
  });
  // 日本域は範囲外が欠けるので、ズーム 6 以上（日本付近を拡大したとき）だけ使う
  const satelliteJp = zoomedLayers(
    [{ minZoom: 6, native: 6 }],
    satelliteUrl(times.satellite, "jp"),
    satelliteOptions,
  );
  const satellite = L.layerGroup([satelliteFd, satelliteJp.group]).addTo(map);
  const radar = zoomedLayers(
    [
      { minZoom: 0, maxZoom: 5, native: 4 },
      { minZoom: 6, maxZoom: 7, native: 6 },
      { minZoom: 8, maxZoom: 9, native: 8 },
      { minZoom: 10, native: 10 },
    ],
    radarUrl(times.radar),
    { opacity: 0.85 },
  );
  radar.group.addTo(map);

  if (interactive) {
    L.control
      .layers(
        { 地図: base },
        { "気象衛星（赤外）": satellite, "雨雲（レーダー）": radar.group },
        { collapsed: false },
      )
      .addTo(map);
  }

  const reset = () => map.fitBounds(JAPAN_BOUNDS);
  reset();

  return {
    map,
    update(next) {
      satelliteFd.setUrl(satelliteUrl(next.satellite, "fd"));
      satelliteJp.setUrl(satelliteUrl(next.satellite, "jp"));
      radar.setUrl(radarUrl(next.radar));
    },
    reset,
  };
}
