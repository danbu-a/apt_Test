import { writeFile, readFile } from "fs/promises";
import http from "http";
import path from "path";
import { fileURLToPath } from "url";
import { Worker } from "worker_threads";
import * as config from "./config.js";
import { MolitAptTradeClient, RebAptInfoClient, ROneStatsClient, BldRgstClient, LegalDongCodeClient } from "./apiClients.js";
import { ApartmentTurnoverProcessor } from "./processor.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const PORT_FALLBACK_ATTEMPTS = 10;
const PROXY_ALLOWED_HOSTS = new Set(["apis.data.go.kr"]);

// 서울 시군구코드 및 고양시 덕양구 -> 행정구역 명칭 매핑
const LAWD_CD_TO_GU = {
  "11110": "종로구", "11140": "중구", "11170": "용산구", "11200": "성동구",
  "11215": "광진구", "11230": "동대문구", "11260": "중랑구", "11290": "성북구",
  "11305": "강북구", "11320": "도봉구", "11350": "노원구", "11380": "은평구",
  "11410": "서대문구", "11440": "마포구", "11470": "양천구", "11500": "강서구",
  "11530": "구로구", "11545": "금천구", "11560": "영등포구", "11590": "동작구",
  "11620": "관악구", "11650": "서초구", "11680": "강남구", "11710": "송파구",
  "11740": "강동구",
  "41281": "고양시 덕양구"
};

// LAWD_CD_TO_GU의 역방향 매핑(구 이름 -> 시군구코드). 건축HUB API의 sigunguCd 파라미터는
// 국토교통부 실거래가 API의 lawd_cd와 동일한 5자리 코드를 씁니다.
const GU_TO_LAWD = Object.fromEntries(
  Object.entries(LAWD_CD_TO_GU).map(([lawdCd, guName]) => [guName, lawdCd])
);

// 전유공용면적(세대별 실제 전용면적) 온디맨드 조회용 캐시. 서버 기동 시 전체 단지를
// 일괄 조회하면 건축HUB API 일일 트래픽 한도(10,000건)를 금방 소진하고 기동도 느려지므로,
// 대시보드에서 사용자가 실제로 조회하는 단지에 한해 그때그때 호출하고 결과를 파일로
// 영구 캐싱합니다(재기동해도 이미 조회한 단지는 재호출하지 않음).
const BJDONG_CODE_CACHE_PATH = path.join(__dirname, "bjdong_code_cache.json");
const EXPOS_PUBUSE_AREA_CACHE_PATH = path.join(__dirname, "expos_pubuse_area_cache.json");
let bjdongCodeCache = {};
let exposPubuseAreaCache = {};

// 실거래가 신고기한(계약일로부터 30일)이 지나지 않은 최근 달은 최초 수집 시점 이후로도
// 계속 새 신고가 들어옵니다. runPipeline()의 정기 배치 재수집뿐 아니라, 대시보드에서
// 사용자가 실제로 단지를 조회하는 시점에도 이 개월수만큼은 라이브로 다시 확인합니다
// (아래 /api/live-trades 참고) - 배치 파이프라인을 기다리지 않고도 검색 즉시 최신
// 실거래가 반영되게 하기 위함입니다.
const REFRESH_RECENT_MONTHS = 3;

// 실거래가 원본 캐시(배치 파이프라인 runPipeline()이 쓰고 읽는 파일과 동일)를 서버가
// 서빙 중에도 온디맨드로 갱신할 수 있도록 모듈 전역에도 로드해둡니다. 두 코드 경로는
// 시점이 겹치지 않습니다 - main()이 runPipeline() 종료 후에만 startStaticServer()를
// 호출하므로, 서빙 중에는 배치 쪽이 이 파일을 건드리지 않습니다.
const MOLIT_RAW_CACHE_PATH = path.join(__dirname, "molit_trade_raw_cache.json");
let molitTradeRawCache = {};

// 자치구별 라이브 재조회 결과를 잠깐 캐싱합니다(TTL). 같은 구를 짧은 시간 안에 여러
// 사용자가 조회해도 매번 국토부 API를 두드리지 않기 위함입니다.
const LIVE_TRADES_TTL_MS = 5 * 60 * 1000;
const liveTradesCache = new Map(); // lawdCd -> { fetchedAt, months, trades }
const liveTradesInFlight = new Map(); // lawdCd -> Promise (동시 중복 조회 합류용)

// 특정 자치구의 최근 REFRESH_RECENT_MONTHS개월치 실거래를 라이브로 재조회합니다(캐시
// 우선, 진행 중인 동일 조회에는 합류). 결과는 molitTradeRawCache에도 반영해 다음 배치
// 파이프라인 실행 시 이 개선된 값이 그대로 재사용되게 합니다.
function fetchLiveRecentTrades(lawdCd) {
  const cached = liveTradesCache.get(lawdCd);
  if (cached && Date.now() - cached.fetchedAt < LIVE_TRADES_TTL_MS) return Promise.resolve(cached);

  const inFlight = liveTradesInFlight.get(lawdCd);
  if (inFlight) return inFlight;

  const promise = fetchLiveRecentTradesUncached(lawdCd)
    .finally(() => liveTradesInFlight.delete(lawdCd));
  liveTradesInFlight.set(lawdCd, promise);
  return promise;
}

async function fetchLiveRecentTradesUncached(lawdCd) {
  const tradeClient = new MolitAptTradeClient();
  const months = generateMonthlyRange("202001").slice(-REFRESH_RECENT_MONTHS);

  let trades = [];
  for (const dealYmd of months) {
    const monthTrades = await tradeClient.fetchTradeData(lawdCd, dealYmd);
    trades = trades.concat(monthTrades);
    molitTradeRawCache[`${lawdCd}_${dealYmd}`] = monthTrades;
  }
  await saveCache(molitTradeRawCache, MOLIT_RAW_CACHE_PATH);

  const result = { fetchedAt: Date.now(), months, trades };
  liveTradesCache.set(lawdCd, result);
  return result;
}

// 건축물대장 표제부(동/건물 단위 준공 레코드) 로컬 인덱스. runPipeline()에서 배치 처리용으로
// 만든 것을 그대로 재사용하기 위해 모듈 전역에 보관합니다 - fetchUnitTypesForAptKeyUncached가
// 온디맨드 세대수 조회 시 "이 지번에 등록된 건물별 세대수 총합"을 구해 K-apt 공식 총세대수와
// 교차검증하는 데 씁니다(한진해모로 104동/기타임대 116세대처럼 K-apt엔 없지만 표제부엔
// 있는 동을 정당하게 포함시키기 위함 - buildBldRgstIndex와 같은 키 형식을 씁니다).
let bldRgstTitleIndexGlobal = new Map();

// 서울 열린데이터광장 "서울시 공동주택 관리비 정보"(OA-15822) 월별 명세서를 미리 내려받아
// { [kaptCode]: { [yyyymm]: { [비용명]: 금액합 } } } 형태로 만들어둔 로컬 인덱스입니다.
// 국토교통부의 구버전 관리비 오픈API(AptIndvdlzManageCostServiceV2 등)는 2025-09-30
// "오픈API 대체서비스 안내(125종)"로 사실상 폐지되어(항상 resultCode 00 + null 응답)
// 서울시가 공식 대체로 안내한 이 소스를 씁니다. 인증키/세션 불필요.
const SEOUL_MAINTENANCE_COST_PATH = path.join(__dirname, "seoul_maintenance_cost.json");
let seoulMaintenanceCost = {};
const bldRgstClient = new BldRgstClient();
const legalDongCodeClient = new LegalDongCodeClient();

// apt_key(예: "서울특별시 강남구 개포동 660-4")를 시/구/동/지번으로 분해합니다.
function parseAptKeyToParts(aptKey) {
  // 지번 공유 단지 분리로 apt_key가 "...지번 · 단지명" 형태일 수 있어(같은 지번에
  // 완전히 다른 단지가 여럿 있는 경우 - runPipeline()의 sharedJibunDisambiguationMap
  // 참고), 물리주소 파싱 전에 그 접미사부터 잘라냅니다.
  const physicalPart = (aptKey || "").split(" · ")[0];
  const parts = physicalPart.trim().split(/\s+/);
  if (parts.length < 4) return null;
  const [city, guName, dong, ...jibunParts] = parts;
  return { city, guName, dong, jibun: jibunParts.join(" ") };
}

// 구 이름 + 동 이름으로 10자리 법정동코드(앞 5자리=시군구코드, 뒤 5자리=법정동코드)를
// 구합니다. 파일 캐시 -> 없으면 국토교통부_전국 법정동 API 조회 순으로 시도합니다.
async function resolveBjdongCd(guName, dong) {
  const cacheKey = `${guName}|${dong}`;
  if (bjdongCodeCache[cacheKey] !== undefined) {
    return bjdongCodeCache[cacheKey]; // null=조회했으나 없음(캐싱됨), 문자열=정상
  }

  const code = await legalDongCodeClient.fetchBjdongCode(guName, dong);
  if (code === undefined) return undefined; // 네트워크 오류: 캐싱하지 않고 다음 호출에 재시도

  bjdongCodeCache[cacheKey] = code; // null도 그대로 캐싱(같은 동을 매번 재조회하지 않기 위함)
  await saveCache(bjdongCodeCache, BJDONG_CODE_CACHE_PATH);
  return code;
}

// getBrExposPubuseAreaInfo 원본 아이템 배열을, 세대(호실) 단위로 묶어 전용면적별
// 세대수로 집계합니다. "전유"(전유공용구분) + "주"(주부속구분, 발코니/창고 등 부속면적
// 제외) 항목만 세대 1채의 실제 전용면적으로 인정하고, 동명칭+호명칭이 같은 행은
// 같은 세대이므로 면적을 합산합니다.
// 공용면적 중 "기타공용"(지하주차장/관리사무소/대피소 등 단지 부대시설)에 해당하는 용도.
// 공급면적 = 전용면적 + 주거공용면적(복도/계단/엘리베이터홀)이므로 이들은 제외합니다.
// 이걸 포함하면 공급면적이 아니라 계약면적이 됩니다.
const ETC_COMMON_AREA_PURPOSE = /대피소|주차|관리사무소|부대|기계실|전기실|휀실|경비|노인|어린이|주민공동|구분소유및분양불가/;

// 같은 지번의 전유부에는 아파트 세대뿐 아니라 단지 내 상가(근린생활시설/학원/의원/은행 등)도
// 함께 등재됩니다. 이들을 세대로 세면 세대수가 부풀려지고(래미안블레스티지 2000 vs 실제 1957)
// 그 값이 거래회전율의 분모와 관리비 세대당 환산에 그대로 흘러듭니다.
//
// 용도는 두 필드에 나뉘어 있고 어느 하나만으로는 판정할 수 없습니다.
//  - etcPurps(기타용도)만 보면: 1970년대 상가아파트(예: 충무로진양)는 이 값이 비어 있거나
//    "주택"이라 아파트를 거의 다 놓칩니다.
//  - mainPurpsCdNm(주용도)만 보면: 같은 단지에서 이 값이 "동" 전체의 주용도로 채워져 있어
//    아파트 동 안의 시장 점포/기계실까지 "아파트"로 잡힙니다.
// 그래서 "둘 중 하나라도 주거용으로 보이고, 둘 다 비주거 용도가 아닐 것"으로 판정합니다.
const RESIDENTIAL_PURPOSE = /아파트|공동주택|연립주택|다세대주택|주택/;
const NON_RESIDENTIAL_PURPOSE = /근린생활|구매시설|시장|점포|소매점|백화점|판매시설|상가|학원|교습소|독서실|의원|병원|의료시설|약국|은행|금융|음식점|제과점|골프|체육|목욕|세탁|미용|사무소|사무실|업무시설|오피스텔|고시원|숙박|공장|제조업소|출판사|기원|부동산중개|생활편익|창고|기계실|전기실|주차|관리사무소|경비|복도|계단|승강기|엘리베이터|에레베타|통로/;

// 전유부 한 행이 "실제 주거 세대"인지 판정합니다. 두 용도 필드 모두 비어 있는 행은
// (아주 오래된 대장에서 드물게 나타남) 판정 불가이므로 주거로 보지 않고, 이런 대장을
// 만나 세대수가 0이 되는 경우는 호출부에서 비필터 집계로 폴백합니다.
function isResidentialExclusiveItem(item) {
  const mainPurps = String(item.mainPurpsCdNm || "");
  const etcPurps = String(item.etcPurps || "");
  if (NON_RESIDENTIAL_PURPOSE.test(mainPurps) || NON_RESIDENTIAL_PURPOSE.test(etcPurps)) return false;
  return RESIDENTIAL_PURPOSE.test(mainPurps) || RESIDENTIAL_PURPOSE.test(etcPurps);
}

