import { readFileSync, existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 저장소에 올리는 .env.example과 달리 .env는 .gitignore로 제외된 로컬/배포 전용
// 파일입니다. 배포 플랫폼(Render 등)은 대시보드에서 환경변수를 직접 주입하므로
// 이 로더는 .env 파일이 없어도(그 환경에선 process.env가 이미 채워져 있으므로) 조용히
// 건너뜁니다 - 로컬 개발 편의만을 위한 최소 구현이라 별도 패키지(dotenv)를 쓰지 않습니다.
const envPath = path.join(__dirname, ".env");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, "");
    if (key && !(key in process.env)) process.env[key] = value;
  }
}

// 실제 API 인증키(Service Key) - 공공데이터포털에서 발급받은 개인 키라 저장소에 직접
// 커밋하지 않고 환경변수로 주입합니다. 로컬에서는 이 파일과 같은 위치에 .env 파일을
// 만들어 DATA_GO_KR_SERVICE_KEY=발급받은키 형식으로 넣어두면 됩니다(.env.example 참고).
export const DATA_GO_KR_SERVICE_KEY = process.env.DATA_GO_KR_SERVICE_KEY || "";

export const MOLIT_API_KEY = DATA_GO_KR_SERVICE_KEY;
export const REB_API_KEY = DATA_GO_KR_SERVICE_KEY;
export const KAPT_API_KEY = DATA_GO_KR_SERVICE_KEY;

// 한국부동산원(R-ONE) 부동산 통계 정보 오픈 API 인증키 - 위 DATA_GO_KR_SERVICE_KEY와는
// 별도로 발급받는 키라 R-ONE 사이트(https://www.reb.or.kr/r-one/)에서 따로 발급받아
// .env에 REB_STATS_API_KEY=발급받은키 형식으로 넣어두면 됩니다(.env.example 참고).
export const REB_STATS_API_KEY = process.env.REB_STATS_API_KEY || "";

// 1. 국토교통부 아파트매매 실거래 상세 자료 조회 API 설정
export const MOLIT_TRADE_URL = "https://apis.data.go.kr/1613000/RTMSDataSvcAptTradeDev/getRTMSDataSvcAptTradeDev";

// 2. 한국부동산원 공동주택 단지 식별정보 조회 서비스 (ODCloud 기반 API)
export const REB_BASE_URL = "https://api.odcloud.kr/api";
export const REB_APT_INFO_ENDPOINT = "/AptIdInfoSvc/v1/getAptInfo";

// 3. 국토교통부_전국 법정동 (ODCloud 기반 API, 법정동코드 10자리 조회용)
export const LEGAL_DONG_BASE_URL = "https://api.odcloud.kr/api";
export const LEGAL_DONG_ENDPOINT = "/15063424/v1/uddi:5176efd5-da6e-42a0-b2cf-8512f74503ea";

// 4. 국토교통부_건축HUB_건축물대장정보 서비스 (건폐율/용적률 조회용)
export const BLD_RGST_BASE_URL = "https://apis.data.go.kr/1613000/BldRgstHubService";
export const BLD_RGST_API_KEY = DATA_GO_KR_SERVICE_KEY;

// 배치 데이터 수집 범위 설정 (서울 25개 자치구 + 고양시 덕양구)
export const DEFAULT_LAWD_CD_LIST = [
  "11110", // 종로구
  "11140", // 중구
  "11170", // 용산구
  "11200", // 성동구
  "11215", // 광진구
  "11230", // 동대문구
  "11260", // 중랑구
  "11290", // 성북구
  "11305", // 강북구
  "11320", // 도봉구
  "11350", // 노원구
  "11380", // 은평구
  "11410", // 서대문구
  "11440", // 마포구
  "11470", // 양천구
  "11500", // 강서구
  "11530", // 구로구
  "11545", // 금천구
  "11560", // 영등포구
  "11590", // 동작구
  "11620", // 관악구
  "11650", // 서초구
  "11680", // 강남구
  "11710", // 송파구
  "11740", // 강동구
  "41281"  // 고양시 덕양구
];

// 웹 대시보드 로컬 서빙 포트
export const PORT = 3000;
export const LOG_LEVEL = "info";
