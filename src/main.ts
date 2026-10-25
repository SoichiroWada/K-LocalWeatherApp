import "./style.css";

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

async function showLocation(): Promise<void> {
  const el = document.querySelector<HTMLParagraphElement>("#location")!;
  try {
    const loc = await fetchLocation();
    const place = [loc.prefecture.name, loc.city].filter(Boolean).join(" ");
    el.textContent = place ? `現在地（推定）：${place}` : "現在地を特定できませんでした";
  } catch (err) {
    el.textContent = err instanceof Error ? err.message : String(err);
  }
}

showLocation();