// residentialOnly=false는 용도 정보가 전혀 없는 대장을 위한 폴백 경로입니다(기존 동작).
function aggregateExposPubuseAreaItems(items, { residentialOnly = true } = {}) {
  // "동명_호명" -> { exclusive: 전유 합, housingCommon: 주거공용 합 }
  const unitByKey = new Map();

  for (const item of items) {
    const gbNm = String(item.exposPubuseGbCdNm || item.exposPubuseGbCd || "");
    const atchNm = String(item.mainAtchGbCdNm || item.mainAtchGbCd || "");
    const isExclusive = gbNm.includes("전유") || item.exposPubuseGbCd === "1";
    // mainAtchGbCd 코드값: "0"=주건축물, "1"=부속건축물 (실제 API 응답 기준으로 확인됨)
    const isMain = atchNm === "" || atchNm.includes("주") || item.mainAtchGbCd === "0";
    if (!isMain) continue;

    // 비주거 전유 행(상가 등)은 세대로 세지 않습니다. 이 행을 버려도 해당 호실의 공용 행은
    // 남지만, 전유면적이 0인 호실은 아래에서 제외되므로 상가 호실 자체가 통째로 빠집니다.
    if (isExclusive && residentialOnly && !isResidentialExclusiveItem(item)) continue;

    const area = parseFloat(item.area);
    if (!area || area <= 0) continue;

    const unitKey = `${item.dongNm || ""}_${item.hoNm || ""}`;
    const entry = unitByKey.get(unitKey) || { exclusive: 0, housingCommon: 0 };

    if (isExclusive) {
      entry.exclusive += area;
    } else if (!ETC_COMMON_AREA_PURPOSE.test(String(item.etcPurps || ""))) {
      entry.housingCommon += area;
    }
    unitByKey.set(unitKey, entry);
  }

  // 반올림된 전용면적 -> { 세대수, 공급면적 합 }. 같은 전용면적이라도 동/향에 따라
  // 주거공용이 미세하게 달라 공급면적은 평균을 냅니다.
  const byArea = new Map();
  for (const { exclusive, housingCommon } of unitByKey.values()) {
    if (exclusive <= 0) continue;
    const rounded = Math.round(exclusive * 100) / 100;
    const bucket = byArea.get(rounded) || { unitCount: 0, supplySum: 0 };
    bucket.unitCount += 1;
    bucket.supplySum += exclusive + housingCommon;
    byArea.set(rounded, bucket);
  }

  return Array.from(byArea.entries())
    .map(([exclusiveArea, { unitCount, supplySum }]) => ({
      exclusiveArea,
      unitCount,
      supplyArea: Math.round((supplySum / unitCount) * 100) / 100
    }))
    .sort((a, b) => a.exclusiveArea - b.exclusiveArea);
}

// 캐시 스키마 버전. 집계 결과의 필드가 늘어나거나(예: v2에서 supplyArea 추가) 집계 방식이
// 바뀌면(v3: 비주거 전유 행 제외, v4: registryBuildingTotal 표제부 교차검증용 총계 추가,
// v5~v6: 지번 공유 단지의 동번호 구간 필터링(dongFiltered) 추가, v7: dongNm이 "동"
// 접미사 없이 순수 숫자로 오는 실제 API 응답 형식에 맞춰 매칭 정규식 수정) 이 값을 올려
// 예전 스키마로 저장된 항목이 자동으로 재조회되게 합니다.
const EXPOS_CACHE_SCHEMA = 7;

// 진행 중인 전유공용면적 조회의 진척도: aptKey -> { loaded, total, phase }
// 올림픽파크포레온(등기 행 수만 건)처럼 조회가 수십 초 걸리는 단지를 위해, 대시보드가
// /api/unit-types-progress를 폴링해 진행률 바를 채웁니다. 조회가 끝나면 항목을 지웁니다.
const exposFetchProgress = new Map();

// 같은 aptKey에 대해 동시에 진행 중인 조회: aptKey -> Promise
// 브라우저 탭이 여럿이거나 새로고침이 겹치면 같은 단지를 중복 조회해, 서로의 진행률을
// 덮어써 진행률 바가 뒤로 돌아가고 API 호출 한도도 두 배로 씁니다. 먼저 시작된 조회의
// Promise를 공유해 한 번만 조회합니다.
const exposFetchInFlight = new Map();

// apt_key 하나에 대해 전유공용면적을 조회(캐시 우선)하고, 평형별 세대수로 집계해 반환합니다.
// 동시 중복 호출은 진행 중인 같은 조회에 합류시킵니다. targetUnitCount(K-apt/REB 공식
// 총세대수, 클라이언트가 rawData에서 계산해 전달)는 같은 지번을 여러 단지가 공유할 때
// 표제부 동번호 구간으로 이 단지 몫만 걸러내는 데 씁니다(아래 참고).
function fetchUnitTypesForAptKey(aptKey, targetUnitCount) {
  const cached = exposPubuseAreaCache[aptKey];
  if (cached && cached.schema === EXPOS_CACHE_SCHEMA) return Promise.resolve(cached);

  const inFlight = exposFetchInFlight.get(aptKey);
  if (inFlight) return inFlight;

  const promise = fetchUnitTypesForAptKeyUncached(aptKey, targetUnitCount)
    .finally(() => exposFetchInFlight.delete(aptKey));
  exposFetchInFlight.set(aptKey, promise);
  return promise;
}

// 영구 실패(주소를 해석/조회할 수 없음) 결과를 not_found와 동일하게 캐싱해, 클라이언트가
// 같은 단지를 열 때마다 등기 조회를 반복하지 않도록 합니다.
async function cacheAndReturn(aptKey, result) {
  const cached = { ...result, schema: EXPOS_CACHE_SCHEMA, fetchedAt: Date.now() };
  exposPubuseAreaCache[aptKey] = cached;
  await saveCache(exposPubuseAreaCache, EXPOS_PUBUSE_AREA_CACHE_PATH);
  return cached;
}

async function fetchUnitTypesForAptKeyUncached(aptKey, targetUnitCount) {
  const cached = exposPubuseAreaCache[aptKey];
  if (cached && cached.schema === EXPOS_CACHE_SCHEMA) return cached;

  // 아래 네 가지는 재시도해도 결과가 달라지지 않는 "영구" 실패입니다(주소 자체를 해석/
  // 조회할 수 없음 - 네트워크 오류가 아님). "error"로 반환하면 클라이언트가 매번 다시
  // 요청해 등기 조회를 계속 시도하게 되므로, "unresolvable"로 구분해 not_found와 함께
  // 캐싱하고 클라이언트도 더 이상 재요청하지 않게 합니다.
  const parts = parseAptKeyToParts(aptKey);
  if (!parts) {
    return cacheAndReturn(aptKey, { status: "unresolvable", message: "주소 형식을 해석할 수 없습니다." });
  }

  const sigunguCd = GU_TO_LAWD[parts.guName];
  if (!sigunguCd) {
    return cacheAndReturn(aptKey, { status: "unresolvable", message: `알 수 없는 자치구입니다: ${parts.guName}` });
  }

  const bjdong10 = await resolveBjdongCd(parts.guName, parts.dong);
  if (bjdong10 === undefined) return { status: "error", message: "법정동코드 조회 중 네트워크 오류가 발생했습니다." };
  if (bjdong10 === null) {
    return cacheAndReturn(aptKey, { status: "unresolvable", message: `법정동코드를 찾을 수 없습니다: ${parts.guName} ${parts.dong}` });
  }
  const bjdongCd = bjdong10.slice(5);

  const bunJi = parseJibunToBunJi(parts.jibun);
  if (!bunJi) {
    return cacheAndReturn(aptKey, { status: "unresolvable", message: `지번을 해석할 수 없습니다: ${parts.jibun}` });
  }

  // 진행률은 finally에서 반드시 정리합니다 - 남겨두면 다음 조회가 "이미 100%"로 보입니다.
  exposFetchProgress.set(aptKey, { loaded: 0, total: 0, phase: "fetching" });
  let items;
  try {
    items = await bldRgstClient.fetchExposPubuseArea(
      { sigunguCd, bjdongCd, ...bunJi },
      (loaded, total) => exposFetchProgress.set(aptKey, { loaded, total, phase: "fetching" })
    );
  } finally {
    exposFetchProgress.delete(aptKey);
  }

  if (items === undefined) {
    return { status: "error", message: "건축HUB API 조회 중 네트워크/한도 오류가 발생했습니다. 잠시 후 다시 시도해 주세요." };
  }

  // 초대형 단지 등으로 페이지 상한(MAX_PAGES) 안에 전체 건수를 다 받지 못한 경우입니다.
  // 세대수를 축소 집계한 결과를 "실측 완료"로 캐싱해버리면 영구적으로 잘못된 값이 굳어지므로,
  // 캐싱하지 않고 매번 재시도하도록 에러로 반환합니다.
  if (items.truncated) {
    console.warn(`[전유공용면적 조회] ${aptKey}: 데이터량이 너무 많아 페이지 상한 내에 전체 조회를 완료하지 못했습니다(부분 결과 폐기).`);
    return { status: "error", message: "이 단지는 등기 데이터량이 많아 전체 조회를 완료하지 못했습니다. 잠시 후 다시 시도해 주세요." };
  }

  // 이 지번에 등록된 건물(표제부 레코드)들의 세대수(hhldCnt) 합계 - K-apt가 놓친 동(예:
  // HOA 관리 대상이 아닌 기타임대동)을 포함한, 건축물대장 기준 "진짜" 단지 총세대수입니다.
  // 클라이언트(dashboard.js)가 등기상 세대수 그룹을 화면에 추가할지 판단할 때 K-apt
  // 공식 총세대수와 함께 두 번째 교차검증 기준으로 씁니다(더 큰 쪽을 신뢰).
  const titleKey = `${sigunguCd}|${normalizeString(parts.dong)}|${bunJi.bun}|${bunJi.ji}`;
  const titleRows = bldRgstTitleIndexGlobal.get(titleKey) || [];
  let registryBuildingTotal = titleRows.reduce((sum, row) => sum + (Number(row.hhldCnt) > 0 ? Number(row.hhldCnt) : 0), 0);

  // 전유공용면적 API는 지번 단위로만 조회되어, 같은 지번을 여러 단지가 공유하면(실사례:
  // 강남구 개포동 12 - 성원대치2단지/삼익대청/SH대치1단지) items 자체가 여러 단지의
  // 호실이 섞인 상태로 옵니다. targetUnitCount(이 단지의 K-apt/REB 공식 세대수)가 주어지고
  // 표제부에서 동번호가 연속된 구간이 그 세대수와 맞아떨어지면(findDongNumberWindow),
  // 그 구간에 속한 동의 호실(item.dongNm)만 남기고 나머지는 걸러내 이 단지분만 집계합니다.
  // 구간을 못 찾으면(단일 단지라 애초에 나눌 필요가 없거나, 동번호 패턴이 달라 판단 불가)
  // 필터링 없이 기존처럼 전체를 집계합니다 - 호출부(dashboard.js)가 dongFiltered 값으로
  // 이 단지분만의 데이터인지 여부를 판단해, 아니라면 등기 반영 자체를 건너뜁니다.
  let dongFiltered = false;
  let filteredItems = items;
  if (targetUnitCount > 0 && titleRows.length > 0) {
    const dongWindow = findDongNumberWindow(titleRows, targetUnitCount);
    if (dongWindow && dongWindow.dongNumbers.size < dongWindow.totalDongRecordsAtJibun) {
      // 표제부(buildingName)는 "219동"처럼 "동"이 붙지만, 전유공용면적 API의
      // dongNm은 "동" 접미사 없이 순수 숫자("219")로만 옵니다(실측 확인) - 둘 다
      // 매칭되게 접미사를 선택적으로 처리합니다.
      const inWindow = items.filter(item => {
        const m = String(item.dongNm || "").trim().match(/^(\d+)\s*동?$/);
        return m && dongWindow.dongNumbers.has(parseInt(m[1], 10));
      });
      if (inWindow.length > 0) {
        filteredItems = inWindow;
        registryBuildingTotal = dongWindow.matchedHhldSum;
        dongFiltered = true;
      }
    }
  }

  let areas = aggregateExposPubuseAreaItems(filteredItems);
  let totalUnits = areas.reduce((sum, a) => sum + a.unitCount, 0);

  // 용도 필드(주용도/기타용도)가 통째로 비어 있는 대장에서는 주거 판정이 전부 실패해
  // 세대수가 0이 됩니다. 이때는 필터 이전 동작으로 폴백해, 상가가 섞여 조금 부풀려질지언정
  // 단지 전체를 "정보 없음"으로 잃어버리지 않도록 합니다.
  if (totalUnits === 0) {
    const unfiltered = aggregateExposPubuseAreaItems(filteredItems, { residentialOnly: false });
    const unfilteredTotal = unfiltered.reduce((sum, a) => sum + a.unitCount, 0);
    if (unfilteredTotal > 0) {
      console.warn(`[전유공용면적 조회] ${aptKey}: 전유부에 용도 정보가 없어 주거 전용 필터를 적용하지 못했습니다(상가 포함 집계).`);
      areas = unfiltered;
      totalUnits = unfilteredTotal;
    }
  }

  if (dongFiltered) {
    console.log(`[전유공용면적 동번호 구간 필터링] ${aptKey}: 같은 지번을 공유하는 다른 단지와 분리해 이 단지 동(棟)의 호실만 집계했습니다(집계 세대수 ${totalUnits}, 대상 ${targetUnitCount}).`);
  }

  const result = totalUnits > 0
    ? { status: "ok", schema: EXPOS_CACHE_SCHEMA, areas, totalUnits, registryBuildingTotal, dongFiltered, fetchedAt: Date.now() }
    : { status: "not_found", schema: EXPOS_CACHE_SCHEMA, message: "건축물대장 전유부에서 이 주소의 공동주택 세대 정보를 찾지 못했습니다.", fetchedAt: Date.now() };

  exposPubuseAreaCache[aptKey] = result;
  await saveCache(exposPubuseAreaCache, EXPOS_PUBUSE_AREA_CACHE_PATH);
  return result;
}

