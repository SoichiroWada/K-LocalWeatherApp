import {readFile} from "node:fs/promises";
import {setGlobalOptions} from "firebase-functions";
import {defineSecret, defineString} from "firebase-functions/params";
import {onRequest, Request} from "firebase-functions/https";
import {onSchedule} from "firebase-functions/scheduler";
import * as logger from "firebase-functions/logger";
import {initializeApp} from "firebase-admin/app";
import {getStorage} from "firebase-admin/storage";
import {AddressNotFoundError, Reader, ReaderModel} from "@maxmind/geoip2-node";
import {GEOIP_OBJECT, downloadGeoLite2, saveGeoLite2} from "./geoip.js";

initializeApp();

// For cost control, you can set the maximum number of containers that can be
// running at the same time. This helps mitigate the impact of unexpected
// traffic spikes by instead downgrading performance.
setGlobalOptions({region: "asia-northeast1", maxInstances: 10});

const maxmindAccountId = defineString("MAXMIND_ACCOUNT_ID", {
  description: "MaxMind のアカウント ID（数字）",
});
const maxmindLicenseKey = defineSecret("MAXMIND_LICENSE_KEY");

const isEmulator = process.env.FUNCTIONS_EMULATOR === "true";

/** 読み込んだデータベースを使い回す時間。更新後はこの時間内に切り替わる */
const READER_TTL_MS = 6 * 60 * 60 * 1000;

let readerPromise: Promise<ReaderModel> | null = null;
let readerLoadedAt = 0;

/**
 * GeoLite2 のデータベースを読み込む。読み込んだものはメモリ上で
 * READER_TTL_MS の間使い回し、その後は Storage から読み直す。
 * 環境変数 GEOIP_DB_PATH があれば、Storage ではなくそのファイルを読む
 * （エミュレーターでの動作確認用）。
 * @return {Promise<ReaderModel>} GeoIP2 の Reader
 */
function loadReader(): Promise<ReaderModel> {
  if (readerPromise && Date.now() - readerLoadedAt > READER_TTL_MS) {
    readerPromise = null;
  }
  if (!readerPromise) {
    readerLoadedAt = Date.now();
    readerPromise = (async () => {
      const localPath = process.env.GEOIP_DB_PATH;
      const buffer = localPath ?
        await readFile(localPath) :
        (await getStorage().bucket().file(GEOIP_OBJECT).download())[0];
      return Reader.openBuffer(buffer);
    })();
    // 失敗したら次のリクエストで読み直す
    readerPromise.catch(() => {
      readerPromise = null;
    });
  }
  return readerPromise;
}

/**
 * 利用者の IP アドレスを取り出す。Firebase Hosting 経由では
 * X-Forwarded-For の先頭が利用者の IP になる。
 * エミュレーターでは ?ip= で任意の IP を指定できる。
 * @param {Request} req リクエスト
 * @return {string} IP アドレス
 */
function clientIp(req: Request): string {
  if (isEmulator && typeof req.query.ip === "string") {
    return req.query.ip;
  }
  const forwarded = req.get("x-forwarded-for");
  if (forwarded) {
    return forwarded.split(",")[0].trim();
  }
  return req.ip ?? "";
}

export const location = onRequest({memory: "512MiB"}, async (req, res) => {
  // 利用者ごとに結果が違うので、Hosting の CDN にキャッシュさせない
  res.set("Cache-Control", "private, no-store");

  const ip = clientIp(req);
  let reader: ReaderModel;
  try {
    reader = await loadReader();
  } catch (err) {
    logger.error("GeoLite2 database could not be loaded", err);
    res.status(503).json({error: "geoip_unavailable"});
    return;
  }

  try {
    const city = reader.city(ip);
    const subdivision = city.subdivisions?.[0];
    res.json({
      ip,
      country: city.country?.isoCode ?? null,
      prefecture: {
        code: subdivision?.isoCode ?? null,
        name: subdivision?.names.ja ?? subdivision?.names.en ?? null,
      },
      city: city.city?.names.ja ?? city.city?.names.en ?? null,
      latitude: city.location?.latitude ?? null,
      longitude: city.location?.longitude ?? null,
      accuracyRadius: city.location?.accuracyRadius ?? null,
    });
  } catch (err) {
    if (err instanceof AddressNotFoundError) {
      // プライベート IP など、データベースにない IP
      res.status(404).json({error: "location_not_found", ip});
      return;
    }
    logger.warn("GeoIP lookup failed", {ip, err});
    res.status(400).json({error: "invalid_ip", ip});
  }
});

// MaxMind は毎週火曜と金曜（米国時間）に GeoLite2 を更新するので、
// 日本時間の水曜と土曜の朝に取りに行く
export const updateGeoip = onSchedule(
  {
    schedule: "0 9 * * 3,6",
    timeZone: "Asia/Tokyo",
    secrets: [maxmindLicenseKey],
    memory: "1GiB",
    timeoutSeconds: 300,
    retryCount: 2,
  },
  async () => {
    const db = await downloadGeoLite2(
      maxmindAccountId.value(),
      maxmindLicenseKey.value(),
    );
    const saved = await saveGeoLite2(db);
    logger.info(saved ? "GeoLite2 updated" : "GeoLite2 unchanged", {
      databaseDate: db.databaseDate,
      sha256: db.sha256,
      bytes: db.mmdb.length,
    });
  },
);
