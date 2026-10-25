import "./style.css";
import {
  DEFAULT_OFFICE,
  fetchAreas,
  officeForPrefecture,
  type Areas,
} from "./area.ts";
import { fetchForecast, type DailyForecast, type HourlySlot } from "./jma.ts";

/** /api/location の応答 */
interface LocationResponse {
  ip: string;
  country: string | null;
  prefecture: { code: string | null; name: string | null };
  city: string | null;
  latitude: number | null;
  longitude: number | null;
  accuracyRadius: number | null;
}

/** 表示する地域（府県予報区と一次細分区域） */
interface SelectedArea {
  office: string;
  class10: string;
}

/** 手動で選んだ地域を覚えておくキー */
const STORAGE_KEY = "selectedArea";

const $ = <T extends HTMLElement>(selector: string) =>
  document.querySelector<T>(selector)!;

const locationEl = $<HTMLParagraphElement>("#location");
const officeSelect = $<HTMLSelectElement>("#office");
const class10Select = $<HTMLSelectElement>("#class10");
const hourlyEl = $<HTMLDivElement>("#hourly");
const weeklyEl = $<HTMLDivElement>("#weekly");
const reportEl = $<HTMLParagraphElement>("#report");

const jst = (options: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", ...options });
const formatHour = jst({ hour: "numeric" });
const formatDay = jst({ month: "numeric", day: "numeric", weekday: "short" });
const formatReport = jst({
  month: "numeric",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

async function fetchLocation(): Promise<LocationResponse> {
  // 開発中は ?ip=203.0.113.1 のように付けると、そのIPで調べる（エミュレーターのみ有効）
  const ip = new URLSearchParams(location.search).get("ip");
  const url = ip ? `/api/location?ip=${encodeURIComponent(ip)}` : "/api/location";
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`位置の取得に失敗しました（${res.status}）`);
  }
  return res.json();
}

function loadSavedArea(areas: Areas): SelectedArea | null {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
    if (areas.class10s.get(saved?.class10)?.office === saved?.office) {
      return saved;
    }
  } catch {
    // 保存できない環境（プライベートモードなど）では毎回 IP から決める
  }
  return null;
}

function saveArea(area: SelectedArea): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(area));
  } catch {
    // 保存できなくても表示には影響しない
  }
}

/** IP から推定した位置を表示し、その府県予報区を返す */
async function locateOffice(areas: Areas): Promise<string | null> {
  try {
    const loc = await fetchLocation();
    const place = [loc.prefecture.name, loc.city].filter(Boolean).join(" ");
    locationEl.textContent = place
      ? `現在地（IPアドレスから推定）：${place}`
      : "現在地を特定できませんでした";
    const office = officeForPrefecture(
      loc.country === "JP" ? loc.prefecture.code : null,
      loc.latitude,
      loc.longitude,
    );
    return office && areas.offices.some((o) => o.code === office) ? office : null;
  } catch (err) {
    console.warn(err);
    locationEl.textContent = "現在地を特定できませんでした";
    return null;
  }
}

function fillOfficeSelect(areas: Areas): void {
  const groups = new Map<string, HTMLOptGroupElement>();
  for (const office of areas.offices) {
    let group = groups.get(office.centerName);
    if (!group) {
      group = document.createElement("optgroup");
      group.label = office.centerName;
      groups.set(office.centerName, group);
      officeSelect.append(group);
    }
    group.append(new Option(office.name, office.code));
  }
}

function fillClass10Select(areas: Areas, officeCode: string): void {
  const office = areas.offices.find((o) => o.code === officeCode);
  class10Select.replaceChildren(
    ...(office?.children ?? []).map(
      (code) => new Option(areas.class10s.get(code)?.name ?? code, code),
    ),
  );
}

function selectArea(areas: Areas, area: SelectedArea): void {
  officeSelect.value = area.office;
  fillClass10Select(areas, area.office);
  class10Select.value = area.class10;
  showForecast(area);
}

function firstClass10(areas: Areas, officeCode: string): string {
  return areas.offices.find((o) => o.code === officeCode)!.children[0];
}

let forecastRequest = 0;

async function showForecast(area: SelectedArea): Promise<void> {
  const request = ++forecastRequest;
  hourlyEl.textContent = "読み込み中…";
  weeklyEl.textContent = "読み込み中…";
  try {
    const forecast = await fetchForecast(area.office, area.class10);
    // 読み込み中に別の地域が選ばれたら、古い結果は捨てる
    if (request !== forecastRequest) return;
    hourlyEl.replaceChildren(...forecast.hourly.map(renderHourly));
    weeklyEl.replaceChildren(...forecast.weekly.map(renderDaily));
    reportEl.textContent =
      `${formatReport.format(forecast.reportDateTime)} 発表` +
      `・気温は${forecast.pointName}の予想`;
  } catch (err) {
    if (request !== forecastRequest) return;
    const message = err instanceof Error ? err.message : String(err);
    hourlyEl.textContent = message;
    weeklyEl.textContent = message;
    reportEl.textContent = "";
  }
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text = "",
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  el.className = className;
  el.textContent = text;
  return el;
}

function icon(url: string, alt: string): HTMLImageElement {
  const img = element("img", "icon");
  img.src = url;
  img.alt = alt;
  img.width = 48;
  img.height = 48;
  return img;
}

const orDash = (value: number | null, unit: string) =>
  value === null ? "—" : `${value}${unit}`;

function renderHourly(slot: HourlySlot): HTMLElement {
  const card = element("div", "slot");
  card.append(
    element("div", "slot-time", formatHour.format(slot.time)),
    icon(slot.iconUrl, slot.weather),
    element("div", "slot-weather", slot.weather),
    element("div", "slot-temp", orDash(slot.temperature, "℃")),
    element("div", "slot-pop", `☂ ${orDash(slot.pop, "%")}`),
    element("div", "slot-wind", slot.wind),
  );
  return card;
}

function renderDaily(day: DailyForecast): HTMLElement {
  const card = element("div", "day");
  const temps = element("div", "day-temps");
  temps.append(
    element("span", "temp-max", orDash(day.tempMax, "℃")),
    element("span", "temp-min", orDash(day.tempMin, "℃")),
  );
  card.append(
    element("div", "day-date", formatDay.format(day.date)),
    day.iconUrl ? icon(day.iconUrl, day.weather) : element("div", "icon"),
    element("div", "day-weather", day.weather),
    temps,
    element("div", "day-pop", `☂ ${orDash(day.pop, "%")}`),
    element("div", "day-reliability", day.reliability && `信頼度 ${day.reliability}`),
  );
  return card;
}

async function main(): Promise<void> {
  let areas: Areas;
  try {
    areas = await fetchAreas();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    hourlyEl.textContent = message;
    weeklyEl.textContent = message;
    return;
  }
  fillOfficeSelect(areas);

  officeSelect.addEventListener("change", () => {
    const area = {
      office: officeSelect.value,
      class10: firstClass10(areas, officeSelect.value),
    };
    saveArea(area);
    selectArea(areas, area);
  });
  class10Select.addEventListener("change", () => {
    const area = { office: officeSelect.value, class10: class10Select.value };
    saveArea(area);
    showForecast(area);
  });

  // 位置は毎回表示するが、手動で選んだ地域があればそちらを優先する
  const located = locateOffice(areas);
  const saved = loadSavedArea(areas);
  if (saved) {
    selectArea(areas, saved);
    return;
  }
  const office = (await located) ?? DEFAULT_OFFICE;
  selectArea(areas, { office, class10: firstClass10(areas, office) });
}

main();