// /api/unit-types 온디맨드 조회가 성공하면(사용자가 이 단지를 처음 열어본 시점),
// dashboard.js가 화면에만 반영하던 등기 실측 결과를 turnover_results.json에도 그대로
// 반영합니다 - 그래야 다음 방문자(혹은 새로고침)부터는 서버가 이미 실측된 값을
// 내려줍니다. 전체 단지를 미리 훑는 배치가 아니라, "사용자가 실제로 연 단지"만 그때그때
// 영구화하는 방식이라 추가 API 호출은 전혀 없습니다(위 /api/unit-types 응답을 그대로
// 재사용). 화면 표시 로직(dashboard.js)은 건드리지 않아 기존 온디맨드 기능 자체의
// 회귀 위험은 없습니다.
//
// turnover_results.json은 약 45MB라 JSON.parse/stringify에 CPU가 넉넉한 환경에서도
// 100ms 이상 걸립니다 - 이 작업을 메인 스레드(HTTP 요청 처리 스레드)에서 그대로 하면
// 그 시간 동안 다른 모든 요청(다른 사용자의 등기 조회 진행률 폴링 포함)이 멈춰버립니다.
// registryPersistWorker.js라는 별도 워커 스레드에 이 무거운 파일 작업을 전담시켜, 메인
// 스레드는 계속 다른 요청을 처리할 수 있게 합니다. 워커 안에서 읽기+쓰기 순서를
// 큐로 직렬화하므로(registryPersistWorker.js 참고) 여기서는 신경 쓸 필요가 없습니다.
let registryPersistWorker = null;

function getRegistryPersistWorker() {
  if (registryPersistWorker) return registryPersistWorker;

  registryPersistWorker = new Worker(path.join(__dirname, "registryPersistWorker.js"));
  registryPersistWorker.on("error", err => {
    console.error(`[등기 실측 영구반영 워커 오류] ${err.message}`);
  });
  registryPersistWorker.on("exit", code => {
    if (code !== 0) console.warn(`[등기 실측 영구반영 워커 종료] 비정상 종료 code=${code} - 다음 요청에서 재생성됩니다.`);
    registryPersistWorker = null;
  });
  return registryPersistWorker;
}

function persistRegistryMatchToResults(aptKey, result) {
  getRegistryPersistWorker().postMessage({ aptKey, result });
}

// 문자열 정규화 (공백 제거, 특수문자 제거, 접미사 제거, 소문자화)
function normalizeString(str) {
  if (!str) return "";
  return str
    .toString()
    .trim()
    .replace(/\s+/g, "")
    .replace(/아파트|마을|단지|구역|연립|맨션|빌라/g, "")
    .replace(/[\(\)\[\]\{\}\-\_\,\.\·\&\+]/g, "")
    .toLowerCase();
}

// 지번 정규화 (하이픈 전후 0 캐스팅 제거, 예: 0578-0005 -> 578-5)
function normalizeJibun(jibun) {
  if (!jibun) return "";
  const clean = jibun.toString().trim().replace(/\s+/g, "");
  if (!clean.includes("-")) {
    const num = parseInt(clean, 10);
    return isNaN(num) ? clean : num.toString();
  }
  const parts = clean.split("-");
  const main = parseInt(parts[0], 10) || 0;
  const sub = parseInt(parts[1], 10) || 0;
  return sub > 0 ? `${main}-${sub}` : `${main}`;
}

// Levenshtein distance (편집 거리) 계산
function levenshtein(a, b) {
  const matrix = [];
  for (let i = 0; i <= b.length; i++) matrix[i] = [i];
  for (let j = 0; j <= a.length; j++) matrix[0][j] = j;
  
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1, // 변경
          matrix[i][j - 1] + 1,     // 삽입
          matrix[i - 1][j] + 1      // 삭제
        );
      }
    }
  }
  return matrix[b.length][a.length];
}

// 이름 유사도 판별 (0.0 ~ 1.0)
function getSimilarity(a, b) {
  const normA = normalizeString(a);
  const normB = normalizeString(b);
  if (!normA || !normB) return normA === normB ? 1.0 : 0;
  if (normA === normB) return 1.0;

  // 접두어/부분문자열 포함 관계는 한국 아파트명에서 매우 강한 "동일 단지" 신호입니다.
  // REB/K-apt는 실거래가보다 훨씬 장황하게 표기하는 경우가 많습니다(예: 실거래가
  // "성원대치2단지아파트" vs REB "성원대치2단지일반분양(11개동)"). 순수 편집거리 비율만
  // 쓰면 짧은 이름이 우연히 다른 후보와 글자 수가 덜 다르다는 이유로 완전히 무관한
  // 단지가 선택될 수 있습니다(실사례로 확인됨: 같은 지번에 세 단지가 있는 "강남구
  // 개포동 12"에서 "성원대치2단지아파트"가 정답인 "성원대치2단지일반분양"보다 무관한
  // "SH대치1단지아파트"와 편집거리 기준 더 가깝게 나옴). 포함 관계일 땐 이 편향을 피해
  // 길이비만 반영한 높은 점수(0.85~1.0)를 줘서 항상 비포함 매칭을 이기게 합니다.
  if (normA.includes(normB) || normB.includes(normA)) {
    const shorter = Math.min(normA.length, normB.length);
    const longer = Math.max(normA.length, normB.length);
    return 0.85 + 0.15 * (shorter / longer);
  }

  const distance = levenshtein(normA, normB);
  const maxLength = Math.max(normA.length, normB.length);
  return 1.0 - distance / maxLength;
}

// 2020년 01월부터 현재 날짜 기준 최신 월까지 YYYYMM 문자열 리스트를 동적 생성
function generateMonthlyRange(startMonthStr = "202001") {
  const months = [];
  const startYear = parseInt(startMonthStr.substring(0, 4), 10);
  const startMonth = parseInt(startMonthStr.substring(4, 6), 10);

  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth() + 1;

  let year = startYear;
  let month = startMonth;

  while (year < currentYear || (year === currentYear && month <= currentMonth)) {
    const ymd = `${year}${String(month).padStart(2, "0")}`;
    months.push(ymd);
    
    month++;
    if (month > 12) {
      month = 1;
      year++;
    }
  }
  return months;
}

async function loadCache(filepath) {
  try {
    const data = await readFile(filepath, "utf-8");
    return JSON.parse(data);
  } catch (err) {
    return {};
  }
}

async function saveCache(cacheObj, filepath) {
  try {
    await writeFile(filepath, JSON.stringify(cacheObj, null, 2), "utf-8");
  } catch (err) {
    console.error(`[CACHE ERROR] 캐시 파일 ${filepath} 저장 실패: ${err.message}`);
  }
}

async function saveResultsToJson(results, filepath) {
  try {
    await writeFile(filepath, JSON.stringify(results, null, 2), "utf-8");
    console.log(`[SAVED] JSON 저장 성공: ${filepath}`);
  } catch (error) {
    console.error(`[ERROR] JSON 저장 실패: ${error.message}`);
  }
}

// K-apt(공동주택관리정보시스템) "단지 기본 정보" 파일을 로드합니다.
// AptListService3(getSigunguAptList3) 오픈API가 시군구코드와 무관하게 0건만
// 반환하는 문제가 있어(2026-07 확인, Swagger 콘솔로 직접 재현 - 국토부 측 데이터 이슈로
// 추정), 대신 K-apt 공식 홈페이지(https://www.k-apt.go.kr)에서 다운로드한 "단지 기본
// 정보" 엑셀을 kapt_basic_info.json으로 변환해 로컬 데이터로 사용합니다.
// 파일이 없으면 조용히 건너뛰고 기존처럼 REB 데이터만 사용합니다.
async function loadKaptBasicInfo(filepath) {
  try {
    const raw = await readFile(filepath, "utf-8");
    const records = JSON.parse(raw);
    console.log(`[K-apt Basic Info] kapt_basic_info.json 로드 완료: ${records.length}개 단지`);
    return Array.isArray(records) ? records : [];
  } catch (err) {
    console.warn("[K-apt Basic Info] kapt_basic_info.json이 없습니다. 단지 상세 제원(난방방식/복도유형/준공일자 등)은 채워지지 않습니다.");
    return [];
  }
}

// 시군구+동리 단위로 K-apt 레코드를 인덱싱해 매칭 후보를 빠르게 좁힙니다.
function buildKaptIndex(records) {
  const index = new Map();
  for (const rec of records) {
    if (!rec.sigungu || !rec.dongri) continue;
    const key = `${rec.sigungu}|${normalizeString(rec.dongri)}`;
    if (!index.has(key)) index.set(key, []);
    index.get(key).push(rec);
  }
  return index;
}

// 국토교통부_건축물대장 총괄표제부 파일 데이터(건축HUB 다운로드, CSV -> JSON 변환본)를 로드합니다.
// 건축HUB 오픈API(BldRgstHubService)가 일일 트래픽 한도(10,000건)로 대량 매칭에 부적합해,
// data.go.kr "파일데이터" 메뉴에서 구별로 다운로드한 총괄표제부 CSV를 하나로 합친
// bldrgst_recap_data.json을 대신 사용합니다(건폐율/용적률/세대수/사용승인일 포함).
async function loadBldRgstRecapData(filepath) {
  try {
    const raw = await readFile(filepath, "utf-8");
    const records = JSON.parse(raw);
    console.log(`[건축물대장 총괄표제부] bldrgst_recap_data.json 로드 완료: ${records.length}건`);
    return Array.isArray(records) ? records : [];
  } catch (err) {
    console.warn("[건축물대장 총괄표제부] bldrgst_recap_data.json이 없습니다. 건폐율/용적률은 채워지지 않습니다.");
    return [];
  }
}

// 국토교통부_건축물대장 표제부 파일 데이터(개별 건물 단위, CSV -> JSON 변환본)를 로드합니다.
// 총괄표제부는 2개 동 이상 단지에만 발급되는 문서라 나홀로/단일 동 건물은 커버되지
// 않습니다. 표제부는 건물 단위로 전수 발급되므로(주용도코드명='공동주택'만 필터링해
// 152,990건으로 축소), 총괄표제부 매칭이 실패한 단일 동 건물의 폴백 소스로 사용합니다.
async function loadBldRgstTitleData(filepath) {
  try {
    const raw = await readFile(filepath, "utf-8");
    const records = JSON.parse(raw);
    console.log(`[건축물대장 표제부] bldrgst_title_data.json 로드 완료: ${records.length}건 (공동주택 유형만)`);
    return Array.isArray(records) ? records : [];
  } catch (err) {
    console.warn("[건축물대장 표제부] bldrgst_title_data.json이 없습니다. 단일 동(나홀로) 건물의 건폐율/용적률/세대수는 채워지지 않습니다.");
    return [];
  }
}

