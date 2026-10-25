import {createHash} from "node:crypto";
import {gunzipSync} from "node:zlib";
import {getStorage} from "firebase-admin/storage";
import {Reader} from "@maxmind/geoip2-node";

/** Cloud Storage 上の GeoLite2 City データベースの場所 */
export const GEOIP_OBJECT = "geoip/GeoLite2-City.mmdb";

const DOWNLOAD_URL =
  "https://download.maxmind.com/geoip/databases/GeoLite2-City/download";

/** MaxMind からダウンロードした GeoLite2 City */
export interface GeoLite2Download {
  /** 展開済みの mmdb ファイル */
  mmdb: Buffer;
  /** 配布アーカイブ（tar.gz）の SHA-256 */
  sha256: string;
  /** データベースの日付（例: 20261024） */
  databaseDate: string;
}

/**
 * MaxMind から GeoLite2 City の最新版をダウンロードし、
 * SHA-256 を照合してから mmdb を取り出す。
 * @param {string} accountId MaxMind のアカウント ID
 * @param {string} licenseKey MaxMind のライセンスキー
 * @return {Promise<GeoLite2Download>} 展開済みのデータベース
 */
export async function downloadGeoLite2(
  accountId: string,
  licenseKey: string,
): Promise<GeoLite2Download> {
  const auth = "Basic " +
    Buffer.from(`${accountId}:${licenseKey}`).toString("base64");
  const get = async (suffix: string): Promise<Response> => {
    // 本体は R2 にリダイレクトされる。別オリジンへのリダイレクトでは
    // fetch が Authorization ヘッダーを外すので、キーは MaxMind にしか送られない
    const res = await fetch(`${DOWNLOAD_URL}?suffix=${suffix}`, {
      headers: {Authorization: auth},
    });
    if (!res.ok) {
      throw new Error(`MaxMind download failed: ${suffix} ${res.status}`);
    }
    return res;
  };

  // 例: "<sha256>  GeoLite2-City_20261024.tar.gz"
  const checksumLine = (await (await get("tar.gz.sha256")).text()).trim();
  const [expected, fileName = ""] = checksumLine.split(/\s+/);
  const archive = Buffer.from(await (await get("tar.gz")).arrayBuffer());

  const sha256 = createHash("sha256").update(archive).digest("hex");
  if (sha256 !== expected) {
    throw new Error(`SHA-256 mismatch: expected ${expected}, got ${sha256}`);
  }

  const mmdb = extractMmdb(archive);
  // 壊れたファイルを Storage に置かないよう、開けることを確かめておく
  Reader.openBuffer(mmdb);

  return {
    mmdb,
    sha256,
    databaseDate: fileName.match(/_(\d{8})\./)?.[1] ?? "unknown",
  };
}

/**
 * tar.gz から最初の .mmdb ファイルを取り出す。
 * @param {Buffer} archive tar.gz の中身
 * @return {Buffer} mmdb ファイル
 */
export function extractMmdb(archive: Buffer): Buffer {
  const tar = gunzipSync(archive);
  // tar は 512 バイトのヘッダーとデータ（512 バイト単位に詰める）の繰り返し
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    const name = readString(header, 0, 100);
    if (!name) break; // 終端（ゼロ埋めのブロック）
    const prefix = readString(header, 345, 155);
    const size = parseInt(readString(header, 124, 12) || "0", 8);
    const dataStart = offset + 512;
    const path = prefix ? `${prefix}/${name}` : name;
    if (path.endsWith(".mmdb")) {
      return tar.subarray(dataStart, dataStart + size);
    }
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  throw new Error("No .mmdb file found in the archive");
}

/**
 * tar ヘッダーの NUL 終端の文字列フィールドを読む。
 * @param {Buffer} header ヘッダー
 * @param {number} start 開始位置
 * @param {number} length 長さ
 * @return {string} フィールドの値
 */
function readString(header: Buffer, start: number, length: number): string {
  const field = header.subarray(start, start + length);
  const end = field.indexOf(0);
  return field.subarray(0, end === -1 ? length : end).toString().trim();
}

/**
 * データベースを Storage に保存する。同じアーカイブがすでに保存されて
 * いれば何もしない。
 * @param {GeoLite2Download} db ダウンロードしたデータベース
 * @return {Promise<boolean>} 保存したら true、変化がなければ false
 */
export async function saveGeoLite2(db: GeoLite2Download): Promise<boolean> {
  const file = getStorage().bucket().file(GEOIP_OBJECT);
  const [exists] = await file.exists();
  if (exists) {
    const [metadata] = await file.getMetadata();
    if (metadata.metadata?.sha256 === db.sha256) {
      return false;
    }
  }
  await file.save(db.mmdb, {
    contentType: "application/octet-stream",
    metadata: {
      metadata: {sha256: db.sha256, databaseDate: db.databaseDate},
    },
  });
  return true;
}
