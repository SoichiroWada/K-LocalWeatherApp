// 気象庁の天気図（日本周辺のカラー版）

import { parseJmaTime } from "./maps.ts";

const LIST_URL = "https://www.jma.go.jp/bosai/weather_map/data/list.json";
const PNG_URL = "https://www.jma.go.jp/bosai/weather_map/data/png";

export interface WeatherChart {
  /** 実況・24時間後・48時間後 */
  label: string;
  /** 天気図の対象時刻 */
  validTime: Date;
  url: string;
}

interface ListJson {
  near: { now: string[]; ft24: string[]; ft48: string[] };
}

/**
 * ファイル名の 2 つ目の時刻が天気図の基準時刻（UTC）。
 * 例: 20261025141131_0_Z__C_010000_20261025120000_MET_CHT_...
 */
function chart(file: string, label: string, hoursAhead: number): WeatherChart {
  const baseTime = file.split("_")[6];
  return {
    label,
    validTime: new Date(
      parseJmaTime(baseTime).getTime() + hoursAhead * 60 * 60 * 1000,
    ),
    url: `${PNG_URL}/${file}`,
  };
}

/** 最新の実況天気図と、24・48時間後の予想天気図 */
export async function fetchWeatherCharts(): Promise<WeatherChart[]> {
  const res = await fetch(LIST_URL);
  if (!res.ok) {
    throw new Error(`天気図を取得できませんでした（${res.status}）`);
  }
  const { near }: ListJson = await res.json();
  return [
    chart(near.now.at(-1)!, "実況", 0),
    chart(near.ft24.at(-1)!, "24時間後", 24),
    chart(near.ft48.at(-1)!, "48時間後", 48),
  ];
}