// 총괄표제부가 같은 지번의 여러 단지를 하나로 합쳐 등록해(예: "대치,대청 아파트")
// bcRat/vlRat을 미기재로 남겨둔 경우, 표제부(개별 동) 후보들 중 동번호가 연속된
// 구간을 슬라이딩 윈도우로 탐색해 REB 공식 세대수와 합계가 가장 가까운 구간을
// 찾습니다. 한국 아파트 단지는 통상 같은 차수/단지를 연속된 동번호로 묶어
// 배정하므로(실사례: 성원대치2단지 209~219동 vs SH대치1단지 101~108동), 이 구간
// 매칭으로 해당 단지분 건폐율/용적률만 복원할 수 있습니다. 연속 구간이 대상
// 세대수와 오차범위 안에서 맞아떨어지지 않으면 null을 반환해 기존 "정보 없음"
// 상태를 그대로 둡니다(잘못된 값을 억지로 채우지 않음).
// 동번호가 연속된 구간을 슬라이딩 윈도우로 탐색해 대상 세대수와 합계가 가장
// 가까운 구간을 찾는 공용 로직입니다. findClosestDongWindow(건폐율/용적률 복원)와
// fetchUnitTypesForAptKeyUncached(전유공용면적 동별 필터링)가 함께 씁니다.
function findDongNumberWindow(titleRecords, targetUnitCount) {
  const withDong = titleRecords
    .map(r => {
      const m = String(r.buildingName || "").match(/(\d+)\s*동\s*$/);
      return m ? { ...r, dongNum: parseInt(m[1], 10) } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.dongNum - b.dongNum);
  if (withDong.length < 2) return null;

  const tolerance = Math.max(10, targetUnitCount * 0.05);
  let best = null;
  let bestDiff = Infinity;
  for (let i = 0; i < withDong.length; i++) {
    let sum = 0;
    for (let j = i; j < withDong.length; j++) {
      if (j > i && withDong[j].dongNum !== withDong[j - 1].dongNum + 1) break; // 연속 아니면 확장 중단
      sum += Number(withDong[j].hhldCnt) > 0 ? Number(withDong[j].hhldCnt) : 0;
      const diff = Math.abs(sum - targetUnitCount);
      if (diff < bestDiff) {
        bestDiff = diff;
        best = withDong.slice(i, j + 1);
      }
    }
  }
  if (!best || bestDiff > tolerance) return null;

  return {
    records: best,
    dongNumbers: new Set(best.map(r => r.dongNum)),
    totalDongRecordsAtJibun: withDong.length,
    matchedHhldSum: best.reduce((s, r) => s + (Number(r.hhldCnt) > 0 ? Number(r.hhldCnt) : 0), 0)
  };
}

// 총괄표제부가 같은 지번의 여러 단지를 하나로 합쳐 등록해(예: "대치,대청 아파트")
// bcRat/vlRat을 미기재로 남겨둔 경우, 표제부(개별 동) 후보들 중 동번호가 연속된
// 구간을 슬라이딩 윈도우로 탐색해 REB 공식 세대수와 합계가 가장 가까운 구간을
// 찾습니다. 한국 아파트 단지는 통상 같은 차수/단지를 연속된 동번호로 묶어
// 배정하므로(실사례: 성원대치2단지 209~219동 vs SH대치1단지 101~108동), 이 구간
// 매칭으로 해당 단지분 건폐율/용적률만 복원할 수 있습니다. 연속 구간이 대상
// 세대수와 오차범위 안에서 맞아떨어지지 않으면 null을 반환해 기존 "정보 없음"
// 상태를 그대로 둡니다(잘못된 값을 억지로 채우지 않음).
function findClosestDongWindow(titleRecords, targetUnitCount) {
  const window = findDongNumberWindow(titleRecords, targetUnitCount);
  if (!window) return null;
  const best = window.records;

  const withRatio = best.filter(r => (r.bcRat > 0 || r.vlRat > 0));
  if (withRatio.length === 0) return null;
  const hhldSum = withRatio.reduce((s, r) => s + (Number(r.hhldCnt) > 0 ? Number(r.hhldCnt) : 0), 0);
  const weighted = (field) => hhldSum > 0
    ? withRatio.reduce((s, r) => s + r[field] * (Number(r.hhldCnt) > 0 ? Number(r.hhldCnt) : 0), 0) / hhldSum
    : withRatio.reduce((s, r) => s + r[field], 0) / withRatio.length;

  return {
    bcRat: Math.round(weighted("bcRat") * 100) / 100,
    vlRat: Math.round(weighted("vlRat") * 100) / 100,
    floorCntMax: Math.max(...best.map(r => r.grndFlrCnt || 0)),
    totalParking: best.reduce((s, r) => s + (r.totPkngCnt || 0), 0),
    matchedDongCount: best.length,
    matchedHhldSum: window.matchedHhldSum
  };
}

// 시군구코드+법정동명+번+지 단위로 인덱싱해 지번 매칭을 O(1)로 처리합니다.
function buildBldRgstIndex(records) {
  const index = new Map();
  for (const rec of records) {
    if (!rec.sigunguCd || !rec.dong) continue;
    const key = `${rec.sigunguCd}|${normalizeString(rec.dong)}|${rec.bun}|${rec.ji}`;
    if (!index.has(key)) index.set(key, []);
    index.get(key).push(rec);
  }
  return index;
}

// 한국부동산원 청약홈 "APT 분양정보" + "APT 주택형별 분양정보" CSV(수작업 다운로드,
// subscription_data.json으로 결합 변환한 로컬 데이터)를 로드합니다. 단지별 주택형
// (전용면적+A/B/C 타입) 및 실제 공급세대수를 제공하며, 평형별 세대수 균등 안분을
// 실제 데이터로 대체하는 데 사용됩니다. 2020년 이후 청약(공모) 분양 단지만 포함되어
// 있어(청약홈 데이터 자체의 시간적 한계), 그 이전에 지어졌거나 조합원 분양 등으로
// 공급된 단지는 매칭되지 않고 기존 균등 안분 추정치를 유지합니다.
async function loadSubscriptionData(filepath) {
  try {
    const raw = await readFile(filepath, "utf-8");
    const records = JSON.parse(raw);
    console.log(`[청약홈 분양정보] subscription_data.json 로드 완료: ${records.length}건 (2020년 이후 서울 청약 공고)`);
    return Array.isArray(records) ? records : [];
  } catch (err) {
    console.warn("[청약홈 분양정보] subscription_data.json이 없습니다. 평형별 세대수는 균등 안분 추정치로만 채워집니다.");
    return [];
  }
}

// 지번 문자열을 건축물대장 API 파라미터(platGbCd/bun/ji)로 변환합니다.
// 예: "712-1" -> {platGbCd:"0", bun:"0712", ji:"0001"}, "902" -> {platGbCd:"0", bun:"0902", ji:"0000"}
// "산15-3" -> {platGbCd:"1", bun:"0015", ji:"0003"}
function parseJibunToBunJi(jibun) {
  if (!jibun) return null;
  let clean = jibun.toString().trim().replace(/\s+/g, "");
  const platGbCd = clean.startsWith("산") ? "1" : "0";
  clean = clean.replace(/^산/, "");

  const parts = clean.split("-");
  const main = parseInt(parts[0], 10);
  if (isNaN(main)) return null;
  const sub = parts.length > 1 ? (parseInt(parts[1], 10) || 0) : 0;

  return {
    platGbCd,
    bun: String(main).padStart(4, "0"),
    ji: String(sub).padStart(4, "0")
  };
}

// bjdAddr(법정동주소) 문자열에서 동리 다음에 오는 지번 토큰을 추출합니다.
// 예: "서울특별시 강남구 역삼동 712-1 강남센트럴아이파크" + dongri="역삼동" -> "712-1"
function extractJibunFromBjdAddr(bjdAddr, dongri) {
  if (!bjdAddr || !dongri) return "";
  let idx = bjdAddr.indexOf(dongri);
  let matchLen = dongri.length;

  // 청약홈 공급위치는 법정동("개포동") 대신 행정동("개포1동")을 쓰는 경우가 많아 위
  // 완전 일치가 실패할 수 있습니다(예: 디에이치퍼스티어아이파크 - 법정동 "개포동" vs
  // 청약 공고 "개포1동", "1"이 중간에 끼어 있어 부분 문자열로 포함되지 않음). 동 어근
  // (끝 "동" 제외)에 숫자 접미사가 붙은 행정동 표기까지 허용해 재시도합니다.
  if (idx === -1 && dongri.endsWith("동")) {
    const root = dongri.slice(0, -1).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const m = bjdAddr.match(new RegExp(`${root}\\d*동`));
    if (m) {
      idx = m.index;
      matchLen = m[0].length;
    }
  }

  if (idx === -1) return "";
  const rest = bjdAddr.slice(idx + matchLen).trim();
  return (rest.split(/\s+/)[0] || "").replace(/번지$/, "");
}

// 청약홈 레코드의 types 배열(주택형별 공급세대수)을, 동일 반올림 전용면적끼리
// 합산한 { "전용면적(2자리)": {unitCount, typeLabel} } 맵으로 변환합니다.
function buildSubscriptionAreaMap(types) {
  const areaMap = {};
  for (const t of types) {
    const areaKey = t.area.toFixed(2);
    if (!areaMap[areaKey]) {
      areaMap[areaKey] = { unitCount: 0, typeLabels: new Set() };
    }
    areaMap[areaKey].unitCount += t.unitCount;
    if (t.typeLabel) areaMap[areaKey].typeLabels.add(t.typeLabel);
  }

  const resolvedMap = {};
  for (const [areaKey, v] of Object.entries(areaMap)) {
    resolvedMap[areaKey] = {
      unitCount: v.unitCount,
      typeLabel: [...v.typeLabels].sort().join("·")
    };
  }
  return resolvedMap;
}

// 청약홈 공고 주소("서울특별시 서초구 반포동 1109번지 일대")를 apt_key 형식의
// {city, guName, dong, jibun}으로 분해합니다. 실거래가 하나도 없어 uniqueAptKeys에
// 아직 없는(사용승인 전 신축 등) 단지를 청약홈 데이터만으로 시딩할 때 사용합니다.
function parseSubscriptionAddressToParts(address) {
  if (!address) return null;
  const tokens = address.trim().split(/\s+/);
  if (tokens.length < 2) return null;
  const city = tokens[0];
  const guName = tokens[1];

  // 도로명주소 뒤에 "(법정동 지번)"이 괄호로 붙는 경우가 있음
  // (예: "서울특별시 강서구 공항대로 42길 11(내발산동 649-3)").
  // 이 경우 괄호 안쪽에 동/지번이 온전히 들어있으므로 우선 그것을 사용합니다.
  const parenMatch = address.match(/\(([^()]*)\)/);
  if (parenMatch) {
    const innerTokens = parenMatch[1].trim().split(/\s+/);
    if (innerTokens.length >= 2 && /^[가-힣][가-힣0-9]*동$/.test(innerTokens[0]) && /^\d/.test(innerTokens[1])) {
      const jibun = innerTokens[1].replace(/번지$/, "");
      return { city, guName, dong: innerTokens[0], jibun: normalizeJibun(jibun) };
    }
  }

  // 지번주소 형식: "시 구 동 지번번지 ...". 동 이름은 반드시 한글로 시작해야 함 -
  // 그렇지 않으면 도로명 번호가 우연히 "동"으로 끝나는 토큰(예: 위 예시의 "11(내발산동")을
  // 동으로 잘못 인식하는 문제가 생깁니다.
  const dongIdx = tokens.findIndex((t, i) => i >= 2 && /^[가-힣][가-힣0-9]*동$/.test(t));
  if (dongIdx === -1) return null;

  const dong = tokens[dongIdx];
  const jibunToken = (tokens[dongIdx + 1] || "").replace(/번지$/, "");
  if (!/^\d/.test(jibunToken)) return null;

  return { city, guName, dong, jibun: normalizeJibun(jibunToken) };
}

async function saveResultsToCsv(results, filepath) {
  if (results.length === 0) return;
  try {
    const headers = Object.keys(results[0]).filter(k => typeof results[0][k] !== "object");
    const csvRows = [headers.join(",")];
    for (const row of results) {
      const values = headers.map(header => {
        const val = row[header];
        if (typeof val === "string" && val.includes(",")) {
          return `"${val.replace(/"/g, '""')}"`;
        }
        return val !== null && val !== undefined ? val : "";
      });
      csvRows.push(values.join(","));
    }
    const csvContent = "\ufeff" + csvRows.join("\n");
    await writeFile(filepath, csvContent, "utf-8");
    console.log(`[SAVED] CSV 저장 성공: ${filepath}`);
  } catch (error) {
    console.error(`[ERROR] CSV 저장 실패: ${error.message}`);
  }
}

function withCorsHeaders(headers = {}) {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    ...headers
  };
}

function sendJson(res, statusCode, body) {
  res.writeHead(statusCode, withCorsHeaders({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-cache, no-store, must-revalidate"
  }));
  res.end(JSON.stringify(body));
}

function getPreferredPort() {
  const envPort = Number.parseInt(process.env.PORT || "", 10);
  return Number.isInteger(envPort) && envPort > 0 ? envPort : config.PORT;
}

function getRequestOrigin(req, actualPort) {
  const host = req.headers.host || `localhost:${actualPort}`;
  // Render 등 PaaS는 HTTPS를 프록시에서 종료하고 내부적으로는 평문 HTTP로 넘기므로,
  // req 자체만 보면 항상 http로 보입니다. 프록시가 표준으로 붙여주는 X-Forwarded-Proto로
  // 실제 브라우저가 접속한 프로토콜을 판단합니다(없으면 로컬 개발 환경이므로 http).
  const forwardedProto = req.headers["x-forwarded-proto"];
  const protocol = forwardedProto ? forwardedProto.split(",")[0].trim() : "http";
  return `${protocol}://${host}`;
}

async function proxyPublicApi(targetUrl, res) {
  let parsedUrl;
  try {
    parsedUrl = new URL(targetUrl);
  } catch (err) {
    sendJson(res, 400, { error: "Invalid proxy URL" });
    return;
  }

  if (!["http:", "https:"].includes(parsedUrl.protocol)) {
    sendJson(res, 400, { error: "Unsupported proxy protocol" });
    return;
  }

  if (!PROXY_ALLOWED_HOSTS.has(parsedUrl.hostname)) {
    sendJson(res, 403, { error: "Proxy host is not allowed" });
    return;
  }

  // 서버 측에서 서비스키를 주입합니다. 클라이언트(dashboard.js)는 더 이상 실키를
  // URL에 담아 보내지 않으므로, 브라우저 소스에 키가 노출되지 않습니다.
  if (!parsedUrl.searchParams.has("serviceKey")) {
    parsedUrl.searchParams.set("serviceKey", config.MOLIT_API_KEY);
  }

  try {
    const upstream = await fetch(parsedUrl.toString(), {
      headers: {
        "Accept": "application/json, text/plain, */*"
      }
    });
    const body = Buffer.from(await upstream.arrayBuffer());
    res.writeHead(upstream.status, withCorsHeaders({
      "Content-Type": upstream.headers.get("content-type") || "application/octet-stream",
      "Cache-Control": "no-cache, no-store, must-revalidate"
    }));
    res.end(body);
  } catch (err) {
    console.error(`[PROXY ERROR] ${parsedUrl.toString()} 요청 실패: ${err.message}`);
    sendJson(res, 502, { error: "Proxy request failed", detail: err.message });
  }
}

