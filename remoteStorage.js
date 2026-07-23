// Render 등 배포 환경은 재배포는 물론, 무료/스타터 플랜의 유휴 재기동 때도 컨테이너를
// 이미지에서 새로 띄우기 때문에 로컬 디스크에만 쓰던 온디맨드 캐시(등기/건축물대장 조회
// 결과 등)가 통째로 사라집니다. 이 모듈은 그 캐시 파일들을 S3 호환 오브젝트 스토리지
// (Backblaze B2, Cloudflare R2, AWS S3, MinIO 등 아무거나)에 이중화해 재기동 이후에도
// 살아남게 합니다. 이 프로젝트가 지금까지 별도 패키지 없이 fetch/crypto 같은 Node 내장
// 기능만으로 API를 호출해온 방식을 그대로 따라, SigV4 서명도 직접 구현했습니다(AWS SDK
// 등 무거운 의존성을 추가하지 않기 위함).
//
// REMOTE_STORAGE_* 환경변수가 하나라도 비어 있으면 모든 함수가 조용히 아무 일도 하지
// 않습니다 - 로컬 개발 및 아직 저장소를 연결하지 않은 배포 환경에서는 기존과 동일하게
// 로컬 파일만 사용합니다.
import { createHash, createHmac } from "crypto";

const ENDPOINT = (process.env.REMOTE_STORAGE_ENDPOINT || "").replace(/\/+$/, "");
const BUCKET = process.env.REMOTE_STORAGE_BUCKET || "";
const REGION = process.env.REMOTE_STORAGE_REGION || "auto";
const ACCESS_KEY_ID = process.env.REMOTE_STORAGE_ACCESS_KEY_ID || "";
const SECRET_ACCESS_KEY = process.env.REMOTE_STORAGE_SECRET_ACCESS_KEY || "";

const EMPTY_PAYLOAD_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

export function isRemoteStorageConfigured() {
  return Boolean(ENDPOINT && BUCKET && ACCESS_KEY_ID && SECRET_ACCESS_KEY);
}

function hmac(key, data) {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

function sha256Hex(data) {
  return createHash("sha256").update(data).digest("hex");
}

// AWS SigV4로 서명된 단일 요청(GET/PUT, path-style)을 만듭니다. 멀티파트 업로드나
// 쿼리스트링 파라미터는 이 프로젝트의 용도(캐시 파일 하나를 통째로 GET/PUT)에 필요
// 없어 지원하지 않습니다.
function buildSignedRequest(method, key, payloadHash) {
  const url = new URL(`${ENDPOINT}/${BUCKET}/${key}`);
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);

  const canonicalHeaders = `host:${url.host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
  const canonicalRequest = [method, url.pathname, "", canonicalHeaders, signedHeaders, payloadHash].join("\n");

  const credentialScope = `${dateStamp}/${REGION}/s3/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, credentialScope, sha256Hex(canonicalRequest)].join("\n");

  const kDate = hmac(`AWS4${SECRET_ACCESS_KEY}`, dateStamp);
  const kRegion = hmac(kDate, REGION);
  const kService = hmac(kRegion, "s3");
  const kSigning = hmac(kService, "aws4_request");
  const signature = hmac(kSigning, stringToSign).toString("hex");

  return {
    url: url.toString(),
    headers: {
      host: url.host,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate,
      authorization: `AWS4-HMAC-SHA256 Credential=${ACCESS_KEY_ID}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`
    }
  };
}

// key에 해당하는 원격 객체를 내려받습니다. 미설정/미존재/실패 시 모두 null을 반환하고
// 호출부는 이를 "원격 사본 없음"으로 취급해 기존 로컬 파일을 그대로 씁니다.
export async function getRemoteObject(key) {
  if (!isRemoteStorageConfigured()) return null;
  try {
    const { url, headers } = buildSignedRequest("GET", key, EMPTY_PAYLOAD_SHA256);
    const res = await fetch(url, { method: "GET", headers });
    if (res.status === 404) return null;
    if (!res.ok) {
      console.warn(`[원격 저장소] ${key} 다운로드 실패: HTTP ${res.status}`);
      return null;
    }
    return Buffer.from(await res.arrayBuffer());
  } catch (err) {
    console.warn(`[원격 저장소] ${key} 다운로드 중 예외: ${err.message}`);
    return null;
  }
}

// body(문자열)를 key로 업로드합니다. 실패해도 로컬 파일 쓰기는 이미 끝난 뒤이므로
// 예외를 던지지 않고 경고만 남깁니다 - 원격 이중화 실패가 요청 처리를 막으면 안 됩니다.
export async function putRemoteObject(key, body) {
  if (!isRemoteStorageConfigured()) return;
  try {
    const payloadHash = sha256Hex(body);
    const { url, headers } = buildSignedRequest("PUT", key, payloadHash);
    const res = await fetch(url, { method: "PUT", headers, body });
    if (!res.ok) {
      console.warn(`[원격 저장소] ${key} 업로드 실패: HTTP ${res.status}`);
    }
  } catch (err) {
    console.warn(`[원격 저장소] ${key} 업로드 중 예외: ${err.message}`);
  }
}
