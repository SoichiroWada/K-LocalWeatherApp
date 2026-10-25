// 雨雲・衛星画像と天気図のパネル、クリックで開く拡大表示

import {
  createWeatherMap,
  fetchLatestTimes,
  parseJmaTime,
  type LatestTimes,
  type WeatherMap,
} from "./maps.ts";
import { fetchWeatherCharts, type WeatherChart } from "./weathermap.ts";

/** 最新の画像に切り替える間隔（降水ナウキャストは 5 分ごとに更新される） */
const REFRESH_MS = 5 * 60 * 1000;

const $ = <T extends HTMLElement>(selector: string) =>
  document.querySelector<T>(selector)!;

const formatTime = new Intl.DateTimeFormat("ja-JP", {
  timeZone: "Asia/Tokyo",
  month: "numeric",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});
const formatChartTime = new Intl.DateTimeFormat("ja-JP", {
  timeZone: "Asia/Tokyo",
  month: "numeric",
  day: "numeric",
  hour: "numeric",
});

const message = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

/** 背景（ダイアログの外側）をクリックしたら閉じる */
function closeOnBackdrop(dialog: HTMLDialogElement): void {
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  });
}

function timesText(times: LatestTimes): string {
  return (
    `衛星 ${formatTime.format(parseJmaTime(times.satellite))}・` +
    `雨雲 ${formatTime.format(parseJmaTime(times.radar))} 時点`
  );
}

export async function setupRadar(): Promise<void> {
  const timeEl = $<HTMLParagraphElement>("#radar-time");
  const dialogTimeEl = $<HTMLParagraphElement>("#radar-dialog-time");
  const dialog = $<HTMLDialogElement>("#radar-dialog");
  closeOnBackdrop(dialog);

  let times: LatestTimes;
  try {
    times = await fetchLatestTimes();
  } catch (err) {
    timeEl.textContent = message(err);
    return;
  }

  const thumb = createWeatherMap($("#radar-thumb"), times, {
    interactive: false,
  });
  let large: WeatherMap | null = null;
  const showTimes = () => {
    timeEl.textContent = timesText(times);
    dialogTimeEl.textContent = timesText(times);
  };
  showTimes();

  // 拡大表示の地図は、初めて開いたときに作る
  $("#radar-open").addEventListener("click", () => {
    dialog.showModal();
    if (!large) {
      large = createWeatherMap($("#radar-map"), times, { interactive: true });
    } else {
      large.map.invalidateSize();
      large.reset();
    }
  });
  // 縮小表示はパネルの幅が変わったら日本全体を入れ直す
  new ResizeObserver(() => {
    thumb.map.invalidateSize();
    thumb.reset();
  }).observe($("#radar-thumb"));

  setInterval(async () => {
    try {
      times = await fetchLatestTimes();
    } catch {
      return; // 次の更新で取り直す
    }
    thumb.update(times);
    large?.update(times);
    showTimes();
  }, REFRESH_MS);
}

export async function setupWeatherCharts(): Promise<void> {
  const thumb = $<HTMLImageElement>("#chart-thumb");
  const timeEl = $<HTMLParagraphElement>("#chart-time");
  const dialog = $<HTMLDialogElement>("#chart-dialog");
  const tabs = $<HTMLDivElement>("#chart-tabs");
  const large = $<HTMLImageElement>("#chart-large");
  closeOnBackdrop(dialog);

  let charts: WeatherChart[] = [];
  const caption = (c: WeatherChart) =>
    `${c.label}（${formatChartTime.format(c.validTime)}）`;

  const showChart = (index: number) => {
    const c = charts[index];
    large.src = c.url;
    large.alt = `天気図 ${caption(c)}`;
    tabs.querySelectorAll("button").forEach((b, i) => {
      b.setAttribute("aria-selected", String(i === index));
    });
  };

  const load = async () => {
    try {
      charts = await fetchWeatherCharts();
    } catch (err) {
      timeEl.textContent = message(err);
      return;
    }
    thumb.src = charts[0].url;
    timeEl.textContent = caption(charts[0]);
    tabs.replaceChildren(
      ...charts.map((c, i) => {
        const button = document.createElement("button");
        button.type = "button";
        button.role = "tab";
        button.textContent = caption(c);
        button.addEventListener("click", () => showChart(i));
        return button;
      }),
    );
  };
  await load();

  $("#chart-open").addEventListener("click", () => {
    if (charts.length === 0) return;
    showChart(0);
    dialog.showModal();
  });

  setInterval(load, REFRESH_MS);
}