function createStaticServer(actualPort, preferredPort) {
  const MIME_TYPES = {
    ".html": "text/html",
    ".css": "text/css",
    ".js": "application/javascript",
    ".json": "application/json"
  };

  const server = http.createServer(async (req, res) => {
    const requestUrl = new URL(req.url, getRequestOrigin(req, actualPort));

    if (req.method === "OPTIONS") {
      res.writeHead(204, withCorsHeaders());
      res.end();
      return;
    }

    if (requestUrl.pathname === "/api/config") {
      sendJson(res, 200, {
        port: actualPort,
        preferredPort,
        origin: getRequestOrigin(req, actualPort)
      });
      return;
    }

    if (requestUrl.pathname === "/api/health") {
      sendJson(res, 200, {
        status: "ok",
        port: actualPort
      });
      return;
    }

    if (requestUrl.pathname === "/api/proxy") {
      await proxyPublicApi(requestUrl.searchParams.get("url"), res);
      return;
    }

    // 평형별 정확한 세대수를 건축물대장 전유부(등기 원본)에서 온디맨드로 조회합니다.
    // 서버 기동 시 전체 단지를 조회하지 않고, 사용자가 대시보드에서 실제로 열어본
    // 단지에 한해 그때그때 호출 -> 파일 캐싱합니다.
    if (requestUrl.pathname === "/api/unit-types") {
      const aptKey = requestUrl.searchParams.get("aptKey");
      if (!aptKey) {
        sendJson(res, 400, { status: "error", message: "aptKey 파라미터가 필요합니다." });
        return;
      }
      const officialTotal = parseInt(requestUrl.searchParams.get("officialTotal"), 10) || 0;
      try {
        const result = await fetchUnitTypesForAptKey(aptKey, officialTotal);
        sendJson(res, 200, result);
        // 응답은 먼저 보내고, turnover_results.json 반영은 워커 스레드에 맡겨 백그라운드로
        // 진행합니다(사용자 화면 응답 속도에 영향 주지 않기 위함). 실패해도 온디맨드 조회
        // 자체(위 응답)는 이미 성공했으므로 사용자에게 별도 에러가 노출되지 않습니다 -
        // 다음에 이 단지를 다시 열면 재시도됩니다(실패 로그는 워커가 직접 남깁니다).
        if (result && result.status === "ok") {
          persistRegistryMatchToResults(aptKey, result);
        }
      } catch (err) {
        console.error(`[전유공용면적 조회 ERROR] ${aptKey}: ${err.message}`);
        sendJson(res, 500, { status: "error", message: "서버 내부 오류" });
      }
      return;
    }

    // 진행 중인 전유공용면적 조회의 진척도. 대시보드가 조회하는 동안 짧은 주기로 폴링해
    // 진행률 바를 채웁니다. 해당 aptKey 조회가 진행 중이 아니면 status: "idle"입니다.
    if (requestUrl.pathname === "/api/unit-types-progress") {
      const aptKey = requestUrl.searchParams.get("aptKey");
      if (!aptKey) {
        sendJson(res, 400, { status: "error", message: "aptKey 파라미터가 필요합니다." });
        return;
      }
      const progress = exposFetchProgress.get(aptKey);
      if (!progress) {
        sendJson(res, 200, { status: "idle" });
        return;
      }
      sendJson(res, 200, { status: "fetching", loaded: progress.loaded, total: progress.total });
      return;
    }

    // 서울시 공동주택 관리비(OA-15822 기반 로컬 인덱스) 조회 - 국토부 구버전 관리비
    // API가 사실상 폐지되어 이 소스로 대체했습니다(서울 소재 단지만 커버, K-apt 단지코드 필요).
    if (requestUrl.pathname === "/api/seoul-maintenance") {
      const kaptCode = requestUrl.searchParams.get("kaptCode");
      const month = requestUrl.searchParams.get("month"); // YYYYMM
      if (!kaptCode || !month) {
        sendJson(res, 400, { status: "error", message: "kaptCode, month 파라미터가 필요합니다." });
        return;
      }
      const monthData = seoulMaintenanceCost[kaptCode]?.[month];
      if (!monthData) {
        sendJson(res, 200, { status: "not_found" });
        return;
      }
      sendJson(res, 200, { status: "ok", costs: monthData });
      return;
    }

    // 서울시 공동주택 관리비 - 특정 단지가 공시한 전체 월(YYYYMM) 목록.
    // 프론트에서 "조회 가능한 가장 최신 월"을 API 호출 없이 즉시 알아내는 데 씁니다.
    if (requestUrl.pathname === "/api/seoul-maintenance-months") {
      const kaptCode = requestUrl.searchParams.get("kaptCode");
      if (!kaptCode) {
        sendJson(res, 400, { status: "error", message: "kaptCode 파라미터가 필요합니다." });
        return;
      }
      const months = seoulMaintenanceCost[kaptCode] ? Object.keys(seoulMaintenanceCost[kaptCode]).sort() : [];
      sendJson(res, 200, { status: "ok", months });
      return;
    }

    // 사용자가 대시보드에서 특정 구를 조회할 때마다 그 구의 최근 몇 개월치 실거래를
    // 국토부 API에서 라이브로 재조회합니다. 정기 배치 파이프라인(runPipeline)이 다시
    // 돌 때까지 기다리지 않아도, 검색 시점 기준으로 최신 실거래가 화면에 반영됩니다.
    if (requestUrl.pathname === "/api/live-trades") {
      const guName = requestUrl.searchParams.get("guName");
      const lawdCd = GU_TO_LAWD[guName];
      if (!lawdCd) {
        sendJson(res, 400, { status: "error", message: "알 수 없는 구입니다." });
        return;
      }
      try {
        const result = await fetchLiveRecentTrades(lawdCd);
        sendJson(res, 200, { status: "ok", months: result.months, trades: result.trades, fetchedAt: result.fetchedAt });
      } catch (err) {
        console.error(`[실시간 실거래 조회 ERROR] ${guName}: ${err.message}`);
        sendJson(res, 500, { status: "error", message: "서버 내부 오류" });
      }
      return;
    }

    let reqPath = decodeURIComponent(requestUrl.pathname);
    if (reqPath === "/") reqPath = "/index.html";

    const filePath = path.resolve(__dirname, `.${reqPath}`);
    const relativePath = path.relative(__dirname, filePath);
    if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
      res.writeHead(403, withCorsHeaders({ "Content-Type": "text/plain; charset=utf-8" }));
      res.end("403 Forbidden");
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || "text/plain";

    try {
      const data = await readFile(filePath);
      res.writeHead(200, withCorsHeaders({
        "Content-Type": contentType,
        "Cache-Control": "no-cache, no-store, must-revalidate",
        "Pragma": "no-cache",
        "Expires": "0"
      }));
      res.end(data);
    } catch (err) {
      res.writeHead(404, withCorsHeaders({ "Content-Type": "text/plain; charset=utf-8" }));
      res.end("404 Not Found: 파일을 찾을 수 없습니다.");
    }
  });

  return server;
}

function listenOnPort(port, preferredPort) {
  const server = createStaticServer(port, preferredPort);

  return new Promise((resolve, reject) => {
    const onError = (err) => {
      server.off("listening", onListening);
      reject(err);
    };
    const onListening = () => {
      server.off("error", onError);
      server.on("error", (err) => {
        console.error(`[SERVER ERROR] 웹서버 런타임 에러: ${err.message}`);
      });
      resolve({ server, port });
    };

    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port);
  });
}

async function startStaticServer() {
  bjdongCodeCache = await loadCache(BJDONG_CODE_CACHE_PATH);
  exposPubuseAreaCache = await loadCache(EXPOS_PUBUSE_AREA_CACHE_PATH);
  console.log(`[전유공용면적 온디맨드 캐시] 법정동코드 캐시 ${Object.keys(bjdongCodeCache).length}건, 세대면적 캐시 ${Object.keys(exposPubuseAreaCache).length}건 로드 완료`);

  seoulMaintenanceCost = await loadCache(SEOUL_MAINTENANCE_COST_PATH);
  console.log(`[서울시 공동주택 관리비] seoul_maintenance_cost.json 로드 완료: ${Object.keys(seoulMaintenanceCost).length}개 단지`);

  molitTradeRawCache = await loadCache(MOLIT_RAW_CACHE_PATH);
  console.log(`[실거래가 온디맨드 재조회] 원본 캐시 ${Object.keys(molitTradeRawCache).length}건 로드 완료`);

  const preferredPort = getPreferredPort();

  for (let i = 0; i < PORT_FALLBACK_ATTEMPTS; i++) {
    const port = preferredPort + i;
    try {
      const result = await listenOnPort(port, preferredPort);

      console.log("\n" + "=".repeat(80));
      console.log(`[Webview Server] 웹뷰 대시보드가 정상 기동되었습니다.`);
      console.log(`[Webview Server] Listening on port ${port}`);
      console.log(`브라우저 또는 앱 웹뷰에서 아래 주소로 접속해 확인하세요:`);
      console.log(`   http://localhost:${port}`);
      console.log(`   http://127.0.0.1:${port}`);
      console.log("\n[NCP Map Whitelist Registration]");
      console.log("NCP 콘솔의 'Web 서비스 URL' 항목에 아래 오리진 URL들을 정확히 등록하셔야 지도가 정상 렌더링됩니다:");
      console.log(`   http://localhost:${port}`);
      console.log(`   http://127.0.0.1:${port}`);
      console.log("=".repeat(80) + "\n");

      return result;
    } catch (err) {
      if (err.code === "EADDRINUSE") {
        const nextPort = port + 1;
        console.warn(`[WARN] ${port}번 포트가 이미 사용 중입니다. ${nextPort}번 포트로 재시도합니다.`);
        continue;
      }

      throw err;
    }
  }

  throw new Error(`${preferredPort}번부터 ${preferredPort + PORT_FALLBACK_ATTEMPTS - 1}번까지 사용 가능한 포트를 찾지 못했습니다.`);
}

