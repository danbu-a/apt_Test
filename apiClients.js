import * as config from "./config.js";

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * 공공데이터 XML 응답에서 특정 태그(<item>...</item>) 목록을 정규식으로 파싱하는 경량 헬퍼 함수
 */
function parseXmlItems(xmlText, tagName = "item") {
  const items = [];
  if (!xmlText) return items;

  const itemRegex = new RegExp(`<${tagName}>([\\s\\S]*?)</${tagName}>`, "g");
  let match;

  while ((match = itemRegex.exec(xmlText)) !== null) {
    const itemContent = match[1];
    const itemObj = {};
    
    const tagRegex = /<([^>]+)>([\s\S]*?)<\/\1>/g;
    let tagMatch;
    
    while ((tagMatch = tagRegex.exec(itemContent)) !== null) {
      const key = tagMatch[1];
      const val = tagMatch[2].trim();
      itemObj[key] = val;
    }
    
    if (Object.keys(itemObj).length > 0) {
      items.push(itemObj);
    }
  }
  
  return items;
}

class BaseApiClient {
  constructor(serviceKey) {
    this.serviceKey = serviceKey;
  }

  async sendRequest(baseUrl, params, headers = {}) {
    const queryParams = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (key !== "serviceKey") {
        queryParams.append(key, value);
      }
    }
    
    const fullUrl = `${baseUrl}?serviceKey=${this.serviceKey}&${queryParams.toString()}`;
    
    try {
      const response = await fetch(fullUrl, {
        headers: {
          "Accept": "application/xml",
          ...headers
        }
      });
      
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      
      return await response.text();
    } catch (error) {
      console.error(`[API ERROR] ${baseUrl} 요청 중 에러: ${error.message}`);
      return null;
    }
  }
}

export class MolitAptTradeClient extends BaseApiClient {
  constructor() {
    super(config.MOLIT_API_KEY);
    this.url = config.MOLIT_TRADE_URL;
  }

  // 1페이지(최대 250건)만 받고 끝내면, 거래가 활발한 구/월(예: 강남구 250건 초과)에서
  // totalCount를 넘는 나머지 페이지가 통째로 누락됩니다(실사례: 2026-04 강남구
  // totalCount 417건인데 1페이지 250건만 수집됨). totalCount를 읽어 필요한 만큼
  // 페이지를 이어서 요청합니다.
  async fetchTradeData(lawdCd, dealYmd) {
    const numOfRows = 250;
    const MAX_PAGES = 40; // 안전장치: totalCount 파싱 실패 등으로 무한루프에 빠지지 않도록 상한
    const allTrades = [];
    let totalCount = numOfRows; // 첫 페이지 응답으로 실제 값을 알기 전까지의 임시값

    for (let pageNo = 1; pageNo <= MAX_PAGES && (pageNo - 1) * numOfRows < totalCount; pageNo++) {
      const params = {
        LAWD_CD: lawdCd,
        DEAL_YMD: dealYmd,
        numOfRows: String(numOfRows),
        pageNo: String(pageNo)
      };

      const xmlText = await this.sendRequest(this.url, params);
      if (!xmlText) {
        console.warn(`[WARN] ${dealYmd} 실거래가 API 호출 실패 (${pageNo}페이지).`);
        break;
      }

      const totalCountMatch = xmlText.match(/<totalCount>(\d+)<\/totalCount>/);
      if (totalCountMatch) totalCount = parseInt(totalCountMatch[1], 10);

      const pageTrades = this.parseTradeXml(xmlText);
      if (pageTrades.length === 0) break;
      allTrades.push(...pageTrades);

      if (pageNo * numOfRows < totalCount) await sleep(300); // 다음 페이지 호출 전 API 부하 완화
    }

    return allTrades;
  }

