import {readFile} from "node:fs/promises";
import {setGlobalOptions} from "firebase-functions";
import {onRequest, Request} from "firebase-functions/https";
import * as logger from "firebase-functions/logger";
import {initializeApp} from "firebase-admin/app";
import {getStorage} from "firebase-admin/storage";
import {AddressNotFoundError, Reader, ReaderModel} from "@maxmind/geoip2-node";

initializeApp();

// For cost control, you can set the maximum number of containers that can be
// running at the same time. This helps mitigate the impact of unexpected
// traffic spikes by instead downgrading performance.
setGlobalOptions({region: "asia-northeast1", maxInstances: 10});

/** Cloud Storage 上の GeoLite2 City データベースの場所 */
const GEOIP_OBJECT = "geoip/GeoLite2-City.mmdb";

const isEmulator = process.env.FUNCTIONS_EMULATOR === "true";

let readerPromise: Promise<ReaderModel> | null = null;

/**
 * GeoLite2 のデータベースを読み込む。インスタンスごとに一度だけ読み、
 * 以降はメモリ上のものを使い回す。
 * 環境変数 GEOIP_DB_PATH があれば、Storage ではなくそのファイルを読む
 * （エミュレーターでの動作確認用）。
 * @return {Promise<ReaderModel>} GeoIP2 の Reader
 */
function loadReader(): Promise<ReaderModel> {
  if (!readerPromise) {
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