async function runPipeline() {
  console.log("=== 아파트 대량 수집 및 통계 계산 파이프라인 가동 (정밀 지번/유사도 교차 검증 버전) ===");

  const rawCachePath = path.join(__dirname, "molit_trade_raw_cache.json");
  const rebCachePath = path.join(__dirname, "reb_apt_cache.json");
  
  const molitTradeCache = await loadCache(rawCachePath);
  const rebAptCache = await loadCache(rebCachePath);
  
  console.log(`[Cache Info] 로드된 실거래 원천 API 캐시 수: ${Object.keys(molitTradeCache).length}개`);
  console.log(`[Cache Info] 로드된 부동산원 단지 세대수 캐시 수: ${Object.keys(rebAptCache).length}개`);

  const tradeClient = new MolitAptTradeClient();
  const rebClient = new RebAptInfoClient();
  const processor = new ApartmentTurnoverProcessor();

  let allTrades = [];
  const dealYmdList = generateMonthlyRange("202001");
  console.log(`[수집 기간 설정] 시작: 202001 -> 종료: ${dealYmdList[dealYmdList.length - 1]} (총 ${dealYmdList.length}개월)`);

  // 1. 서울 25개 자치구 수집 (덕양구는 취소 및 기존 서울 지역 범위 유지)
  const targetLawdCds = config.DEFAULT_LAWD_CD_LIST.filter(cd => cd.startsWith("11"));

  // 최근 REFRESH_RECENT_MONTHS개월(모듈 상단 정의 - /api/live-trades 온디맨드 재조회와
  // 공유하는 값)은 캐시가 있어도 매번 다시 조회해 갱신하고, 그보다 오래된(신고가 사실상
  // 마감된) 달만 캐시를 신뢰합니다.
  const recentYmdSet = new Set(dealYmdList.slice(-REFRESH_RECENT_MONTHS));

  for (const lawdCd of targetLawdCds) {
    for (const dealYmd of dealYmdList) {
      const cacheKey = `${lawdCd}_${dealYmd}`;
      const cached = molitTradeCache[cacheKey];
      const needsRefresh = recentYmdSet.has(dealYmd);

      if (cached && Array.isArray(cached) && !needsRefresh) {
        allTrades = allTrades.concat(cached);
      } else {
        console.log(`[실거래 API 호출] 지역코드: ${lawdCd}, 계약월: ${dealYmd}${needsRefresh ? " (최근 개월 - 재조회)" : ""}`);
        const trades = await tradeClient.fetchTradeData(lawdCd, dealYmd);
        console.log(`-> 수집 건수: ${trades.length}건`);

        allTrades = allTrades.concat(trades);
        molitTradeCache[cacheKey] = trades;

        await saveCache(molitTradeCache, rawCachePath);
        await sleep(800);
      }
    }
  }

  if (allTrades.length === 0) {
    console.error("[Fatal] 수집된 실거래 데이터가 존재하지 않습니다. 수집을 종료합니다.");
    throw new Error("수집된 실거래 데이터가 존재하지 않습니다.");
  }

  console.log(`총 실거래 수집 건수: ${allTrades.length}건`);

  // 1-1. 지번 공유 단지 분리 감지.
  //
  // 문제(실사례): 서울특별시 강남구 개포동 12번지 하나에 삼익대청아파트(822세대)와
  // 성원대치2단지(1753세대)라는 완전히 다른 두 단지가 같이 있습니다(REB 조회로 확인 -
  // 심지어 SH대치1단지아파트까지 세 번째로 걸리지만 이쪽은 매매 실거래 자체가 없어
  // 아래 로직에서 자연히 걸러집니다). 주소(구+동+지번)만으로 단지를 식별하면 이런
  // 경우 나중에 처리된 거래의 단지명으로 덮어써져 한쪽 단지가 검색에서 아예 사라지고,
  // 그 단지의 실거래가 다른 단지의 회전율에 섞여 들어갑니다.
  //
  // 감지 방법: 같은 (구,동,지번)에서 실거래가 apt_name이 서로 이름이 많이 다르면(유사도
  // 낮음) 같은 건물의 표기 차이가 아니라 진짜 다른 단지로 보고, 주소 뒤에 단지명을
  // 붙여 키를 분리합니다. 표기가 비슷하면(예: "래미안퍼스티지" vs "래미안퍼스티지(101동)")
  // 원래대로 하나의 키로 유지해 불필요한 분리를 막습니다.
  const SAME_COMPLEX_NAME_SIMILARITY = 0.5;
  const sharedJibunDisambiguationMap = new Map(); // "baseAddress||원본apt_name" -> 분리된 최종 addressKey
  {
    const namesByBaseAddress = new Map();
    for (const t of allTrades) {
      const guName = LAWD_CD_TO_GU[t.lawd_cd] || "";
      if (!guName || !t.dong || !t.jibun || !t.apt_name) continue;
      const city = t.lawd_cd.startsWith("11") ? "서울특별시" : "경기도";
      const baseAddress = `${city} ${guName} ${t.dong} ${t.jibun}`.trim();
      if (!namesByBaseAddress.has(baseAddress)) namesByBaseAddress.set(baseAddress, new Map());
      const stats = namesByBaseAddress.get(baseAddress);
      const dealVal = t.deal_year * 100 + t.deal_month;
      const entry = stats.get(t.apt_name) || { count: 0, minDate: Infinity, maxDate: -Infinity };
      entry.count += 1;
      entry.minDate = Math.min(entry.minDate, dealVal);
      entry.maxDate = Math.max(entry.maxDate, dealVal);
      stats.set(t.apt_name, entry);
    }

    for (const [baseAddress, nameStats] of namesByBaseAddress.entries()) {
      const names = [...nameStats.keys()];
      if (names.length < 2) continue; // 이름이 하나뿐이면 분리할 것이 없음

      // 이름 유사도(포함 관계 우선 - getSimilarity 참고)로 그룹핑
      const clusters = [];
      for (const name of names) {
        const target = clusters.find(c => getSimilarity(name, c.representative) >= SAME_COMPLEX_NAME_SIMILARITY);
        if (target) target.members.add(name);
        else clusters.push({ representative: name, members: new Set([name]) });
      }
      if (clusters.length < 2) continue; // 전부 표기 차이일 뿐, 실제로는 한 단지

      // 클러스터별 실거래 시기 범위(재건축 신호 판단용)
      for (const cluster of clusters) {
        let minDate = Infinity, maxDate = -Infinity;
        for (const member of cluster.members) {
          minDate = Math.min(minDate, nameStats.get(member).minDate);
          maxDate = Math.max(maxDate, nameStats.get(member).maxDate);
        }
        cluster.minDate = minDate;
        cluster.maxDate = maxDate;
      }

      // 신호 1(재건축): 클러스터들의 거래 시기가 서로 겹치지 않으면(예: 신반포8 202006~202110,
      // 메이플자이 202510~202606) 옛 건물이 철거되고 새 건물이 들어선 경우로 봅니다. 이때는
      // REB가 이미 철거된 옛 단지를 더 이상 들고 있지 않은 게 정상이라(교차검증 자체가
      // 불가능) REB 확인 없이도 분리를 확정합니다.
      const sortedByDate = [...clusters].sort((a, b) => a.minDate - b.minDate);
      const isSequential = sortedByDate.every((c, i) => i === 0 || c.minDate > sortedByDate[i - 1].maxDate);

      let distinctRebComplexes = null;
      if (!isSequential) {
        // 신호 2(REB 교차검증): 시기가 겹치면(예: 미성/미륭/삼호3 전부 2020~2026 계속 활발)
        // 재건축이 아니라 표기 차이일 수 있습니다 - 실사례로 노원구 월계동 13은 미성·미륭·삼호
        // 3개 건설사가 나눠 지었지만 K-apt엔 "월계시영고층" 하나(3,930세대)로 등록돼 있었습니다.
        // REB API에 물어봐서 실제로 서로 다른 COMPLEX_PK가 2개 이상 잡히는 경우에만 분리를
        // 확정하고, 하나뿐이면(공식적으로 한 단지) 분리를 취소합니다.
        const rebCandidates = await rebClient.fetchAptInfoByAddress(baseAddress);
        const targetJibunForCheck = normalizeJibun(baseAddress.split(/\s+/).pop() || "");
        distinctRebComplexes = new Set(
          rebCandidates
            .filter(item => normalizeJibun(String(item.ADRES || "").split(/\s+/).pop() || "") === targetJibunForCheck)
            .map(item => item.COMPLEX_PK)
        );
        if (distinctRebComplexes.size < 2) {
          console.log(`[지번 공유 단지 분리 보류] "${baseAddress}" - 실거래 표기는 갈리지만(${names.join(", ")}) 거래 시기가 겹치고 REB에도 단지가 ${distinctRebComplexes.size}개뿐이라(같은 단지의 구역/시공사별 애칭으로 판단) 분리하지 않습니다.`);
          continue;
        }
      }

      const reason = isSequential ? "재건축(거래 시기 비중첩)" : `REB 교차검증(단지 ${distinctRebComplexes.size}개 확인)`;
      for (const cluster of clusters) {
        let canonicalName = null;
        let canonicalCount = -1;
        for (const member of cluster.members) {
          const c = nameStats.get(member).count;
          if (c > canonicalCount) { canonicalCount = c; canonicalName = member; }
        }
        const disambiguatedKey = `${baseAddress} · ${canonicalName}`;
        for (const member of cluster.members) {
          sharedJibunDisambiguationMap.set(`${baseAddress}||${member}`, disambiguatedKey);
        }
        const totalCount = [...cluster.members].reduce((s, m) => s + nameStats.get(m).count, 0);
        console.log(`[지번 공유 단지 분리] "${baseAddress}" -> "${disambiguatedKey}" (표기: ${[...cluster.members].join(", ")} / 거래 ${totalCount}건 / 기간 ${cluster.minDate}~${cluster.maxDate} / 근거: ${reason})`);
      }
    }
  }

  // 2. 실거래 단지 고유 주소 리스트 추출 (지번 크로스 매칭용 키 구조)
  const uniqueAptKeys = new Map(); // address -> { aptName, dong, jibun, lawdCd, physicalAddress }
  for (const t of allTrades) {
    const guName = LAWD_CD_TO_GU[t.lawd_cd] || "";
    if (!guName || !t.dong || !t.jibun || !t.apt_name) continue;

    const city = t.lawd_cd.startsWith("11") ? "서울특별시" : "경기도";
    const physicalAddress = `${city} ${guName} ${t.dong} ${t.jibun}`.trim();
    const address = sharedJibunDisambiguationMap.get(`${physicalAddress}||${t.apt_name}`) || physicalAddress;
    uniqueAptKeys.set(address, {
      aptName: t.apt_name,
      dong: t.dong,
      jibun: t.jibun,
      lawdCd: t.lawd_cd,
      // REB 등 외부 API 조회는 항상 이 "진짜 물리주소"를 씁니다(단지명 접미사가 붙은
      // address로 조회하면 그 주소 자체가 존재하지 않아 매칭 실패합니다).
      physicalAddress
    });
  }

  console.log(`식별된 고유 단지 주소 수: ${uniqueAptKeys.size}개`);

  const rebAptDataByApt = {};

  // 3. 부동산원 API 조회 및 정밀 매칭 (지번 일치 교차 검증 + 이름 유사도 fallback)
  for (const [address, info] of uniqueAptKeys.entries()) {
    let cacheItem = rebAptCache[address];
    
    // 캐시에 기존 데이터가 있더라도 상세 필드가 누락되어 있으면 재수집.
    // useaprDt(준공일자) 필드는 나중에 추가됐는데, 그 이전에 캐싱된 항목들은
    // (kaptCode/heatType/corridorType/floorCntMax 등 REB API에 존재하지도 않는 필드로
    // 구성된 구버전 스키마 그대로) useaprDt 없이 영구 재사용되고 있었습니다 - 이 조건으로
    // 그런 구버전 캐시를 무효화해 재수집합니다. 단, 교차검증 불일치로 확정된 항목
    // (unitCount === 0)은 애초에 useaprDt를 채울 매칭 데이터 자체가 없는 게 정상이므로
    // 이 조건에서 제외하지 않으면 매번 똑같이 재조회만 반복하게 됩니다.
    const isCacheValid = cacheItem
      && cacheItem.unitCount !== undefined
      && cacheItem.adres !== undefined
      && (cacheItem.unitCount === 0 || cacheItem.useaprDt !== undefined);
    
    if (!isCacheValid) {
      // 지번 공유 단지 분리로 address가 "...12 · 성원대치2단지아파트"처럼 단지명 접미사가
      // 붙어있을 수 있어, 실제 API 조회는 반드시 물리주소(info.physicalAddress)로 합니다.
      console.log(`[REB API] 주소 조회 중: ${info.physicalAddress} (${info.aptName})`);
      const aptDataList = await rebClient.fetchAptInfoByAddress(info.physicalAddress);
      
      const targetJibun = normalizeJibun(info.jibun);
      const targetDongNorm = normalizeString(info.dong);

      // 교차 검증 및 정규화 매칭
      const matchedComplexes = aptDataList.filter(item => {
        // A. 주소 법정동 및 지번 파트 정밀 대조
        const adresParts = String(item.ADRES || "").split(/\s+/).filter(Boolean);
        const lastPart = adresParts[adresParts.length - 1] || "";
        const parsedJibunFromAdres = normalizeJibun(lastPart);
        
        const isDongMatched = normalizeString(item.ADRES).includes(targetDongNorm);
        const isJibunMatched = parsedJibunFromAdres === targetJibun;
        
        if (isDongMatched && isJibunMatched) {
          return true;
        }

        // B. 주소 매칭 실패 시 이름 유사도 비교 (Levenshtein Distance)
        const normComplexName1 = normalizeString(item.COMPLEX_NM1);
        const normComplexName2 = normalizeString(item.COMPLEX_NM2);
        const normComplexName3 = normalizeString(item.COMPLEX_NM3);
        const normAptName = normalizeString(info.aptName);

        const sim1 = getSimilarity(normAptName, normComplexName1);
        const sim2 = getSimilarity(normAptName, normComplexName2);
        const sim3 = getSimilarity(normAptName, normComplexName3);
        const maxSim = Math.max(sim1, sim2, sim3);

        if (maxSim >= 0.6) {
          return true;
        }

        return false;
      });

      let targetItem = null;
      if (matchedComplexes.length > 0) {
        // 매칭 정확도 순으로 정렬 (지번 우선 매칭 -> 유사도 역순)
        matchedComplexes.sort((a, b) => {
          const lastA = String(a.ADRES || "").split(/\s+/).pop() || "";
          const lastB = String(b.ADRES || "").split(/\s+/).pop() || "";
          const aJibunMatch = normalizeJibun(lastA) === targetJibun;
          const bJibunMatch = normalizeJibun(lastB) === targetJibun;
          
          if (aJibunMatch && !bJibunMatch) return -1;
          if (!aJibunMatch && bJibunMatch) return 1;

          const aSim = Math.max(
            getSimilarity(info.aptName, a.COMPLEX_NM1),
            getSimilarity(info.aptName, a.COMPLEX_NM2),
            getSimilarity(info.aptName, a.COMPLEX_NM3)
          );
          const bSim = Math.max(
            getSimilarity(info.aptName, b.COMPLEX_NM1),
            getSimilarity(info.aptName, b.COMPLEX_NM2),
            getSimilarity(info.aptName, b.COMPLEX_NM3)
          );
          return bSim - aSim;
        });
        targetItem = matchedComplexes[0];
      }

      if (targetItem) {
        const uCount = parseInt(targetItem.UNIT_CNT, 10) || 0;
        // 주의: 한국부동산원 단지식별정보(AptIdInfoSvc/getAptInfo) API는
        // ADRES, COMPLEX_NM1~3, COMPLEX_PK, DONG_CNT, UNIT_CNT, USEAPR_DT 필드만 제공합니다.
        // KAPT_CODE/HEAT_TYPE/CORRIDOR_TYPE/FLOOR_CNT_MAX/COMPET_DE는 이 API 응답에
        // 존재하지 않는 필드였습니다(과거 코드가 잘못 가정). 이 값들은 국토부 K-apt
        // 단지 기본정보 API(AptBasisInfoServiceV4)에서 kaptCode 매칭 후 조회해야 하며,
        // 해당 로직은 dashboard.js의 loadMolitData()에서 별도로 처리합니다.
        cacheItem = {
          complexName: info.aptName,
          unitCount: uCount,
          adres: targetItem.ADRES || "",
          useaprDt: targetItem.USEAPR_DT || "",
          dongCnt: parseInt(targetItem.DONG_CNT, 10) || 0
        };
        console.log(`-> 매핑 성공: '${info.aptName}' -> 총 ${uCount} 세대 (지번 매칭 성공)`);
      } else {
        cacheItem = { complexName: info.aptName, unitCount: 0, adres: "" };
        console.warn(`-> [SKIP MISMATCH] '${info.aptName}' 단지 교차 검증 및 유사도 매칭 불일치로 스킵`);
      }

      rebAptCache[address] = cacheItem;
      await saveCache(rebAptCache, rebCachePath);
      await sleep(300);
    }

    if (cacheItem && cacheItem.unitCount > 0) {
      // 이름이 아니라 주소로 저장합니다 - 서로 다른 실제 건물이 같은 이름을 쓰는
      // 경우(예: "삼성"이 서울에만 22곳)가 있어, 이름을 키로 쓰면 나중에 처리된
      // 주소의 데이터가 먼저 것을 덮어써 버립니다. address는 이미 uniqueAptKeys
      // 생성 시 구+동+지번으로 유일하게 구성된 키입니다.
      rebAptDataByApt[address] = cacheItem; // 전체 제원 오브젝트 매핑
    }
  }

  await saveCache(rebAptCache, rebCachePath);
  console.log("[Cache Updated] 부동산원 단지 정밀 제원 캐시 저장이 완료되었습니다.");

  // 3-1단계: K-apt 단지 기본정보 파일 매칭 (kaptCode/난방방식/복도유형/준공일자/시공사/주차대수)
  const kaptBasicInfoPath = path.join(__dirname, "kapt_basic_info.json");
  const kaptMatchCachePath = path.join(__dirname, "kapt_match_cache.json");
  const kaptBasicRecords = await loadKaptBasicInfo(kaptBasicInfoPath);
  const kaptIndex = buildKaptIndex(kaptBasicRecords);
  const kaptMatchCache = await loadCache(kaptMatchCachePath);
  const kaptDataByApt = {};

  if (kaptBasicRecords.length > 0) {
    for (const [address, info] of uniqueAptKeys.entries()) {
      let matched = kaptMatchCache[address];

      if (matched === undefined) {
        const guName = LAWD_CD_TO_GU[info.lawdCd] || "";
        const dongKey = `${guName}|${normalizeString(info.dong)}`;
        const candidates = kaptIndex.get(dongKey) || [];
        const targetJibun = normalizeJibun(info.jibun);

        let bestItem = null;
        let bestIsJibunMatch = false;
        let bestSim = 0;

        for (const cand of candidates) {
          const candJibun = normalizeJibun(extractJibunFromBjdAddr(cand.bjdAddr, cand.dongri));
          const isJibunMatch = candJibun !== "" && candJibun === targetJibun;
          const sim = getSimilarity(info.aptName, cand.complexName);

          if (isJibunMatch && !bestIsJibunMatch) {
            bestItem = cand;
            bestIsJibunMatch = true;
            bestSim = sim;
          } else if (isJibunMatch === bestIsJibunMatch && sim > bestSim) {
            bestItem = cand;
            bestSim = sim;
          }
        }

        // 지번 불일치 시의 이름 유사도 단독 채택(예전 기준 0.6)을 완전히 제거했습니다.
        // K-apt 후보군은 REB(주소 기반 실시간 조회라 후보가 이미 그 지번 근처로 좁혀짐)와
        // 달리 "같은 동 전체"를 후보로 삼기 때문에, 짧은 한국어 단지명은 편집거리 1글자
        // 차이(예: "청량리신주" vs "청량리미주", 유사도 0.8)만으로도 완전히 다른 동네의
        // 무관한 단지가 통째로 매칭돼버립니다(실사례로 확인됨: 지번이 30번지 이상 떨어진
        // 별개 건물의 난방방식/시공사/세대수가 잘못 채워짐). 지번이 안 맞으면 아예
        // "매칭 안 됨"으로 두는 편이 틀린 데이터를 보여주는 것보다 안전합니다.
        if (!bestIsJibunMatch) {
          bestItem = null;
        }

        matched = bestItem
          ? {
              kaptCode: bestItem.kaptCode || "",
              heatType: bestItem.heatType || "",
              corridorType: bestItem.corridorType || "",
              builder: bestItem.builder || "",
              dongCnt: parseInt(bestItem.dongCnt, 10) || 0,
              topFloor: parseInt(bestItem.topFloor || bestItem.topFloorReg, 10) || 0,
              useDate: bestItem.useDate || "",
              totalParking: parseInt(bestItem.totalParking, 10) || 0,
              officeTel: bestItem.officeTel || "",
              unitCnt: parseInt(bestItem.unitCnt, 10) || 0,
              // REB(부동산원) 단지식별정보 API가 실패해 adres가 비어 있는 단지의
              // 주소 폴백 소스로 사용합니다(processor.js 참고).
              roadAddr: bestItem.roadAddr || "",
              bjdAddr: bestItem.bjdAddr || ""
            }
          : null;

        kaptMatchCache[address] = matched;
      }

      if (matched) {
        kaptDataByApt[address] = matched;
      }
    }

    await saveCache(kaptMatchCache, kaptMatchCachePath);
    console.log(`[K-apt 매칭] 고유주소 ${uniqueAptKeys.size}개 중 ${Object.keys(kaptDataByApt).length}개 단지 매칭 완료`);
  }

  // 3-1-1단계: 지번 경계에 걸친 동일 단지 중복 주소 병합.
  //
  // 실사례(한진해모로): 성동구 하왕십리동 1050(101동, 건축물대장/K-apt 등록 주소)과
  // 중구 신당동 845(102~104동, 건축물대장 등록이 아예 없는 "유령 주소")가 REB/국토부
  // 실거래가 양쪽에서 별개 지번으로 취급되어, 같은 물리적 단지가 apt_key 두 개로
  // 쪼개져 있었습니다(거래 55건이 신당동 845 쪽에 갇혀 회전율 계산에서 누락).
  //
  // 감지 규칙: 부동산원(REB)이 매긴 단지명(complexName)과 준공일자(useaprDt, 일 단위까지
  // 정확히 일치)가 같은 주소가 둘 이상이면 "같은 단지가 여러 지번에 걸쳐 있다"는 강한
  // 신호로 봅니다(우연히 이름+준공일이 완전히 같은 별개 단지일 확률은 매우 낮음).
  // 그중 정확히 한쪽만 K-apt에 등록돼 있으면 그 주소를 "대표 주소"로 삼아 나머지를
  // 병합합니다 - 양쪽 다 있거나 양쪽 다 없으면 어느 쪽이 진짜 관리사무소 주소인지
  // 판단할 근거가 없으므로 병합하지 않고 그대로 둡니다(틀린 병합보다 병합 안 하는 쪽이
  // 안전).
  const duplicateAddressMergeMap = {};
  {
    const groupsByNameAndDate = new Map();
    for (const [address, reb] of Object.entries(rebAptDataByApt)) {
      const name = (reb?.complexName || "").trim();
      const useaprDt = reb?.useaprDt || "";
      if (!name || !useaprDt || !(reb.unitCount > 0)) continue;
      const key = `${name}|${useaprDt}`;
      if (!groupsByNameAndDate.has(key)) groupsByNameAndDate.set(key, []);
      groupsByNameAndDate.get(key).push(address);
    }

    for (const [key, addresses] of groupsByNameAndDate.entries()) {
      if (addresses.length < 2) continue;
      const withKapt = addresses.filter(a => kaptDataByApt[a]);
      if (withKapt.length !== 1) {
        console.log(`[중복단지 검토] "${key}" - 주소 ${addresses.length}개가 이름/준공일 일치하지만 K-apt 매칭이 ${withKapt.length}개라 자동 병합 보류: ${addresses.join(" / ")}`);
        continue;
      }
      const primary = withKapt[0];
      for (const secondary of addresses) {
        if (secondary === primary) continue;
        duplicateAddressMergeMap[secondary] = primary;
        console.log(`[중복단지 병합] ${secondary} -> ${primary} ("${key.split("|")[0]}", 준공 ${key.split("|")[1]})`);
      }
    }
  }

  // 3-2단계: 건축물대장 총괄표제부 파일 데이터(로컬 CSV -> JSON) 매칭 - 건폐율(bcRat)/용적률(vlRat)
  // 건축HUB 오픈API는 일일 트래픽 한도(10,000건) 때문에 대량 매칭에 부적합해,
  // data.go.kr에서 구별로 받은 총괄표제부 파일을 로컬 인덱스로 매칭합니다(API 호출 없음, 한도 없음).
  const bldRgstRecapPath = path.join(__dirname, "bldrgst_recap_data.json");
  const bldRgstRecords = await loadBldRgstRecapData(bldRgstRecapPath);
  const bldRgstIndex = buildBldRgstIndex(bldRgstRecords);

  // 총괄표제부(2개 동 이상 단지 전용)만으로는 나홀로/단일 동 건물이 커버되지 않아,
  // 표제부(건물 단위 전수, 공동주택 유형만 필터링)를 총괄표제부 매칭 실패 시의
  // 폴백 소스로 함께 로드합니다.
  const bldRgstTitlePath = path.join(__dirname, "bldrgst_title_data.json");
  const bldRgstTitleRecords = await loadBldRgstTitleData(bldRgstTitlePath);
  const bldRgstTitleIndex = buildBldRgstIndex(bldRgstTitleRecords);
  // 온디맨드 세대수 조회(fetchUnitTypesForAptKeyUncached)가 쓸 수 있도록 모듈 전역에도 보관합니다.
  bldRgstTitleIndexGlobal = bldRgstTitleIndex;

  const bldRgstDataByApt = {};
  // 건폐율/용적률이 0(또는 미기재)인 옛 단지라도 세대수(hhldCnt)는 남아있는 경우가 많아,
  // 3-3단계(세대수 교차 보완)에서 REB 매칭 실패 단지의 폴백 소스로 재사용합니다.
  const bldRgstHhldCntByApt = {};
  const bldRgstUseAprDayByApt = {};

  if (bldRgstRecords.length > 0 || bldRgstTitleRecords.length > 0) {
    let bldRgstMatchedCount = 0;
    let bldRgstFromTitleCount = 0;
    let bldRgstDongWindowFallbackCount = 0;

    for (const [address, info] of uniqueAptKeys.entries()) {
      const bunJi = parseJibunToBunJi(info.jibun);
      if (!bunJi) continue;

      const key = `${info.lawdCd}|${normalizeString(info.dong)}|${bunJi.bun}|${bunJi.ji}`;
      let candidates = bldRgstIndex.get(key) || [];
      let fromTitle = false;
      if (candidates.length === 0) {
        candidates = bldRgstTitleIndex.get(key) || [];
        fromTitle = candidates.length > 0;
      }

      let bestItem = null;
      if (candidates.length === 1) {
        bestItem = candidates[0];
      } else if (candidates.length > 1) {
        // 동일 지번에 총괄표제부가 여러 건인 경우(예: 행당한진타운 346 vs 346-1),
        // 부동산원에서 확인된 세대수(unitCount)와 가장 근접한 레코드를 채택합니다.
        const rebInfo = rebAptDataByApt[address];
        const targetUnitCount = rebInfo ? rebInfo.unitCount : 0;

        if (targetUnitCount > 0) {
          candidates.sort((a, b) =>
            Math.abs(a.hhldCnt - targetUnitCount) - Math.abs(b.hhldCnt - targetUnitCount)
          );
          bestItem = candidates[0];
        } else {
          // 세대수 비교 기준이 없으면 이름 유사도가 가장 높은 레코드를 채택합니다.
          candidates.sort((a, b) =>
            getSimilarity(info.aptName, b.buildingName) - getSimilarity(info.aptName, a.buildingName)
          );
          bestItem = candidates[0];
        }
      }

      if (bestItem) {
        // 표제부 폴백(fromTitle)은 동별로 레코드가 나뉘어 있어(예: 101동~104동) bestItem
        // 하나만 보면 그 동의 값만 반영됩니다 - 최고층수는 전체 동 중 최댓값을, 총주차대수는
        // 전체 동 합계를 써야 단지 전체를 대표합니다. 총괄표제부(!fromTitle)는 이미 단지
        // 전체 기준 단일 레코드라 bestItem 값을 그대로 씁니다.
        const floorCntMax = fromTitle
          ? Math.max(...candidates.map(c => c.grndFlrCnt || 0))
          : (bestItem.grndFlrCnt || 0);
        const totalParking = fromTitle
          ? candidates.reduce((sum, c) => sum + (c.totPkngCnt || 0), 0)
          : (bestItem.totPkngCnt || 0);

        let finalBcRat = bestItem.bcRat || 0;
        let finalVlRat = bestItem.vlRat || 0;
        let finalFloorCntMax = floorCntMax;
        let finalTotalParking = totalParking;
        let usedDongWindowFallback = false;

        // 채택된 레코드가 건폐율/용적률 둘 다 미기재(0)면, 같은 지번의 표제부(개별 동)
        // 후보들에서 REB 공식 세대수와 합이 맞는 연속 동번호 구간을 찾아 대체합니다
        // (findClosestDongWindow 주석 참고 - 총괄표제부가 여러 단지를 하나로 합쳐
        // 등록해둔 경우의 실사례: 성원대치2단지).
        if (finalBcRat === 0 && finalVlRat === 0) {
          const rebInfoForFallback = rebAptDataByApt[address];
          const targetForFallback = rebInfoForFallback ? rebInfoForFallback.unitCount : 0;
          const titleCandidatesForFallback = fromTitle ? candidates : (bldRgstTitleIndex.get(key) || []);
          if (targetForFallback > 0 && titleCandidatesForFallback.length > 1) {
            const windowMatch = findClosestDongWindow(titleCandidatesForFallback, targetForFallback);
            if (windowMatch) {
              finalBcRat = windowMatch.bcRat;
              finalVlRat = windowMatch.vlRat;
              finalFloorCntMax = windowMatch.floorCntMax || finalFloorCntMax;
              finalTotalParking = windowMatch.totalParking || finalTotalParking;
              usedDongWindowFallback = true;
            }
          }
        }

        // bcRat/vlRat이 0(옛 단지 등 미기재)이어도 platPlc(대지위치)는 REB 매칭 실패
        // 단지의 소재지 주소 폴백으로 유용하므로, 건폐율/용적률 유무와 무관하게 저장합니다.
        bldRgstDataByApt[address] = {
          bcRat: finalBcRat,
          vlRat: finalVlRat,
          platPlc: bestItem.platPlc || "",
          // K-apt 미등록 단지(의무관리대상이 아닌 소규모 단지 등)의 최고층수/총주차대수
          // 폴백 소스입니다 - K-apt에는 있는데 건축HUB에는 없는 난방방식/복도유형/시공사/
          // 연락처와 달리, 이 두 필드는 건축물대장 자체에 존재하는 정보라 여기서 보완 가능합니다.
          floorCntMax: finalFloorCntMax,
          totalParking: finalTotalParking
        };
        if (finalBcRat > 0 || finalVlRat > 0) {
          bldRgstMatchedCount++;
          if (fromTitle) bldRgstFromTitleCount++;
          if (usedDongWindowFallback) bldRgstDongWindowFallbackCount++;
        }
        if (bestItem.hhldCnt > 0) {
          bldRgstHhldCntByApt[address] = bestItem.hhldCnt;
        }
        if (bestItem.useAprDay) {
          bldRgstUseAprDayByApt[address] = bestItem.useAprDay;
        }
      }
    }

    console.log(`[건축물대장 매칭] 고유주소 ${uniqueAptKeys.size}개 중 ${bldRgstMatchedCount}개 단지 건폐율/용적률 확인 완료 (총괄표제부: ${bldRgstMatchedCount - bldRgstFromTitleCount}개, 표제부 폴백: ${bldRgstFromTitleCount}개, 그 중 지번 공유 단지 동번호 구간 매칭: ${bldRgstDongWindowFallbackCount}개)`);
  }

  // 3-3단계: REB 단지식별정보 매칭 실패 단지의 세대수 교차 보완
  // 국토부 실거래가의 단지명은 자유 텍스트라 세대수 정보가 없고, 회전율 계산에는
  // 반드시 총 세대수가 필요합니다. REB(부동산원) 매칭이 실패한 단지에 한해 이미
  // 지번/유사도 기준으로 별도 검증된 K-apt -> 건축물대장 총괄표제부 순으로 세대수를
  // 교차 확인해 rebAptDataByApt를 보완합니다(둘 다 REB와 동일한 지번/유사도 매칭
  // 로직을 거쳤으므로 신뢰도가 유지됩니다).
  let unitBackfillCount = 0;
  let unitBackfillFromKapt = 0;
  let unitBackfillFromBldRgst = 0;

  for (const [address, info] of uniqueAptKeys.entries()) {
    if (rebAptDataByApt[address]) continue; // 이미 REB로 세대수 확보됨

    const kaptInfo = kaptDataByApt[address];
    const kaptUnitCnt = kaptInfo ? kaptInfo.unitCnt : 0;
    const bldRgstHhldCnt = bldRgstHhldCntByApt[address] || 0;

    let fallbackUnitCount = 0;
    let source = "";

    if (kaptUnitCnt > 0) {
      fallbackUnitCount = kaptUnitCnt;
      source = "K-apt";
      unitBackfillFromKapt++;
    } else if (bldRgstHhldCnt > 0) {
      fallbackUnitCount = bldRgstHhldCnt;
      source = "건축물대장";
      unitBackfillFromBldRgst++;
    }

    if (fallbackUnitCount > 0) {
      rebAptDataByApt[address] = {
        complexName: info.aptName,
        unitCount: fallbackUnitCount,
        adres: "",
        useaprDt: (kaptInfo && kaptInfo.useDate) || bldRgstUseAprDayByApt[address] || "",
        dongCnt: (kaptInfo && kaptInfo.dongCnt) || 0,
        unitCountSource: source
      };
      unitBackfillCount++;
    }
  }

  console.log(`[세대수 교차 보완] REB 매칭 실패 단지 중 ${unitBackfillCount}개 세대수 보완 완료 (K-apt: ${unitBackfillFromKapt}개, 건축물대장: ${unitBackfillFromBldRgst}개)`);

  // 3-4단계: 청약홈 주택형별 분양정보 매칭 - 평형별 실제 세대수 + A/B/C 타입 라벨
  // 균등 안분(총세대수/평형종류수) 대신, 청약 당시 실제 공급세대수를 평형(전용면적)
  // 단위로 정확히 매칭합니다. 지번/이름 유사도 교차검증은 K-apt 매칭과 동일한 기준을
  // 사용합니다(지번 일치 우선, 없으면 이름 유사도 0.6 이상).
  const subscriptionDataPath = path.join(__dirname, "subscription_data.json");
  const subscriptionRecords = await loadSubscriptionData(subscriptionDataPath);
  const subscriptionTypesByApt = {};

  // 매칭에 사용된 청약홈 레코드를 추적합니다 - 아래 3-4-b단계에서 "실거래가 전혀
  // 없어 아직 어떤 uniqueAptKeys에도 매칭되지 못한" 레코드만 신규 시딩 대상으로 삼기 위함입니다.
  const matchedSubscriptionRecords = new Set();

  if (subscriptionRecords.length > 0) {
    let subscriptionMatchedCount = 0;

    for (const [address, info] of uniqueAptKeys.entries()) {
      const guName = LAWD_CD_TO_GU[info.lawdCd] || "";
      if (!guName || !info.dong) continue;

      // 구 이름만으로 1차 후보를 추립니다(구 하나당 평균 10건 미만이라 성능 부담 없음).
      // 동 이름까지 문자열에 포함되어야 한다는 조건은 걸지 않습니다 - 청약 공고의
      // 공급위치는 법정동("둔촌동")이 아니라 행정동("둔촌1동") 표기를 쓰는 경우가 많아,
      // 부분 문자열 매칭으로는 걸러져 버립니다(예: "둔촌1동"은 "둔촌동"을 포함하지 않음).
      // 대신 아래 지번/이름 유사도 교차검증으로 정확도를 확보합니다.
      const candidates = subscriptionRecords.filter(rec => rec.address.includes(guName));
      if (candidates.length === 0) continue;

      const targetJibun = normalizeJibun(info.jibun);

      let bestItem = null;
      let bestIsJibunMatch = false;
      let bestSim = 0;

      for (const cand of candidates) {
        const candJibun = normalizeJibun(extractJibunFromBjdAddr(cand.address, info.dong));
        const isJibunMatch = candJibun !== "" && candJibun === targetJibun;
        const sim = getSimilarity(info.aptName, cand.complexName);

        if (isJibunMatch && !bestIsJibunMatch) {
          bestItem = cand;
          bestIsJibunMatch = true;
          bestSim = sim;
        } else if (isJibunMatch === bestIsJibunMatch && sim > bestSim) {
          bestItem = cand;
          bestSim = sim;
        }
      }

      // K-apt와 동일한 이유로 이름 유사도 단독 채택을 제거했습니다 - 여기 후보군은
      // "같은 구 전체"라 K-apt(같은 동)보다도 후보 풀이 넓어 오매칭 위험이 더 큽니다.
      // 이 매칭 결과는 is_estimated_units=false("확인" 배지)로 세대수에 그대로 반영되므로,
      // 잘못 매칭되면 "추정치"보다 더 위험한 "확정된 오답"이 됩니다.
      if (!bestIsJibunMatch) {
        bestItem = null;
      }

      if (bestItem) {
        // 동일 평형(반올림 2자리)에 타입이 여러 건이면(예: 84.96A/84.96B가 같은
        // 반올림 값을 갖는 경우) 세대수를 합산하고 타입 라벨을 병기합니다.
        subscriptionTypesByApt[address] = buildSubscriptionAreaMap(bestItem.types);
        matchedSubscriptionRecords.add(bestItem);
        subscriptionMatchedCount++;
      }
    }

    console.log(`[청약홈 분양정보 매칭] 고유주소 ${uniqueAptKeys.size}개 중 ${subscriptionMatchedCount}개 단지 실제 평형별 세대수 확인 완료`);
  }

  // 3-4-b단계: 실거래가 한 건도 없어 uniqueAptKeys에 아예 등장하지 않는 단지(청약 공고만
  // 있는 사용승인 전 신축 등)를 청약홈 데이터만으로 별도 시딩합니다. 이런 단지는 REB/K-apt/
  // 건축HUB 어디에도 아직 없으므로(사용승인 전에는 등록 자체가 안 됨) 청약홈이 유일한 소스이고,
  // 세대수는 일반+특별공급 물량만 반영됩니다(조합원 분양분은 청약홈 자체에 없어 제외 - 재건축/
  // 재개발 단지는 화면의 "확인" 배지 툴팁으로 이 한계를 안내합니다).
  //
  // 이름 기반 중복 방지: 청약 당시 지번/동 표기가 준공 후 실거래 표기와 아예 달라(재건축으로
  // 지번 자체가 바뀌거나 - 예: 올림픽파크 포레온이 청약 당시엔 "둔촌1동 170-1"(구 둔촌주공1단지
  // 지번), 준공 후 실거래는 "둔촌동 633"(재건축 후 새 지번)을 씀 - 위 지번 매칭이 실패하면,
  // 이미 실거래로 존재하는 단지를 세대수 0건짜리 유령 단지로 또 만들어버립니다(디에이치퍼스티어
  // 아이파크에서 실제로 발생했던 문제와 같은 종류). 같은 구에 이름이 동일한 실거래 단지가
  // 이미 있으면 이 레코드는 그 단지 자신일 가능성이 매우 높으므로 신규 시딩을 건너뜁니다.
  const realAptNamesByGu = new Map(); // guName -> Set(normalizeString(aptName))
  for (const info of uniqueAptKeys.values()) {
    const guName = LAWD_CD_TO_GU[info.lawdCd] || "";
    if (!guName) continue;
    if (!realAptNamesByGu.has(guName)) realAptNamesByGu.set(guName, new Set());
    realAptNamesByGu.get(guName).add(normalizeString(info.aptName));
  }

  const subscriptionOnlyAptMeta = {};
  let subscriptionOnlySeededCount = 0;
  let subscriptionOnlySkippedAsDuplicateCount = 0;
  for (const rec of subscriptionRecords) {
    if (matchedSubscriptionRecords.has(rec)) continue;

    const parts = parseSubscriptionAddressToParts(rec.address);
    if (!parts) continue;
    if (!GU_TO_LAWD[parts.guName]) continue; // 프로젝트 수집 범위(서울 25개 자치구) 밖이면 제외

    const addressKey = `${parts.city} ${parts.guName} ${parts.dong} ${parts.jibun}`.trim();
    if (uniqueAptKeys.has(addressKey)) continue; // 실거래 주소와 우연히 일치하면 중복 방지

    const realNames = realAptNamesByGu.get(parts.guName);
    if (realNames && realNames.has(normalizeString(rec.complexName))) {
      subscriptionOnlySkippedAsDuplicateCount++;
      continue;
    }

    subscriptionOnlyAptMeta[addressKey] = {
      apt_name: rec.complexName,
      gu_name: parts.guName,
      dong_name: parts.dong,
      jibun: parts.jibun,
      raw_address: rec.address
    };
    subscriptionTypesByApt[addressKey] = buildSubscriptionAreaMap(rec.types);
    subscriptionOnlySeededCount++;
  }
  if (subscriptionOnlySkippedAsDuplicateCount > 0) {
    console.log(`[청약홈 유령 중복 방지] 지번 불일치(구 지번/행정동 표기 등)로 실거래 단지와 매칭되진 않았지만 같은 구에 동일 이름의 실거래 단지가 있어 ${subscriptionOnlySkippedAsDuplicateCount}건의 신규 시딩을 건너뛰었습니다.`);
  }
  if (subscriptionOnlySeededCount > 0) {
    console.log(`[청약홈 전용 신축 단지 시딩] 실거래 없이 청약홈 데이터만으로 ${subscriptionOnlySeededCount}개 단지 추가 (사용승인 전 등 - 조합원 분양분 제외 물량)`);
  }

  // 4단계: 거래 회전율 및 가격 통계 연산
  console.log("4단계: 평형별 세대수 균등 안분 및 통계 계산 중...");
  const results = processor.calculateTurnoverRates(allTrades, rebAptDataByApt, kaptDataByApt, bldRgstDataByApt, subscriptionTypesByApt, subscriptionOnlyAptMeta, duplicateAddressMergeMap, sharedJibunDisambiguationMap);

  // 5단계: 최종 통계 데이터 저장
  await saveResultsToJson(results, "turnover_results.json");
  await saveResultsToCsv(results, "turnover_results.csv");

  console.log(`통계 처리 완료 단지/평형 레코드: ${results.length}개`);

  // 6단계: 한국부동산원(R-ONE) 거시 시장 통계 데이터 수집 및 캐싱
  console.log("6단계: 한국부동산원(R-ONE) 거시 시장 통계 수집 중...");
  try {
    const rOneClient = new ROneStatsClient();
    
    const now = new Date();
    const currentYear = now.getFullYear();
    const currentMonth = String(now.getMonth() + 1).padStart(2, "0");
    const endWrtTime = `${currentYear}${currentMonth}`;
    
    // 2022년 1월부터의 매매거래량 추이 수집
    const rawStats = await rOneClient.fetchStatsData("A_2024_00554", "MM", "202201", endWrtTime);
    
    console.log(`[R-ONE Stats] 수집 완료. 원천 로우 수: ${rawStats.length}개`);
    
    // 자치구별 그룹화 및 가공
    const statsResult = {};
    
    // 서울 자치구이고 지표명이 '동(호)수'인 로우만 필터링
    const targetRows = rawStats.filter(r => 
      r.CLS_FULLNM &&
      r.CLS_FULLNM.startsWith("서울>") &&
      String(r.ITM_ID) === "100001"
    );

    targetRows.forEach(r => {
      const guName = r.CLS_NM;
      if (!statsResult[guName]) {
        statsResult[guName] = [];
      }
      statsResult[guName].push({
        month: r.WRTTIME_IDTFR_ID,
        month_label: r.WRTTIME_DESC,
        value: parseInt(r.DTA_VAL, 10) || 0
      });
    });

    // 각 구별로 날짜 오름차순 정렬
    for (const gu of Object.keys(statsResult)) {
      statsResult[gu].sort((a, b) => a.month.localeCompare(b.month));
    }

    // 결과 파일 저장
    await saveResultsToJson(statsResult, "rone_stats_results.json");
    console.log("[R-ONE Stats] 거시 시장 통계 적재 성공: rone_stats_results.json");

  } catch (error) {
    console.error(`[R-ONE ERROR] 거시 시장 통계 연동 중 예외 발생: ${error.message}`);
  }
}

// 배포 환경(Render 등)에서는 매 재기동마다 국토부/K-apt 등 외부 API를 전량 재수집하는
// 무거운 파이프라인을 돌릴 수 없습니다(기동 지연 + API 일일 한도 소진). SERVE_ONLY=true면
// 이미 생성된 turnover_results.json 등 정적 데이터만으로 서버를 즉시 기동합니다.
// 로컬에서 데이터를 갱신할 땐 이 값을 설정하지 않으면 기존과 동일하게 파이프라인이 돕니다.
const SERVE_ONLY = process.env.SERVE_ONLY === "true";

async function main() {
  if (!SERVE_ONLY) {
    try {
      await runPipeline();
    } catch (err) {
      console.error(`[PIPELINE ERROR] ${err.message}`);
    }
  }

  await startStaticServer();
}

main().catch(err => {
  console.error("시스템 기동 실패:", err);
  process.exitCode = 1;
});