  parseTradeXml(xmlText) {
    const items = parseXmlItems(xmlText, "item");
    const trades = [];

    for (const item of items) {
      const rawAmountTag = item["dealAmount"] || item["거래금액"] || "";
      const rawAmount = String(rawAmountTag).trim().replace(/,/g, "");
      const dealAmount = parseInt(rawAmount, 10) || 0;
      
      const aptName = String(item["aptNm"] || item["아파트"] || "").trim();
      const dong = String(item["umdNm"] || item["법정동"] || "").trim();
      const jibun = String(item["jibun"] || item["지번"] || "").trim();
      const area = parseFloat(item["excluUseAr"] || item["전용면적"] || "0");
      
      const year = parseInt(item["dealYear"] || item["년"] || "0", 10);
      const month = parseInt(item["dealMonth"] || item["월"] || "0", 10);
      const day = parseInt(item["dealDay"] || item["일"] || "0", 10);
      const floor = parseInt(item["floor"] || item["층"] || "0", 10) || 0;
      const lawdCd = String(item["sggCd"] || item["지역코드"] || "").trim();

      // cdealType="O"는 해당 거래가 이후 해제(계약 취소)신고된 건임을 뜻합니다. 실제
      // 성사되지 않은 거래이므로 회전율/평균가/산점도 어디에도 잡히면 안 됩니다 -
      // 수집 단계에서 아예 버립니다(실사례: 은마 76.79㎡ 2025-10-29 359,000만원 건이
      // 해제 후에도 원본 신고 건이 그대로 남아있어 같은 값이 중복 표시되던 문제).
      const isCancelled = String(item["cdealType"] || "").trim() === "O";

      if (aptName && area > 0 && !isCancelled) {
        trades.push({
          apt_name: aptName,
          dong: dong,
          jibun: jibun,
          exclusive_area: area,
          deal_amount: dealAmount,
          deal_year: year,
          deal_month: month,
          deal_day: day,
          floor: floor,
          lawd_cd: lawdCd
        });
      }
    }
    
    return trades;
  }
}

/**
 * 한국부동산원 공동주택 단지 식별정보 조회 서비스 (공식 JSON API 클라이언트)
 */
export class RebAptInfoClient {
  constructor() {
    this.serviceKey = config.REB_API_KEY;
    this.baseUrl = `${config.REB_BASE_URL}${config.REB_APT_INFO_ENDPOINT}`;
  }

