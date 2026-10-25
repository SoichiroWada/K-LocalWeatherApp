// 気象庁の予報区（府県予報区・一次細分区域）の一覧と、
// GeoLite2 の都道府県コードからの変換

const AREA_URL = "https://www.jma.go.jp/bosai/common/const/area.json";

/** 府県予報区（例: 130000 東京都） */
export interface Office {
  code: string;
  name: string;
  /** 地方（例: 関東甲信地方） */
  centerName: string;
  /** 一次細分区域のコード */
  children: string[];
}

/** 一次細分区域（例: 130010 東京地方） */
export interface Class10 {
  code: string;
  name: string;
  office: string;
}

export interface Areas {
  offices: Office[];
  class10s: Map<string, Class10>;
}

interface AreaJson {
  centers: Record<string, { name: string; children: string[] }>;
  offices: Record<string, { name: string; parent: string; children: string[] }>;
  class10s: Record<string, { name: string; parent: string }>;
}

export async function fetchAreas(): Promise<Areas> {
  const res = await fetch(AREA_URL);
  if (!res.ok) {
    throw new Error(`予報区の一覧を取得できませんでした（${res.status}）`);
  }
  const json: AreaJson = await res.json();
  const offices = Object.entries(json.offices).map(([code, o]) => ({
    code,
    name: o.name,
    centerName: json.centers[o.parent]?.name ?? "",
    children: o.children,
  }));
  const class10s = new Map(
    Object.entries(json.class10s).map(([code, c]) => [
      code,
      { code, name: c.name, office: c.parent },
    ]),
  );
  return { offices, class10s };
}

/**
 * 府県予報区が複数ある道県の、予報区ごとの代表地点（緯度, 経度）。
 * GeoLite2 の緯度経度に一番近い予報区を選ぶのに使う。
 */
const MULTI_OFFICE_POINTS: Record<string, [string, number, number][]> = {
  // 北海道
  "01": [
    ["011000", 45.415, 141.673], // 宗谷（稚内）
    ["012000", 43.771, 142.365], // 上川・留萌（旭川）
    ["013000", 44.02, 144.273], // 網走・北見・紋別（網走）
    ["014030", 42.924, 143.196], // 十勝（帯広）
    ["014100", 42.985, 144.381], // 釧路・根室（釧路）
    ["015000", 42.315, 140.974], // 胆振・日高（室蘭）
    ["016000", 43.062, 141.354], // 石狩・空知・後志（札幌）
    ["017000", 41.769, 140.729], // 渡島・檜山（函館）
  ],
  // 鹿児島県
  "46": [
    ["460100", 31.56, 130.558], // 奄美以外（鹿児島）
    ["460040", 28.377, 129.494], // 奄美（名瀬）
  ],
  // 沖縄県
  "47": [
    ["471000", 26.212, 127.681], // 沖縄本島（那覇）
    ["472000", 25.829, 131.232], // 大東島（南大東）
    ["473000", 24.805, 125.281], // 宮古島
    ["474000", 24.34, 124.156], // 八重山（石垣）
  ],
};

/** 位置がわからないときの予報区（東京都） */
export const DEFAULT_OFFICE = "130000";

/**
 * GeoLite2 の都道府県コード（"13" など、ISO 3166-2 の JP- の後ろ）から
 * 府県予報区のコードを決める。
 */
export function officeForPrefecture(
  prefectureCode: string | null,
  latitude: number | null,
  longitude: number | null,
): string | null {
  if (!prefectureCode || !/^\d{2}$/.test(prefectureCode)) {
    return null;
  }
  const points = MULTI_OFFICE_POINTS[prefectureCode];
  if (!points) {
    // 北海道・鹿児島・沖縄以外は「都道府県番号 + 0000」
    return `${prefectureCode}0000`;
  }
  if (latitude === null || longitude === null) {
    return points[0][0];
  }
  let nearest = points[0];
  let nearestDistance = Infinity;
  for (const point of points) {
    const distance = (point[1] - latitude) ** 2 + (point[2] - longitude) ** 2;
    if (distance < nearestDistance) {
      nearest = point;
      nearestDistance = distance;
    }
  }
  return nearest[0];
}
