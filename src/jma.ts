// 気象庁の天気予報データの取得と、画面に出す形への変換

import { TELOPS } from "./telops.ts";

const FORECAST_URL = "https://www.jma.go.jp/bosai/forecast/data/forecast";
const VPFD_URL = "https://www.jma.go.jp/bosai/jmatile/data/wdist/VPFD";
const ICON_URL = "https://www.jma.go.jp/bosai/forecast/img";

const THREE_HOURS = 3 * 60 * 60 * 1000;
const SIX_HOURS = 6 * 60 * 60 * 1000;

// 予報JSONを持たず、隣の予報区のJSONに含まれている予報区
const FORECAST_OFFICE_ALIASES: Record<string, string> = {
  "014030": "014100", // 十勝 → 釧路・根室
  "460040": "460100", // 奄美 → 鹿児島県（奄美地方除く）
};

// ---- 気象庁の JSON（使う項目だけ） ----

interface AreaRef {
  name: string;
  code: string;
}

interface ForecastTimeSeries {
  timeDefines: string[];
  areas: ({ area: AreaRef } & Record<string, unknown>)[];
}

/** forecast/{府県予報区}.json。[0] が今日〜明後日、[1] が週間 */
type ForecastJson = { timeSeries: ForecastTimeSeries[] }[];

/** 地域時系列予報（3時間ごと） */
interface VpfdJson {
  areaTimeSeries: {
    timeDefines: { dateTime: string; duration: string }[];
    weather: string[];
    wind: { direction: string; speed: number; range: string }[];
  };
  pointTimeSeries: {
    pointNameJP: string;
    timeDefines: { dateTime: string }[];
    temperature: number[];
  };
}

// ---- 画面に出すデータ ----

export interface HourlySlot {
  time: Date;
  weather: string;
  iconUrl: string;
  temperature: number | null;
  /** 降水確率（%）。6時間ごとの値をそのまま使う */
  pop: number | null;
  wind: string;
}

export interface DailyForecast {
  date: Date;
  weather: string;
  iconUrl: string;
  pop: number | null;
  tempMin: number | null;
  tempMax: number | null;
  /** 信頼度 A/B/C（明日・明後日は空） */
  reliability: string;
}

export interface Forecast {
  /** 気温の代表地点（例: 東京） */
  pointName: string;
  reportDateTime: Date;
  hourly: HourlySlot[];
  weekly: DailyForecast[];
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`天気予報を取得できませんでした（${res.status}）`);
  }
  return res.json();
}

/** 一次細分区域の今日〜明日（3時間ごと）と週間の予報を取得する */
export async function fetchForecast(
  officeCode: string,
  class10Code: string,
  now = new Date(),
): Promise<Forecast> {
  const forecastOffice = FORECAST_OFFICE_ALIASES[officeCode] ?? officeCode;
  const [forecast, vpfd] = await Promise.all([
    getJson<ForecastJson>(`${FORECAST_URL}/${forecastOffice}.json`),
    getJson<VpfdJson & { reportDateTime: string }>(
      `${VPFD_URL}/${class10Code}.json`,
    ),
  ]);
  const pointName = vpfd.pointTimeSeries.pointNameJP;
  return {
    pointName,
    reportDateTime: new Date(vpfd.reportDateTime),
    hourly: buildHourly(vpfd, forecast, class10Code, now),
    weekly: buildWeekly(forecast, class10Code, pointName),
  };
}

function buildHourly(
  vpfd: VpfdJson,
  forecast: ForecastJson,
  class10Code: string,
  now: Date,
): HourlySlot[] {
  const area = vpfd.areaTimeSeries;
  const point = vpfd.pointTimeSeries;
  const temperatureAt = new Map(
    point.timeDefines.map((t, i) => [
      new Date(t.dateTime).getTime(),
      point.temperature[i],
    ]),
  );

  // 降水確率は今日〜明後日の予報の 6 時間ごとの値
  const popSeries = forecast[0].timeSeries[1];
  const popArea = popSeries.areas.find((a) => a.area.code === class10Code);
  const pops = (popArea?.pops as string[] | undefined) ?? [];
  const popStarts = popSeries.timeDefines.map((t) => new Date(t).getTime());
  const popAt = (time: number): number | null => {
    const i = popStarts.findIndex((s) => s <= time && time < s + SIX_HOURS);
    return i === -1 || pops[i] === "" ? null : Number(pops[i]);
  };

  const slots: HourlySlot[] = [];
  area.timeDefines.forEach((t, i) => {
    const time = new Date(t.dateTime);
    // 終わっていないコマから 8 コマ（24 時間分）
    if (time.getTime() + THREE_HOURS <= now.getTime() || slots.length >= 8) {
      return;
    }
    const wind = area.wind[i];
    slots.push({
      time,
      weather: area.weather[i],
      iconUrl: iconForText(area.weather[i], isNight(time)),
      temperature: temperatureAt.get(time.getTime()) ?? null,
      pop: popAt(time.getTime()),
      wind: wind ? `${wind.direction} ${wind.range.replace(" ", "〜")}m/s` : "",
    });
  });
  return slots;
}

function buildWeekly(
  forecast: ForecastJson,
  class10Code: string,
  pointName: string,
): DailyForecast[] {
  const [weatherSeries, tempSeries] = forecast[1].timeSeries;
  // 週間予報の地域は一次細分区域と同じとは限らない（例: 青森県は 2 地域）。
  // コードが一致する地域 → 気温の地点名が一致する地域 → 先頭の地域 の順に選ぶ
  let index = weatherSeries.areas.findIndex((a) => a.area.code === class10Code);
  if (index === -1) {
    index = tempSeries.areas.findIndex((a) => a.area.name === pointName);
  }
  if (index === -1) {
    index = 0;
  }
  const weather = weatherSeries.areas[index];
  const temps = tempSeries.areas[index];
  const codes = weather.weatherCodes as string[];
  const pops = weather.pops as string[];
  const reliabilities = weather.reliabilities as string[];
  const tempsMin = temps.tempsMin as string[];
  const tempsMax = temps.tempsMax as string[];
  const toNumber = (v: string | undefined) =>
    v === undefined || v === "" ? null : Number(v);

  return weatherSeries.timeDefines.map((t, i) => {
    const telop = TELOPS[codes[i]];
    return {
      date: new Date(t),
      weather: telop?.[2] ?? "",
      iconUrl: telop ? `${ICON_URL}/${telop[0]}` : "",
      pop: toNumber(pops[i]),
      tempMin: toNumber(tempsMin[i]),
      tempMax: toNumber(tempsMax[i]),
      reliability: reliabilities[i] ?? "",
    };
  });
}

function isNight(time: Date): boolean {
  // 利用者の PC の時刻設定によらず日本時間で判定する
  const hour = (time.getUTCHours() + 9) % 24;
  return hour >= 18 || hour < 6;
}

/** 地域時系列予報の天気（「晴れ」「くもり」「雨」「雪」など）のアイコン */
function iconForText(text: string, night: boolean): string {
  let code = "200";
  if (text.includes("雨") && text.includes("雪")) {
    code = text.startsWith("雪") ? "340" : "304";
  } else if (text.includes("雪")) {
    code = "400";
  } else if (text.includes("雨")) {
    code = "300";
  } else if (text.includes("晴")) {
    code = "100";
  }
  const [day, nightImage] = TELOPS[code];
  return `${ICON_URL}/${night ? nightImage : day}`;
}