  /**
   * 법정동/지번 주소를 활용하여 아파트 단지 기본정보를 조회합니다.
   * 
   * @param {string} address - 검색용 지번 주소 (예: "서울특별시 마포구 아현동 777")
   * @returns {Promise<Array<Object>>} 단지 정보 목록 (data 배열)
   */
  async fetchAptInfoByAddress(address) {
    const url = new URL(this.baseUrl);
    url.searchParams.append("serviceKey", this.serviceKey);
    url.searchParams.append("returnType", "JSON");
    url.searchParams.append("cond[ADRES::LIKE]", address);

    try {
      const response = await fetch(url.toString(), {
        headers: {
          "Accept": "application/json"
        }
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const json = await response.json();
      return json.data || [];
    } catch (error) {
      console.error(`[REB API ERROR] 주소 '${address}' 조회 중 에러: ${error.message}`);
      return [];
    }
  }
}

/**
 * 국토교통부_전국 법정동 (ODCloud 기반 API) 클라이언트
 * 시군구명 + 읍면동명으로 10자리 법정동코드를 조회합니다 (건축물대장 API의 bjdongCd 파라미터용).
 */
export class LegalDongCodeClient {
  constructor() {
    this.serviceKey = config.DATA_GO_KR_SERVICE_KEY;
    this.baseUrl = `${config.LEGAL_DONG_BASE_URL}${config.LEGAL_DONG_ENDPOINT}`;
  }

  /**
   * @param {string} sigunguName - 예: "강남구"
   * @param {string} dongName - 예: "역삼동"
   * @returns {Promise<string|null|undefined>} 10자리 법정동코드, 정상 조회했으나 후보가 없으면 null,
   *   네트워크/API 오류로 조회 자체에 실패하면 undefined (호출부에서 캐싱하지 않고 다음 실행에 재시도해야 함)
   */
  async fetchBjdongCode(sigunguName, dongName) {
    const url = new URL(this.baseUrl);
    url.searchParams.append("serviceKey", this.serviceKey);
    url.searchParams.append("perPage", "50");
    url.searchParams.append(`cond[읍면동명::EQ]`, dongName);

    try {
      const response = await fetch(url.toString(), {
        headers: { "Accept": "application/json" }
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const json = await response.json();
      const rows = json.data || [];

      // 시군구명이 정확히 일치하는 후보만 필터
      const candidates = rows.filter(r => r["시군구명"] === sigunguName);
      if (candidates.length === 0) return null; // 정상 응답이지만 실제로 후보가 없는 경우 (영구 캐싱 가능)

      // 삭제일자가 없는(현재 유효한) 코드를 우선 채택, 없으면 첫 후보 사용
      const active = candidates.find(r => !r["삭제일자"]);
      const chosen = active || candidates[0];
      return chosen["법정동코드"] ? String(chosen["법정동코드"]) : null;
    } catch (error) {
      // 네트워크/API 장애: null이 아닌 undefined를 반환해 "확인된 실패"와 구분합니다.
      console.error(`[법정동코드 API ERROR] '${sigunguName} ${dongName}' 조회 중 에러: ${error.message}`);
      return undefined;
    }
  }
}

/**
 * 국토교통부_건축HUB_건축물대장정보 서비스 클라이언트
 * 건폐율(bcRat)/용적률(vlRat) 조회용. 총괄표제부(다동 단지) 우선 조회 후,
 * 결과가 없으면 표제부(단일 동/건물)로 폴백합니다.
 */
// 동시성 제한만으로는 요청이 순간적으로 몰려 초당 요청 제한(HTTP 429)에 걸리는 문제가 있어,
// 인스턴스 여러 개/동시 호출과 무관하게 전역으로 요청 사이 최소 간격을 강제하는 레이트 리미터입니다.
let bldRgstNextAllowedTime = 0;
const BLD_RGST_MIN_INTERVAL_MS = 150; // 초당 약 6~7건으로 제한

// 일일 트래픽 한도(quota) 초과가 감지되면 true로 전환되어, 이후의 모든 요청을 즉시 스킵합니다.
// (재시도/대기를 반복해봐야 quota가 리셋되기 전까지는 절대 성공하지 않으므로 시간 낭비를 방지합니다.)
// data.go.kr의 일일 한도는 자정에 초기화되는데, 이 플래그는 그걸 모르고 프로세스가 재시작되기
// 전까지 계속 막혀 있었습니다(배포 환경은 재기동이 뜸해서 하루 이상 등기 조회 전체가 막히는
// 원인이 됨) - 그래서 언제 막혔는지(bldRgstQuotaExceededAt)를 같이 기록해두고, 24시간이
// 지나면 한도가 리셋됐을 것으로 보고 자동으로 다시 시도를 허용합니다.
let bldRgstQuotaExceeded = false;
let bldRgstQuotaExceededAt = 0;
const BLD_RGST_QUOTA_LOCKOUT_MS = 24 * 60 * 60 * 1000;

async function waitForBldRgstRateLimitSlot() {
  const now = Date.now();
  const waitMs = Math.max(0, bldRgstNextAllowedTime - now);
  bldRgstNextAllowedTime = Math.max(now, bldRgstNextAllowedTime) + BLD_RGST_MIN_INTERVAL_MS;
  if (waitMs > 0) {
    await new Promise(resolve => setTimeout(resolve, waitMs));
  }
}

export class BldRgstClient {
  constructor() {
    this.serviceKey = config.BLD_RGST_API_KEY;
    this.baseUrl = config.BLD_RGST_BASE_URL;
  }

  // 네트워크/API 오류 시 undefined를 반환해(캐싱 금지) 정상 응답이지만 결과가 없는 경우([])와 구분합니다.
  // apis.data.go.kr가 Node fetch(undici)와 간헐적으로 연결이 끊기는 사례가 있어(HTTP/1.1 전용 +
  // keep-alive 처리 이슈로 추정, curl은 정상 동작) 최대 3회까지 짧은 대기 후 재시도합니다.
  async _fetchOperation(operation, params, attempt = 1, numOfRows = 5, pageNo = 1) {
    if (bldRgstQuotaExceeded) {
      if (Date.now() - bldRgstQuotaExceededAt < BLD_RGST_QUOTA_LOCKOUT_MS) return undefined;
      bldRgstQuotaExceeded = false; // 막힌 지 24시간이 지나 한도가 리셋됐을 것으로 보고 재시도를 허용합니다.
    }

    const MAX_ATTEMPTS = 3;
    const url = new URL(`${this.baseUrl}/${operation}`);
    url.searchParams.append("serviceKey", this.serviceKey);
    url.searchParams.append("_type", "json");
    url.searchParams.append("numOfRows", String(numOfRows));
    url.searchParams.append("pageNo", String(pageNo));
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.append(key, value);
    }

    await waitForBldRgstRateLimitSlot();

    try {
      const response = await fetch(url.toString(), {
        headers: { "Accept": "application/json", "Connection": "close" }
      });

      if (!response.ok) {
        const bodyText = await response.text().catch(() => "");
        if (/quota/i.test(bodyText)) {
          bldRgstQuotaExceeded = true;
          bldRgstQuotaExceededAt = Date.now();
          console.error(`[건축HUB API] 일일 요청 한도(quota) 초과가 감지되어 이후 24시간 동안 요청을 모두 스킵합니다. 응답: ${bodyText}`);
          return undefined;
        }
        const err = new Error(`HTTP error! status: ${response.status}`);
        err.httpStatus = response.status;
        throw err;
      }

      const json = await response.json();
      const resultCode = json?.response?.header?.resultCode;

      // resultCode가 "00"(정상)이 아니면 트래픽 초과/일시 오류 등 API 레벨 오류입니다.
      // HTTP 상태는 200으로 오면서 body만 비어있게 응답하는 경우가 있어, items가 없다고
      // 곧바로 "매칭 없음"으로 단정하면 안 되고 반드시 resultCode를 먼저 확인해야 합니다.
      if (resultCode !== undefined && resultCode !== "00") {
        throw new Error(`API 오류 resultCode=${resultCode} (${json?.response?.header?.resultMsg || ""})`);
      }

      const item = json?.response?.body?.items?.item;
      const result = !item ? [] : (Array.isArray(item) ? item : [item]);
      // 페이징 판단용으로 응답 헤더의 실제 totalCount를 배열에 실어 보냅니다(요청한
      // numOfRows와 무관하게 API가 페이지당 최대 100건으로 응답을 강제 절단하는 것을
      // 확인했기 때문에, "이번 페이지 건수 < 요청 건수"만으로는 다음 페이지 존재 여부를
      // 판단할 수 없습니다 - fetchExposPubuseArea 참고).
      result.totalCount = json?.response?.body?.totalCount;
      return result;
    } catch (error) {
      const causeMsg = error.cause ? ` (원인: ${error.cause.code || error.cause.message || error.cause})` : "";
      if (attempt < MAX_ATTEMPTS) {
        // 429(초당 요청 제한 초과)는 일반 오류보다 훨씬 길게 대기해야 재시도가 의미 있습니다.
        const backoffMs = error.httpStatus === 429 ? 2000 * attempt : 700 * attempt;
        console.warn(`[건축HUB API RETRY] ${operation} 요청 실패${causeMsg} - ${attempt}회차, ${backoffMs}ms 후 재시도합니다.`);
        await new Promise(resolve => setTimeout(resolve, backoffMs));
        return this._fetchOperation(operation, params, attempt + 1, numOfRows, pageNo);
      }
      console.error(`[건축HUB API ERROR] ${operation} 요청 중 에러${causeMsg}: ${error.message}`);
      return undefined;
    }
  }

  /**
   * @param {{sigunguCd:string, bjdongCd:string, platGbCd:string, bun:string, ji:string}} params
   * @returns {Promise<{bcRat:number, vlRat:number}|null|undefined>} null=정상 조회했으나 매칭 없음(영구 캐싱 가능),
   *   undefined=네트워크/API 오류로 조회 실패(캐싱 금지, 다음 실행에 재시도)
   */
  async fetchBuildingCoverageAndFloorAreaRatio(params) {
    let items = await this._fetchOperation("getBrRecapTitleInfo", params);
    if (items === undefined) return undefined; // 총괄표제부 조회 자체가 실패 -> 재시도 필요

    if (items.length === 0) {
      // 총괄표제부가 없는 단지(구축 등)는 표제부(동별 개별 레코드)로 폴백합니다. 대단지는
      // 한 지번에 표제부가 수십~수백 건(예: 헬리오시티 168건, 올림픽파크포레온 160건)일 수
      // 있는데, 이전에는 numOfRows=5로만 요청해 관리동/경비실처럼 건폐율·용적률이 비어있는
      // 부속건물이 앞 5건에 걸리면 실제로 다른 동에 값이 있어도 "정보 없음"으로 잘못
      // 처리됐습니다. API 문서상 1회 요청 최대 허용치인 100건까지 요청해 이 위험을 줄입니다.
      items = await this._fetchOperation("getBrTitleInfo", params, 1, 100);
      if (items === undefined) return undefined; // 표제부 조회 자체가 실패 -> 재시도 필요
    }
    if (items.length === 0) return null;

    // 여러 건물(동)이 있는 경우 총괄표제부(regstrKindCd === "1")를 우선 채택하고,
    // 그것도 없으면(표제부 폴백) 건폐율/용적률 값이 실제로 채워진 첫 레코드를 채택합니다
    // (표제부는 동별 개별 레코드라 관리동 등 일부는 이 값이 비어있을 수 있음).
    const recap = items.find(it => it.regstrKindCd === "1");
    const withRatio = items.find(it => parseFloat(it.bcRat) > 0 || parseFloat(it.vlRat) > 0);
    const chosen = recap || withRatio || items[0];

    const bcRat = parseFloat(chosen.bcRat);
    const vlRat = parseFloat(chosen.vlRat);
    if ((!bcRat || bcRat <= 0) && (!vlRat || vlRat <= 0)) return null;

    return {
      bcRat: isNaN(bcRat) ? 0 : bcRat,
      vlRat: isNaN(vlRat) ? 0 : vlRat
    };
  }

  /**
   * 전유공용면적(개별 호실 단위 전용/공용면적) 조회.
   * 대시보드에서 사용자가 특정 단지를 조회하는 시점에 온디맨드로 호출되며(서버 기동 시 일괄 조회 안 함),
   * 세대별 전용면적을 그대로 반환합니다 - 청약홈/정비사업 정보몽땅과 달리 조합원 분양분을 포함한
   * 실제 준공 등기 기준 전량이라 가장 신뢰도가 높습니다.
   * @param {{sigunguCd:string, bjdongCd:string, platGbCd:string, bun:string, ji:string}} params
   * @param {(loaded:number, total:number) => void} [onProgress] 페이지를 하나 받을 때마다 누적 건수와
   *   전체 건수를 알려줍니다. 올림픽파크포레온처럼 수만 행짜리 단지는 조회가 수십 초 걸려,
   *   호출부가 이 값을 진행률로 노출합니다.
   * @returns {Promise<Array|undefined>} 원본 아이템 배열(호출부에서 집계), 네트워크/API 오류 시 undefined
   */
  async fetchExposPubuseArea(params, onProgress) {
    // 실측 결과 이 API는 numOfRows를 1000으로 요청해도 페이지당 최대 100건으로 응답을
    // 강제 절단합니다(totalCount는 정상적으로 전체 건수를 알려줌). 그래서 "이번 페이지
    // 건수 < 요청 건수"만으로 다음 페이지 존재 여부를 판단하면 실제로는 더 남아있는데도
    // 첫 페이지에서 멈춰버립니다 - 응답 헤더의 totalCount와 누적 건수를 비교해야 합니다.
    // 대단지는 세대(호실)당 여러 행(전유+공용)이 나와 총 로우 수가 수만 건에 달할 수 있어
    // MAX_PAGES를 넉넉하게 잡습니다.
    const PAGE_SIZE = 100;
    // 올림픽파크포레온(둔촌주공 재건축)은 전유+공용 행이 약 98,700건에 달해, 기존 상한
    // 500페이지(=5만 건)로는 절반밖에 못 받아 항상 truncated로 폐기됐습니다. 국내 최대
    // 규모(1.2만 세대)도 담을 수 있도록 1,200페이지(=12만 건)로 올립니다.
    const MAX_PAGES = 1200;
    let allItems = [];
    let page = 1;
    let totalCount = Infinity;
    while (page <= MAX_PAGES && allItems.length < totalCount) {
      const items = await this._fetchOperation("getBrExposPubuseAreaInfo", params, 1, PAGE_SIZE, page);
      // 네트워크 오류로 페이징 도중 중단된 경우도 "일부만 가져온 상태"이므로 truncated로
      // 표시합니다 - 호출부가 이를 완결된 결과로 오인해 캐싱하지 않도록 하기 위함입니다.
      if (items === undefined) {
        if (allItems.length === 0) return undefined;
        allItems.truncated = true;
        return allItems;
      }
      // totalCount는 _type=json 응답에서 문자열("43094")로 오는 경우가 있어 반드시 숫자로
      // 변환해야 합니다. typeof === "number"로만 검사하면 영영 Infinity에 머물러, 페이징
      // 종료 판단이 "마지막 페이지 건수 < 100"에만 의존하게 되고 진행률도 낼 수 없습니다.
      const parsedTotal = Number(items.totalCount);
      if (Number.isFinite(parsedTotal) && parsedTotal > 0) totalCount = parsedTotal;

      allItems = allItems.concat(items);
      if (onProgress) onProgress(allItems.length, Number.isFinite(totalCount) ? totalCount : 0);
      if (items.length < PAGE_SIZE) return allItems; // 실제 반환 건수가 요청보다 적으면 마지막 페이지(완결)
      page++;
    }
    // MAX_PAGES에 도달했는데도 totalCount를 채우지 못했다면(초대형 단지 등) 불완전한
    // 결과입니다 - 세대수를 과소 집계한 채로 조용히 캐싱되는 것을 막기 위해 표시합니다.
    if (allItems.length < totalCount) allItems.truncated = true;
    return allItems;
  }

  // ------------------------------------------------------------------------
  // 아래 7개는 현재 파이프라인/대시보드에서 직접 쓰이지는 않지만, OpenAPI 활용가이드
  // (건축HUB_건축물대장_1.0)의 나머지 오퍼레이션을 그대로 연결해둔 것입니다. 모든
  // 오퍼레이션이 공통으로 sigunguCd(필수)/bjdongCd(필수)/platGbCd/bun/ji(옵션, 지번
  // 특정용) + startDate/endDate(옵션, YYYYMMDD 검색기간)를 요청 파라미터로 받습니다.
  // numOfRows는 문서상 1회 요청 허용 최대치인 100을 기본값으로 둡니다 - 5같은 작은
  // 값을 기본으로 두면 대단지에서 조용히 데이터가 잘리는 문제(표제부 조회에서 실제로
  // 발생했던 버그)가 재발할 수 있기 때문입니다. 반환되는 배열에는 _fetchOperation이
  // 붙여주는 .totalCount가 그대로 실려 있으므로, 필요 시 호출부에서 fetchExposPubuseArea와
  // 동일한 방식(.totalCount vs 누적 길이 비교)으로 완전한 페이지네이션을 구현할 수 있습니다.
  // 반환값: 아이템 배열([]=매칭 없음), 네트워크/API 오류 시 undefined.
  // ------------------------------------------------------------------------

  /**
   * 오퍼레이션 1: getBrBasisOulnInfo - 건축물대장 기본개요 조회.
   * 대장종류/대장구분, 지번주소·새주소, 지역지구구역(jiyukCd/jiguCd/guyukCd) 등 개요 정보.
   * 한 지번에 대장구분(총괄표제부/일반건축물/표제부/전유부)이 섞여서 다건으로 나올 수 있습니다.
   */
  async fetchBasicOutline(params, numOfRows = 100, pageNo = 1) {
    return this._fetchOperation("getBrBasisOulnInfo", params, 1, numOfRows, pageNo);
  }

  /**
   * 오퍼레이션 4: getBrFlrOulnInfo - 건축물대장 층별개요 조회.
   * 동명칭(dongNm), 층구분/층번호(flrGbCd/flrNo), 층별 구조/용도, 층별 면적(area),
   * 주부속구분(mainAtchGbCd: 0=주건축물/1=부속건축물)을 층 단위로 제공합니다.
   */
  async fetchFloorOutline(params, numOfRows = 100, pageNo = 1) {
    return this._fetchOperation("getBrFlrOulnInfo", params, 1, numOfRows, pageNo);
  }

  /**
   * 오퍼레이션 5: getBrAtchJibunInfo - 건축물대장 부속지번 조회.
   * 부속대장구분(atchRegstrGbCd)과 부속지번(atchSigunguCd/atchBjdongCd/atchBun/atchJi) -
   * 하나의 건축물이 여러 필지에 걸쳐 있을 때 본 지번 외 나머지 지번들을 알려줍니다.
   */
  async fetchAttachedJibun(params, numOfRows = 100, pageNo = 1) {
    return this._fetchOperation("getBrAtchJibunInfo", params, 1, numOfRows, pageNo);
  }

  /**
   * 오퍼레이션 7: getBrWclfInfo - 건축물대장 오수정화시설 조회.
   * 오수정화시설 형식(modeCd/modeCdNm), 용량(capaPsper=인용, capaLube=루베) 정보.
   */
  async fetchWasteWaterFacility(params, numOfRows = 100, pageNo = 1) {
    return this._fetchOperation("getBrWclfInfo", params, 1, numOfRows, pageNo);
  }

  /**
   * 오퍼레이션 8: getBrHsprcInfo - 건축물대장 주택가격 조회.
   * 전유부(호실) 단위 공동주택가격(hsprc)과 기준일자(stdDay). 국토부 공동주택 공시가격과
   * 연동되는 값으로, 세대별 공시가격이 필요할 때(예: 취득세/보유세 추정) 활용 가능합니다.
   */
  async fetchHousingPrice(params, numOfRows = 100, pageNo = 1) {
    return this._fetchOperation("getBrHsprcInfo", params, 1, numOfRows, pageNo);
  }

  /**
   * 오퍼레이션 9: getBrExposInfo - 건축물대장 전유부 조회.
   * 동명칭(dongNm)/호명칭(hoNm)/층정보만 제공하고 면적(area)은 없습니다 - 면적까지
   * 필요하면 fetchExposPubuseArea(getBrExposPubuseAreaInfo)를 쓰세요. 이 오퍼레이션은
   * 순수하게 "이 단지에 어떤 동/호가 존재하는지" 목록만 가볍게 확인할 때 적합합니다.
   */
  async fetchExposInfo(params, numOfRows = 100, pageNo = 1) {
    return this._fetchOperation("getBrExposInfo", params, 1, numOfRows, pageNo);
  }

  /**
   * 오퍼레이션 10: getBrJijiguInfo - 건축물대장 지역지구구역 조회.
   * 용도지역/용도지구/용도구역 구분(jijiguGbCd)과 명칭(jijiguCdNm, 예: "일반주거지역",
   * "지구단위계획구역"), 대표여부(reprYn). 한 지번에 여러 지역지구구역이 겹쳐 다건으로 옵니다.
   */
  async fetchZoningInfo(params, numOfRows = 100, pageNo = 1) {
    return this._fetchOperation("getBrJijiguInfo", params, 1, numOfRows, pageNo);
  }
}

/**
 * 한국부동산원(R-ONE) 부동산 통계 정보 오픈 API 클라이언트
 */
export class ROneStatsClient {
  constructor() {
    this.serviceKey = config.REB_STATS_API_KEY;
    this.baseUrl = "https://www.reb.or.kr/r-one/openapi/";
  }

  /**
   * 통계 데이터(조회 조건 설정) API를 페이징하면서 전수 수집합니다.
   */
  async fetchStatsData(statblId, cycleCd, startWrtTime, endWrtTime) {
    let allRows = [];
    let pIndex = 1;
    const pSize = 1000;
    let hasMore = true;

    while (hasMore) {
      const url = new URL(`${this.baseUrl}SttsApiTblData.do`);
      url.searchParams.append("key", this.serviceKey);
      url.searchParams.append("Type", "json");
      url.searchParams.append("pIndex", pIndex);
      url.searchParams.append("pSize", pSize);
      url.searchParams.append("STATBL_ID", statblId);
      url.searchParams.append("DTACYCLE_CD", cycleCd);
      url.searchParams.append("START_WRTTIME", startWrtTime);
      url.searchParams.append("END_WRTTIME", endWrtTime);

      try {
        const response = await fetch(url.toString(), {
          headers: {
            "Accept": "application/json"
          }
        });

        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }

        const json = await response.json();
        const rows = json.SttsApiTblData?.[1]?.row || [];
        
        if (rows.length === 0) {
          hasMore = false;
        } else {
          allRows = allRows.concat(rows);
          if (rows.length < pSize) {
            hasMore = false;
          } else {
            pIndex++;
          }
        }
      } catch (error) {
        console.error(`[R-ONE API ERROR] 통계 데이터 페이징 요청 실패 (Page: ${pIndex}): ${error.message}`);
        hasMore = false;
      }
    }

    return allRows;
  }
}
