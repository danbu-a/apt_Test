let rawData = [];
let selectedApt = "";
let currentChart = null;
let priceScatterChart = null;
let currentSort = { key: "exclusive_area", direction: 1 }; // 1: 오름차순, -1: 내림차순
let apiOrigin = "";
let areaUnit = "sqm"; // "sqm" | "pyeong"

// 네이버 Geocode 요청 순번. 단지를 빠르게 연속 전환하면 이전 단지의 응답이 나중에 도착해
// 지도 핀을 옛 위치로 되돌리는 경쟁 상태가 생길 수 있어(비동기 콜백 도착 순서가 요청 순서와
// 다를 수 있음), 각 요청에 순번을 매기고 콜백에서 "가장 마지막에 보낸 요청"의 응답인지
// 확인한 뒤에만 지도를 갱신합니다.
let mapGeocodeSeq = 0;

// 1평 = 400/121 ㎡ (약 3.3058㎡). 부동산에서 쓰는 법정 환산값입니다.
const SQM_PER_PYEONG = 400 / 121;

function formatArea(sqm) {
  const value = Number(sqm);
  if (!value || value <= 0) return "-";
  return areaUnit === "pyeong"
    ? `${(value / SQM_PER_PYEONG).toFixed(1)}평`
    : `${value.toFixed(2)}㎡`;
}

// 공급면적은 건축물대장 전유부를 실측 조회한 단지에만 있습니다(전용 + 주거공용).
// 아직 조회 전이거나 등기 데이터가 없으면 전용면적만 보여줍니다.
function formatAreaPair(supplyArea, exclusiveArea) {
  const exclusive = formatArea(exclusiveArea);
  return Number(supplyArea) > 0 ? `${formatArea(supplyArea)} / ${exclusive}` : exclusive;
}

const LOCAL_SERVER_PORTS = [3000, 3001, 3002, 3003, 3004, 3005, 3006, 3007, 3008, 3009];
const GU_NAME_TO_LAWD_CD = {
  "종로구": "11110",
  "중구": "11140",
  "용산구": "11170",
  "성동구": "11200",
  "광진구": "11215",
  "동대문구": "11230",
  "중랑구": "11260",
  "성북구": "11290",
  "강북구": "11305",
  "도봉구": "11320",
  "노원구": "11350",
  "은평구": "11380",
  "서대문구": "11410",
  "마포구": "11440",
  "양천구": "11470",
  "강서구": "11500",
  "구로구": "11530",
  "금천구": "11545",
  "영등포구": "11560",
  "동작구": "11590",
  "관악구": "11620",
  "서초구": "11650",
  "강남구": "11680",
  "송파구": "11710",
  "강동구": "11740"
};

function normalizeOrigin(origin) {
  return origin.replace(/\/+$/, "");
}

function setApiOrigin(origin) {
  apiOrigin = normalizeOrigin(origin);
  window.__API_ORIGIN__ = apiOrigin;
}

function apiUrl(path) {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const origin = apiOrigin || (
    window.location.protocol === "file:" || window.location.origin === "null"
      ? "http://localhost:3000"
      : window.location.origin
  );
  return `${normalizeOrigin(origin)}${normalizedPath}`;
}

async function initApiOrigin() {
  if (window.__API_ORIGIN__) {
    setApiOrigin(window.__API_ORIGIN__);
    return apiOrigin;
  }

  if (window.location.protocol === "http:" || window.location.protocol === "https:") {
    setApiOrigin(window.location.origin);
    try {
      const response = await fetch(apiUrl("/api/config"), { cache: "no-store" });
      if (response.ok) {
        const config = await response.json();
        if (config.origin) setApiOrigin(config.origin);
      }
    } catch (err) {
      console.warn("[API CONFIG WARNING] 서버 런타임 포트 정보를 읽지 못했습니다. 현재 origin을 사용합니다.", err.message);
    }
    return apiOrigin;
  }

  for (const port of LOCAL_SERVER_PORTS) {
    const candidateOrigin = `http://localhost:${port}`;
    try {
      const response = await fetch(`${candidateOrigin}/api/config`, { cache: "no-store" });
      if (response.ok) {
        const config = await response.json();
        setApiOrigin(config.origin || candidateOrigin);
        return apiOrigin;
      }
    } catch (err) {
      // 다음 포트를 탐색합니다.
    }
  }

  setApiOrigin("http://localhost:3000");
  return apiOrigin;
}

async function fetchServerJson(path) {
  const response = await fetch(apiUrl(path), { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`${path} 호출 실패: ${response.status}`);
  }
  return response.json();
}

// Naver Maps 전역 변수
let map = null;
let marker = null;

// 네이버 지도 SDK는 ncpKeyId 인증에 실패하면 전역 콜백 window.navermap_authFailure를
// 호출합니다(공식 문서 기준 함수명, "navermaps"가 아니라 "navermap" 단수형입니다).
// (원인: NCP 콘솔 "Web 서비스 URL"에 현재 접속 도메인이 미등록이거나, Maps 제품이
// 비활성화된 경우 등) 이전에는 이 실패가 콘솔에만 조용히 남고 화면은 빈 지도로
// 보여서 원인 파악이 어려웠습니다. 여기서는 화면에도 명확한 안내를 표시합니다.
window.navermap_authFailure = function () {
  console.error(
    "[NAVER MAP AUTH FAILURE] ncpClientId 인증에 실패했습니다. " +
    "네이버클라우드플랫폼 콘솔의 Maps Application에서 현재 접속 주소(" +
    window.location.origin + ")가 'Web 서비스 URL'에 등록되어 있는지, " +
    "Maps 제품이 활성화되어 있는지 확인해 주세요."
  );
  const mapDiv = document.getElementById("map");
  if (mapDiv) {
    mapDiv.textContent =
      `지도 인증 실패: NCP 콘솔에 ${window.location.origin} 이(가) Web 서비스 URL로 등록되어 있는지 확인해 주세요.`;
  }
};

// R-ONE 거시 시장 통계 전역 변수
let roneStatsData = {};
let roneChart = null;

// 한화 만원 단위를 억/천만원 단위 한글 포맷으로 변환하는 함수
function formatKrw(value) {
  if (!value || value === 0) return "-";
  const eok = Math.floor(value / 10000);
  const remainder = value % 10000;
  
  let result = "";
  if (eok > 0) result += `${eok}억 `;
  if (remainder > 0) {
    result += `${remainder.toLocaleString()}만`;
  }
  return result.trim() + " 원";
}

// "YYYYMMDD" 형식 문자열을 "YYYY-MM-DD"로 변환 (값이 없거나 형식이 다르면 원본 반환)
function formatYyyymmddDash(rawDate) {
  const val = String(rawDate || "").trim();
  if (val.length === 8 && /^\d{8}$/.test(val)) {
    return `${val.substring(0, 4)}-${val.substring(4, 6)}-${val.substring(6, 8)}`;
  }
  return val || "";
}

// 초기화
document.addEventListener("DOMContentLoaded", async () => {
  try {
    await initApiOrigin();

    rawData = await fetchServerJson("/turnover_results.json");
    
    // R-ONE 거시 시장 통계 데이터 캐시 페치
    try {
      roneStatsData = await fetchServerJson("/rone_stats_results.json");
    } catch (err) {
      console.warn("[WARN] R-ONE 통계 캐시 데이터를 읽지 못했습니다. 파이프라인 가동 후 확인 가능합니다.", err.message);
    }

    // Date Picker 기본 범위 설정을 위한 계약월 탐색
    initDatePickerRange();
    
    // 대시보드 UI 및 이벤트 매핑 초기화
    initDashboard();
    initMaintenanceControls();
    initAreaUnitToggle();
    initScatterPeriodButtons();

    // Naver Maps 비동기 초기화 루프 기동
    initMap();
  } catch (error) {
    console.error("초기화 에러:", error);
    document.getElementById("tableBody").innerHTML = `
      <tr>
        <td colspan="6" class="empty-row" style="color: hsl(0, 85%, 65%);">
          데이터를 로드하지 못했습니다. 수집 파이프라인(node index.js)을 먼저 실행해 주세요.
        </td>
      </tr>
    `;
  }
});

// Naver Maps 인스턴스 초기화 함수
function initMap() {
  if (typeof naver === "undefined" || typeof naver.maps === "undefined") {
    console.warn("[NAVER MAP WARNING] 네이버 지도 SDK 객체(naver.maps)가 로드되지 않았습니다. 100ms 후 재시도합니다.");
    setTimeout(initMap, 100);
    return;
  }
  
  try {
    const defaultCenter = new naver.maps.LatLng(37.5665, 126.9780); // 서울시청 중심
    
    map = new naver.maps.Map("map", {
      center: defaultCenter,
      zoom: 15,
      zoomControl: true,
      zoomControlOptions: {
        position: naver.maps.Position.TOP_RIGHT
      }
    });

    marker = new naver.maps.Marker({
      position: defaultCenter,
      map: map,
      title: "아파트 단지 위치"
    });
  } catch (err) {
    console.error("[NAVER MAP INIT ERROR] 네이버 지도 객체 생성에 실패했습니다:", err.message);
  }
}

// 수집된 실거래 데이터 내 날짜 분포를 분석하여 Flatpickr 설정
function initDatePickerRange() {
  let minTime = Infinity;
  let maxTime = -Infinity;
  let minStr = "2020-01-01";
  let maxStr = "2026-07-01";
  
  rawData.forEach(item => {
    if (item.deals && item.deals.length > 0) {
      item.deals.forEach(d => {
        const timeVal = d.year * 100 + d.month;
        if (timeVal < minTime) {
          minTime = timeVal;
          minStr = `${d.year}-${String(d.month).padStart(2, "0")}-01`;
        }
        if (timeVal > maxTime) {
          maxTime = timeVal;
          maxStr = `${d.year}-${String(d.month).padStart(2, "0")}-01`;
        }
      });
    }
  });

  // 기본 조회 기간: 데이터가 있는 가장 최근 월부터 1년 전까지(그 달 포함 12개월)
  const maxYear = Math.floor(maxTime / 100);
  const maxMonth = maxTime % 100;

  let startYear = maxYear;
  let startMonth = maxMonth - 11;
  if (startMonth <= 0) {
    startYear -= 1;
    startMonth += 12;
  }

  const defaultStart = `${startYear}-${String(startMonth).padStart(2, "0")}-01`;
  const defaultEnd = `${maxYear}-${String(maxMonth).padStart(2, "0")}-01`;

  // localStorage 캐싱 확인. 키에 버전을 붙여, 예전 기본값(최근 6개월)이 저장돼 있던
  // 브라우저에서도 새 기본값(최근 12개월)이 한 번은 적용되게 합니다.
  const savedStart = localStorage.getItem("startMonth_v2");
  const savedEnd = localStorage.getItem("endMonth_v2");

  // Flatpickr 달력 초기화 및 바인딩
  flatpickr("#startMonth", {
    locale: "ko",
    dateFormat: "Y년 m월 d일",
    defaultDate: savedStart || defaultStart,
    minDate: minStr,
    maxDate: maxStr
  });

  flatpickr("#endMonth", {
    locale: "ko",
    dateFormat: "Y년 m월 d일",
    defaultDate: savedEnd || defaultEnd,
    minDate: minStr,
    maxDate: maxStr
  });
}

function initDashboard() {
  const guSelect = document.getElementById("guSelect");
  const dongSelect = document.getElementById("dongSelect");
  const aptSelect = document.getElementById("aptSelect");
  const aptSearch = document.getElementById("aptSearch");
  const startMonthInput = document.getElementById("startMonth");
  const endMonthInput = document.getElementById("endMonth");

  // 1. 고유 구 목록 추출
  const uniqueGus = Array.from(new Set(rawData.map(item => item.gu_name).filter(Boolean))).sort();
  
  if (uniqueGus.length === 0) {
    guSelect.innerHTML = `<option value="">구 없음</option>`;
    dongSelect.innerHTML = `<option value="">동 없음</option>`;
    aptSelect.innerHTML = `<option value="">단지 없음</option>`;
    return;
  }

  // 구 셀렉트 옵션 로드
  guSelect.innerHTML = uniqueGus.map(gu => `<option value="${gu}">${gu}</option>`).join("");

  // rawData 행 목록(평형별로 여러 행)에서 단지 단위(apt_key)로 중복 제거한 목록을 만듭니다.
  // 서로 다른 실제 건물이 같은 이름을 쓰는 경우(예: "삼성"이 서울에만 22곳)가 있어,
  // 같은 이름이 여러 개면 드롭다운 표시 텍스트에 지번을 덧붙여 구분합니다.
  // showDong=true(단지명 검색처럼 여러 동에 걸친 목록)면 단지명 앞에 동을 붙입니다.
  // 대부분의 사용자는 지번을 모르므로, 같은 이름을 구분하는 1차 기준을 동으로 삼고
  // (예: "방화동 한진해모로"), 같은 동에 동명 단지가 또 있을 때만 지번을 덧붙입니다.
  function getUniqueApts(items, showDong = false) {
    const seen = new Map();
    for (const item of items) {
      if (!seen.has(item.apt_key)) {
        seen.set(item.apt_key, {
          apt_key: item.apt_key,
          apt_name: item.apt_name,
          dong_name: item.dong_name || "",
          jibun: item.jibun || ""
        });
      }
    }
    const list = Array.from(seen.values());

    if (showDong) {
      // "동 + 단지명"이 같은 것끼리만 지번으로 다시 구분합니다.
      const dongNameCounts = new Map();
      for (const it of list) {
        const key = `${it.dong_name}|${it.apt_name}`;
        dongNameCounts.set(key, (dongNameCounts.get(key) || 0) + 1);
      }
      for (const it of list) {
        const base = it.dong_name ? `${it.dong_name} ${it.apt_name}` : it.apt_name;
        it.label = dongNameCounts.get(`${it.dong_name}|${it.apt_name}`) > 1 ? `${base} (${it.jibun})` : base;
      }
    } else {
      // 구/동이 이미 고정된 드롭다운: 동 접두사는 중복이라 생략하고 동명끼리만 지번으로 구분.
      const nameCounts = new Map();
      for (const it of list) nameCounts.set(it.apt_name, (nameCounts.get(it.apt_name) || 0) + 1);
      for (const it of list) {
        it.label = nameCounts.get(it.apt_name) > 1 ? `${it.apt_name} (${it.jibun})` : it.apt_name;
      }
    }

    list.sort((a, b) => a.label.localeCompare(b.label, "ko"));
    return list;
  }

  // 선택된 단지(apt_key)의 실제 구/동으로 상위 셀렉트를 맞춥니다. 검색 결과나
  // 단지 드롭다운에서 다른 구/동의 단지를 고르면 상단 선택창이 그대로여서 혼동되던 문제
  // 해결용입니다. aptSelect 옵션은 건드리지 않습니다(현재 목록을 유지).
  function syncGuDongToApt(aptKey) {
    const info = rawData.find(item => item.apt_key === aptKey);
    if (!info) return;
    guSelect.value = info.gu_name;
    const dongs = Array.from(new Set(
      rawData.filter(item => item.gu_name === info.gu_name).map(item => item.dong_name).filter(Boolean)
    )).sort();
    dongSelect.innerHTML = dongs.map(dong => `<option value="${dong}">${dong}</option>`).join("");
    dongSelect.value = info.dong_name;
  }

  // 2단계 계층적 갱신 함수들
  function updateDongOptions(selectedGu) {
    const dongs = Array.from(new Set(
      rawData.filter(item => item.gu_name === selectedGu).map(item => item.dong_name).filter(Boolean)
    )).sort();
    
    dongSelect.innerHTML = dongs.map(dong => `<option value="${dong}">${dong}</option>`).join("");
    if (dongs.length > 0) {
      updateAptOptions(selectedGu, dongs[0]);
    }
  }

  function updateAptOptions(selectedGu, selectedDong) {
    const apts = getUniqueApts(
      rawData.filter(item => item.gu_name === selectedGu && item.dong_name === selectedDong)
    );

    aptSelect.innerHTML = apts.map(apt => `<option value="${apt.apt_key}">${apt.label}</option>`).join("");
    if (apts.length > 0) {
      selectedApt = apts[0].apt_key;
      renderAptDashboard(selectedApt);
    }
  }

  // 3. 셀렉트 박스 체인지 이벤트 바인딩
  guSelect.addEventListener("change", (e) => {
    updateDongOptions(e.target.value);
  });

  dongSelect.addEventListener("change", (e) => {
    updateAptOptions(guSelect.value, e.target.value);
  });

  aptSelect.addEventListener("change", (e) => {
    selectedApt = e.target.value;
    // 검색 결과처럼 다른 구/동의 단지를 드롭다운에서 고른 경우에도 상단 구/동을 맞춥니다.
    syncGuDongToApt(selectedApt);
    renderAptDashboard(selectedApt);
  });

  // [설정] 버튼 클릭 시에만 수동으로 대시보드 렌더링 갱신 및 localStorage 보존
  const btnApplyDate = document.getElementById("btnApplyDate");
  if (btnApplyDate) {
    btnApplyDate.addEventListener("click", () => {
      const startVal = startMonthInput.value;
      const endVal = endMonthInput.value;
      
      if (startVal && endVal) {
        localStorage.setItem("startMonth_v2", startVal);
        localStorage.setItem("endMonth_v2", endVal);
      }
      renderAptDashboard(selectedApt);
    });
  }

  // 실시간 텍스트 검색 필터
  aptSearch.addEventListener("input", (e) => {
    const keyword = e.target.value.toLowerCase().trim();
    if (!keyword) {
      // 검색어가 비어 있으면 현재 구/동 선택값 기준으로 복원
      updateAptOptions(guSelect.value, dongSelect.value);
      return;
    }

    // 구/동에 구애받지 않고 아파트명 포함 조건으로 전체 검색 - 여러 동에 걸치므로 동 접두사 표시
    const matchedApts = rawData.filter(item => item.apt_name.toLowerCase().includes(keyword));
    const uniqueMatched = getUniqueApts(matchedApts, true);

    if (uniqueMatched.length > 0) {
      aptSelect.innerHTML = uniqueMatched.map(apt => `<option value="${apt.apt_key}">${apt.label}</option>`).join("");
      selectedApt = uniqueMatched[0].apt_key;

      // 검색으로 매칭된 첫 단지의 실제 구/동으로 상위 드롭다운 동기화
      syncGuDongToApt(selectedApt);

      renderAptDashboard(selectedApt);
    } else {
      aptSelect.innerHTML = `<option value="">검색 결과 없음</option>`;
      document.getElementById("tableBody").innerHTML = `<tr><td colspan="6" class="empty-row">검색 조건에 맞는 아파트가 없습니다.</td></tr>`;
    }
  });

  // 초기 구/동/단지 로드 트리거
  updateDongOptions(guSelect.value);

  // 테이블 정렬 이벤트 바인딩
  const headers = document.querySelectorAll(".data-table th.sortable");
  headers.forEach(header => {
    header.addEventListener("click", () => {
      const sortKey = header.getAttribute("data-sort");
      if (currentSort.key === sortKey) {
        currentSort.direction *= -1;
      } else {
        currentSort.key = sortKey;
        currentSort.direction = 1;
      }
      renderTable(selectedApt);
    });
  });
}

// Flatpickr 한국어 포맷("2026년 07월 01일") 또는 "2026-07" 포맷에서 연/월 정수를 추출하는 헬퍼 함수
function parseFlatpickrDateToYearMonth(val) {
  if (!val) return { y: 2026, m: 7, val: 202607 };
  
  const matches = val.match(/\d+/g);
  if (matches && matches.length >= 2) {
    const y = parseInt(matches[0], 10);
    const m = parseInt(matches[1], 10);
    return { y, m, val: y * 100 + m };
  }
  
  if (val.includes("-")) {
    const parts = val.split("-").map(Number);
    return { y: parts[0], m: parts[1], val: parts[0] * 100 + parts[1] };
  }
  
  return { y: 2026, m: 7, val: 202607 };
}

// 시작월과 종료월 기간 숫자로 파싱 및 개월 수(N) 연산
function getParsedMonths() {
  const startMonthStr = document.getElementById("startMonth").value;
  const endMonthStr = document.getElementById("endMonth").value;
  
  const start = parseFlatpickrDateToYearMonth(startMonthStr);
  const end = parseFlatpickrDateToYearMonth(endMonthStr);
  
  const monthsCount = (end.y - start.y) * 12 + (end.m - start.m) + 1;
  
  return {
    startVal: start.val,
    endVal: end.val,
    monthsCount: monthsCount > 0 ? monthsCount : 1
  };
}

// 특정 단지 정보 대시보드 및 기간 검색 동적 렌더링
// options.skipLiveRefresh: 라이브 실거래 병합 후 재렌더링할 때 무한 재조회를 막기 위한 내부 플래그
function renderAptDashboard(aptKey, options = {}) {
  if (!aptKey) return;

  // apt_key(주소 기반 유일 식별자)로 필터링합니다. apt_name만으로 필터링하면
  // 서로 다른 실제 건물이 같은 이름을 쓰는 경우(예: "삼성"이 서울에만 22곳) 데이터가
  // 섞이므로, index.js/processor.js에서 만든 유일 키를 그대로 사용합니다.
  const rawAptData = rawData.filter(item => item.apt_key === aptKey);
  const { startVal, endVal, monthsCount } = getParsedMonths();

  // 회전율은 조회 기간 길이에 따라 값이 달라지므로, 어떤 기간을 본 결과인지 부제에 밝힙니다.
  const formatMonthVal = (val) => `${Math.floor(val / 100)}년 ${String(val % 100).padStart(2, "0")}월`;
  setElementText(
    "chartPeriodSubtitle",
    `${formatMonthVal(startVal)} ~ ${formatMonthVal(endVal)} (${monthsCount}개월) · 공급면적대별 회전율(%)과 거래량(건)`
  );

  // 기간 검색 조건에 맞게 실시간 데이터 리사이징 (Recalculation)
  const filteredAptData = rawAptData.map(item => {
    const deals = item.deals || [];
    
    // 지정된 월 범위 내의 거래 건들만 필터링
    const filteredDeals = deals.filter(d => {
      const dealVal = d.year * 100 + d.month;
      return dealVal >= startVal && dealVal <= endVal;
    });

    const tradeCount = filteredDeals.length;
    const genCount = item.generation_count || 1;
    
    const turnoverRate = (tradeCount / genCount) * 100;
    const annualizedRate = turnoverRate * (12 / monthsCount);

    const amounts = filteredDeals.map(d => d.amount);
    let avgAmount = 0;
    let minAmount = 0;
    let maxAmount = 0;

    if (amounts.length > 0) {
      const sum = amounts.reduce((acc, curr) => acc + curr, 0);
      avgAmount = Math.round(sum / amounts.length);
      minAmount = Math.min(...amounts);
      maxAmount = Math.max(...amounts);
    }

    return {
      ...item,
      trade_count: tradeCount,
      turnover_rate: parseFloat(turnoverRate.toFixed(4)),
      annualized_rate: parseFloat(annualizedRate.toFixed(4)),
      avg_deal_amount: avgAmount,
      min_deal_amount: minAmount,
      max_deal_amount: maxAmount,
      deals: filteredDeals
    };
  });
  
  // KPI 카드 갱신
  let totalGen = 0;
  let totalRentalGen = 0;
  let totalTrades = 0;
  let totalTurnoverRate = 0;

  filteredAptData.forEach(item => {
    totalGen += item.generation_count;
    if (item.is_rental_suspected) totalRentalGen += item.generation_count;
    totalTrades += item.trade_count;
  });

  if (totalGen > 0) {
    totalTurnoverRate = (totalTrades / totalGen) * 100;
  }

  const totalAnnualizedRate = totalTurnoverRate * (12 / monthsCount);

  const registryStatus = registryStatusByApt.get(aptKey);
  const registryMissingBadgeHtml = registryStatus === "not_found"
    ? `<span class="units-source-badge units-registry-missing" title="국토교통부 건축물대장 전유부(등기 원본)에서 이 단지의 세대 정보를 찾지 못했습니다 - 등기가 아직 완료되지 않았을 가능성이 있습니다. 총세대수는 청약홈 분양정보 등 다른 자료로 보완한 값입니다.">⚠️ 등기 미완료</span>`
    : registryStatus === "unresolvable"
      ? `<span class="units-source-badge units-registry-missing" title="주소를 해석할 수 없어 등기 원본을 조회하지 못했습니다. 총세대수는 청약홈 분양정보 등 다른 자료로 보완한 값입니다.">⚠️ 등기 조회 불가</span>`
      : "";

  document.getElementById("kpiTotalGen").innerHTML = totalGen.toLocaleString() + " 세대" + registryMissingBadgeHtml;
  // 임대 추정 세대가 섞여 있을 때만 일반/임대 내역을 나눠 보여줍니다(대부분의 단지는
  // 임대 추정 세대가 아예 없어 총세대수와 중복 표시될 뿐이라 굳이 보여주지 않음).
  const kpiGenBreakdown = document.getElementById("kpiGenBreakdown");
  if (totalRentalGen > 0) {
    document.getElementById("kpiRegularGen").textContent = (totalGen - totalRentalGen).toLocaleString() + "세대";
    document.getElementById("kpiRentalGen").textContent = totalRentalGen.toLocaleString() + "세대";
    kpiGenBreakdown.hidden = false;
  } else {
    kpiGenBreakdown.hidden = true;
  }
  renderRegistryProgress(aptKey);
  document.getElementById("kpiTotalTrades").textContent = totalTrades.toLocaleString() + " 건";
  document.getElementById("kpiAvgRate").innerHTML = `
    ${totalTurnoverRate.toFixed(4)} %
    <span style="font-size: 0.8rem; font-weight: normal; color: rgba(229, 231, 235, 0.6); display: block; margin-top: 4px;">
      (연 환산: ${totalAnnualizedRate.toFixed(2)}%)
    </span>
  `;
  
  // 단지 상세 제원 표 렌더링 & Naver Maps 실시간 핀 연동
  const firstItem = filteredAptData[0];
  if (firstItem) {
    document.getElementById("detAptName").textContent = firstItem.apt_name || "-";
    document.getElementById("detAdres").textContent = firstItem.adres || "정보 없음";
    document.getElementById("detTotalUnits").innerHTML = totalGen.toLocaleString() + " 세대" + registryMissingBadgeHtml;

    // kaptCode/난방방식/복도유형/최고층수/준공일자/시공사/주차대수/연락처는 이제
    // 파이프라인(index.js)이 K-apt 공식 "단지 기본정보" 파일(kapt_basic_info.json)과
    // 미리 매칭해 turnover_results.json에 실어 보내므로, 브라우저에서 별도 API를
    // 호출할 필요 없이 바로 표시할 수 있습니다. (이전에 쓰던 AptListService3/
    // AptBasisInfoServiceV4 라이브 조회는 AptListService3가 상시 0건만 반환하는
    // 문제가 있어 이 파일 기반 매칭으로 대체했습니다.)
    document.getElementById("detKaptCode").textContent = firstItem.kapt_code || "정보 없음";
    document.getElementById("detHeatType").textContent = firstItem.heat_type || "정보 없음";
    document.getElementById("detCorridorType").textContent = firstItem.corridor_type || "정보 없음";

    const dCnt = firstItem.dong_cnt || 0;
    const fMax = firstItem.floor_cnt_max || 0;
    document.getElementById("detDongFloor").textContent =
      (dCnt > 0 || fMax > 0) ? `${dCnt || "-"}개 동 / 최고 ${fMax || "-"}층` : "정보 없음";

    // 준공일자: K-apt 파일의 useDate가 더 정확하므로 우선 사용하고, 없으면 REB의
    // useapr_dt(사용승인일)로 대체합니다.
    const competDe = formatYyyymmddDash(firstItem.useapr_dt);
    document.getElementById("detCompetDe").textContent = competDe || "정보 없음";

    if (firstItem.builder) setElementText("detBuilder", firstItem.builder);
    else setElementText("detBuilder", "정보 없음");

    // 건폐율/용적률: 국토교통부 건축HUB_건축물대장정보 서비스 매칭 결과(index.js에서 미리 조회).
    // 지번 불일치 등으로 매칭 실패한 단지는 0으로 채워져 "정보 없음"으로 표시됩니다.
    const bcRat = firstItem.bc_rat || 0;
    const vlRat = firstItem.vl_rat || 0;
    setElementText("detBuildingRates",
      (bcRat > 0 || vlRat > 0) ? `${bcRat || "-"}% / ${vlRat || "-"}%` : "정보 없음");

    if (firstItem.office_tel) setElementText("detTel", firstItem.office_tel);
    else setElementText("detTel", "정보 없음");

    const totalParking = firstItem.total_parking || 0;
    if (totalParking > 0) {
      setElementText("detTotalParking", totalParking.toLocaleString());
      setElementText("detParkingPerGen", totalGen > 0 ? (totalParking / totalGen).toFixed(2) : "-");
    } else {
      setElementText("detTotalParking", "-");
      setElementText("detParkingPerGen", "-");
    }

    // Naver Geocoder 실시간 핀 연동
    const address = firstItem.adres;
    if (address) {
      if (typeof naver === "undefined" || !naver.maps || !naver.maps.Service || !naver.maps.Service.geocode) {
        console.error("[NAVER MAP SERVICE ERROR] 네이버 Geocode 서비스 서브모듈을 찾을 수 없습니다.");
      } else {
        // 이 요청의 순번을 찍어두고, 응답이 왔을 때 그사이 더 최신 요청이 나가지 않았는지
        // 확인합니다. 더 최신 요청이 있었다면(단지를 빠르게 전환한 경우) 이 응답은 낡은
        // 결과이므로 버립니다 - 응답 도착 순서가 요청 순서와 같다는 보장이 없기 때문입니다.
        const geocodeSeq = ++mapGeocodeSeq;
        naver.maps.Service.geocode({ query: address }, (status, response) => {
          if (geocodeSeq !== mapGeocodeSeq) return; // 더 최신 단지로 이미 넘어감 - 낡은 응답 폐기

          if (status !== naver.maps.Service.Status.OK) {
            console.error(`[NAVER GEOCODE ERROR] 주소 변환 API 호출 실패: ${address}, Status: ${status}`);
            return;
          }

          const addresses = response.v2.addresses;
          if (!addresses || addresses.length === 0) {
            console.warn(`[NAVER GEOCODE WARNING] 주소에 해당하는 매핑 좌표가 없습니다: ${address}`);
            return;
          }

          try {
            const result = addresses[0];
            const loc = new naver.maps.LatLng(result.y, result.x);
            map.setCenter(loc);
            map.setZoom(16);
            marker.setPosition(loc);
          } catch (err) {
            console.error("[NAVER MAP UPDATE ERROR] 지도 핀 이동 중 런타임 예외 발생:", err.message);
          }
        });
      }
    }

    // R-ONE 거시 시장 통계 차트 렌더링 호출
    if (firstItem.gu_name) {
      renderROneStatsChart(firstItem.gu_name);
    }

    // 관리비(전기/수도/급탕/난방/가스) 조회 기동. kaptCode는 index.js가 K-apt 파일과
    // 이미 매칭해둔 값으로, 평형별 세대당 환산의 분모(단지 전체 면적 지분)도 이 코드로 묶습니다.
    loadMolitData(firstItem.kapt_code || "");
  }

  // 차트 및 테이블 최종 시각화 반영
  renderChart(filteredAptData);
  // 산점도는 메인 "분석 기간"이 아니라 자체 기간 버튼(1/3/5/7/10년/전체)을 쓰므로
  // 기간으로 잘리지 않은 rawAptData(단지 전체 deals)를 그대로 넘깁니다.
  renderPriceScatterChart(rawAptData);
  renderTableData(filteredAptData);

  // 국토부 실거래가 신고기한(30일) 때문에 최근 몇 개월치는 정적 데이터(turnover_results.json)
  // 생성 시점 이후로도 계속 갱신됩니다. 배치 파이프라인 재실행을 기다리지 않고, 이 단지를
  // 조회하는 시점에 그 구의 최근 실거래를 라이브로 재조회해 최신 상태로 맞춥니다.
  if (!options.skipLiveRefresh) {
    refreshLiveTradesForApt(aptKey);
  }

  // 건축물대장 전유부(등기 원본) 기준 정확한 평형별 세대수를 온디맨드로 조회합니다.
  // 서버가 미리 전체 단지를 조회해두지 않으므로, 사용자가 실제로 이 단지를 열어본
  // 시점에 백그라운드로 호출하고 - 결과가 오면 화면을 다시 그립니다. 청약홈보다
  // 신뢰도가 높은 소스이므로(조합원 분양분 포함, 등기 원본) 도착하면 기존 추정치/
  // 청약홈 값을 덮어씁니다.
  refineUnitCountsFromRegistry(aptKey);
}

// 이번 세션에서 조회가 "확정"(성공 매칭 또는 서버가 정상 응답한 not_found)된 apt_key만
// 저장합니다 - 재요청해도 결과가 달라지지 않는 경우에만 재요청을 막기 위함입니다.
const unitTypesRequested = new Set();
// 현재 요청이 진행 중인 apt_key - 같은 단지를 짧은 시간에 여러 번 열었을 때 중복
// 동시 요청만 막는 용도입니다(완료되면 바로 제거되어 실패 시 다음 조회에서 재시도됨).
const unitTypesInFlight = new Set();

// 조회 중인 apt_key의 진척도(서버 폴링 결과). aptKey -> { loaded, total }
const registryProgressByApt = new Map();

// 등기(건축물대장 전유부) 조회의 최종 상태. aptKey -> "not_found" | "unresolvable"
// 둘 다 이 단지의 등기 원본으로는 세대수를 확인할 수 없다는 뜻이라, 총세대수 옆에
// "등기 미완료" 표시를 붙이는 데 씁니다("ok"/진행 중/미조회는 기록하지 않음 - 정상이거나
// 아직 판단할 근거가 없는 상태이므로 표시할 것이 없습니다).
const registryStatusByApt = new Map();
const REGISTRY_PROGRESS_POLL_MS = 400;

// 진행률 바를 현재 선택 단지 기준으로 갱신합니다. 조회 중이 아니면 감춥니다.
function renderRegistryProgress(aptKey) {
  const box = document.getElementById("registryProgress");
  const fill = document.getElementById("registryProgressFill");
  const pct = document.getElementById("registryProgressPct");
  const label = document.getElementById("registryProgressLabel");
  if (!box || !fill || !pct || !label) return;

  if (!unitTypesInFlight.has(aptKey)) {
    box.hidden = true;
    return;
  }

  box.hidden = false;
  const progress = registryProgressByApt.get(aptKey);

  // 첫 페이지 응답 전에는 전체 건수(totalCount)를 알 수 없어 퍼센트를 낼 수 없습니다.
  // 이 구간에서는 '불확정' 상태로 바를 흐르게 두고, 퍼센트 대신 안내 문구만 보여줍니다.
  if (!progress || !progress.total) {
    box.classList.add("indeterminate");
    fill.style.width = "100%";
    pct.textContent = "";
    label.textContent = "등기 원본 조회를 시작하는 중…";
    return;
  }

  box.classList.remove("indeterminate");
  const ratio = Math.min(1, progress.loaded / progress.total);
  fill.style.width = `${(ratio * 100).toFixed(1)}%`;
  pct.textContent = `${Math.floor(ratio * 100)}%`;
  label.textContent = `등기 원본 조회 중… ${progress.loaded.toLocaleString()} / ${progress.total.toLocaleString()}건`;
}

// 조회가 끝날 때까지 서버의 진척도를 짧은 주기로 폴링합니다. 화면 전체를 다시 그리지 않고
// 진행률 바만 갱신해(renderRegistryProgress) 차트/지도가 매번 재렌더되는 것을 피합니다.
async function pollRegistryProgress(aptKey) {
  while (unitTypesInFlight.has(aptKey)) {
    try {
      const res = await fetch(`/api/unit-types-progress?aptKey=${encodeURIComponent(aptKey)}`);
      const json = await res.json();
      if (json.status === "fetching") {
        registryProgressByApt.set(aptKey, { loaded: json.loaded, total: json.total });
      } else if (json.status === "idle") {
        // 페이지 수신은 끝났고 서버가 집계 중인 구간입니다. 바가 중간에 멈춘 채로 보이지
        // 않도록 100%로 채워 마무리합니다(응답이 도착하면 바 자체가 사라집니다).
        const seen = registryProgressByApt.get(aptKey);
        if (seen && seen.total) registryProgressByApt.set(aptKey, { loaded: seen.total, total: seen.total });
      }
    } catch {
      // 폴링 실패는 무시합니다 - 본 조회(/api/unit-types)가 진행/실패를 최종 판단합니다.
    }
    if (selectedApt === aptKey) renderRegistryProgress(aptKey);
    await new Promise(resolve => setTimeout(resolve, REGISTRY_PROGRESS_POLL_MS));
  }
}

// 현재도 같은 단지를 보고 있는 경우에만 화면을 다시 그립니다(그 사이 다른 단지로
// 이동했다면 다시 그릴 필요가 없음). 조회 시작 시(진행률 바 표시)와 종료 시(성공/실패
// 무관하게 진행률 바 해제) 양쪽에서 공용으로 씁니다.
function rerenderIfStillSelected(aptKey) {
  if (selectedApt === aptKey) {
    renderAptDashboard(aptKey);
  }
}

// 등기(건축물대장)에는 있지만 거래 이력이 없어 화면에 없던 평형을 새 행으로 추가하기 전,
// 어떤 평형 조합이 "진짜 이 단지 소속"인지 공식 총세대수와 교차검증합니다.
//
// 왜 필요한가: 건축물대장은 '그 지번 위의 모든 건물' 원본이라, 같은 지번에 등기돼 있지만
// 분양단지가 아닌 별도 건물이 섞여 옵니다. 실례로 하왕십리 한진해모로(1050번지)는
// 101~103동 246세대(K-apt 공식)와 별개로 104동(원룸 27.27㎡ 116호, 등기 용도도 '아파트',
// 재개발 임대동으로 추정, 79개월간 매매 0건)이 같은 지번에 있습니다. 용도 필터로는 거를 수
// 없어, "기존 행 총세대수(K-apt/부동산원 기준) - 등기 매칭분"의 잔여분과 정확히 맞아
// 떨어지는 평형 조합만 추가합니다. 한진해모로: 잔여 66 = 59.76㎡×66 ✓ / 27.27㎡×116 ✗.
//
// 반환: 추가해도 되는 평형 배열. 검증 불가하면 빈 배열(추가 안 함이 기본값 - 세대수를
// 맞추겠다고 임의 데이터를 넣지 않습니다).
function pickAddableUnmatchedTypes(unmatched, referenceTotal, matchedTotal) {
  if (unmatched.length === 0) return [];

  // 기준 총세대수가 없거나(0) 이미 매칭분이 기준을 넘으면 어떤 추가도 정당화할 수 없습니다.
  const gap = referenceTotal - matchedTotal;
  if (referenceTotal <= 0 || gap <= 0) return [];

  // 남은 평형 전부를 더해도 기준에 못 미치면: 등기가 공식 총수보다 적게 담고 있는 경우라
  // 전부 추가해도 과대계상이 아닙니다(예: 기준이 K-apt인데 등기 일부 누락).
  const sumAll = unmatched.reduce((s, a) => s + a.unitCount, 0);
  if (matchedTotal + sumAll <= referenceTotal) return unmatched;

  // 부분집합 탐색: 잔여분(gap)과 정확히(±2세대 허용) 일치하는 조합을 찾습니다.
  // 평형 종류는 많아야 십수 개라 전수 탐색으로 충분합니다(상한 15개 안전장치).
  const candidates = unmatched.slice(0, 15);
  let best = null;
  let bestDiff = Infinity;
  const n = candidates.length;
  for (let mask = 1; mask < (1 << n); mask++) {
    let sum = 0;
    for (let i = 0; i < n; i++) if (mask & (1 << i)) sum += candidates[i].unitCount;
    const diff = Math.abs(sum - gap);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = mask;
    }
  }
  const TOLERANCE_UNITS = 2;
  if (best === null || bestDiff > TOLERANCE_UNITS) return [];

  const picked = [];
  for (let i = 0; i < n; i++) if (best & (1 << i)) picked.push(candidates[i]);
  return picked;
}

async function refineUnitCountsFromRegistry(aptKey) {
  if (unitTypesRequested.has(aptKey) || unitTypesInFlight.has(aptKey)) return;
  unitTypesInFlight.add(aptKey);
  registryProgressByApt.delete(aptKey); // 이전 조회의 잔여 진척도가 잠깐 보이지 않도록
  rerenderIfStillSelected(aptKey); // 진행률 바를 즉시 표시
  pollRegistryProgress(aptKey); // 백그라운드 폴링 시작 (await하지 않음)

  // K-apt/REB 공식 총세대수를 요청 전에 미리 계산해 서버로 함께 보냅니다. 같은 지번을
  // 여러 단지가 공유할 때(아래 dongFiltered 처리 참고) 서버가 이 값과 표제부 동번호
  // 구간을 대조해 이 단지 몫의 동(棟)만 걸러낼 수 있도록 하기 위함입니다.
  const aptRows = rawData.filter(item => item.apt_key === aptKey);
  const officialTotal = aptRows.reduce((s, item) => s + (Number(item.generation_count) || 0), 0);

  let result;
  try {
    const res = await fetch(`/api/unit-types?aptKey=${encodeURIComponent(aptKey)}&officialTotal=${officialTotal}`);
    result = await res.json();
  } catch (err) {
    console.warn(`[전유공용면적 조회 실패] ${aptKey}:`, err.message);
    unitTypesInFlight.delete(aptKey);
    registryProgressByApt.delete(aptKey);
    rerenderIfStillSelected(aptKey); // 로딩 배지 해제
    return; // 네트워크 오류 - unitTypesRequested에 추가하지 않아 다음에 다시 열면 재시도됩니다.
  }
  unitTypesInFlight.delete(aptKey);
  registryProgressByApt.delete(aptKey);

  if (!result || result.status !== "ok" || !Array.isArray(result.areas) || result.areas.length === 0) {
    if (result && result.status === "error") {
      // 대단지 타임아웃/일시적 오류 등 - 서버도 이 상태는 캐싱하지 않으므로(재시도하면
      // 성공할 수 있음) 클라이언트도 unitTypesRequested에 추가하지 않고 재시도를 허용합니다.
      console.warn(`[전유공용면적 조회 오류] ${aptKey}: ${result.message} (다음에 다시 열면 재시도됩니다)`);
      rerenderIfStillSelected(aptKey);
      return;
    }
    // status === "not_found"(등기 데이터 자체가 없음) 또는 "unresolvable"(주소를 해석/
    // 조회할 수 없어 애초에 등기 조회가 불가능함) - 둘 다 서버가 영구 캐싱하므로 재시도해도
    // 같은 결과라 더 이상 요청하지 않습니다. 이런 단지는 세대수를 청약홈 분양정보 등
    // 다른 소스로 보완하며, 화면에는 "예상"/"미확인" 배지로 그 출처를 간략히 표시하고,
    // 총세대수 옆에는 "등기 미완료"를 표시해 등기 원본으로는 검증되지 않았음을 알립니다.
    if (result && (result.status === "not_found" || result.status === "unresolvable")) {
      registryStatusByApt.set(aptKey, result.status);
    }
    unitTypesRequested.add(aptKey);
    rerenderIfStillSelected(aptKey);
    return;
  }

  unitTypesRequested.add(aptKey);

  // 정부의 두 등기 시스템(표제부 총괄 hhldCnt vs 전유공용면적 개별 호실 실측)이 같은
  // 단지를 서로 다른 세대수로 등록해둔 경우가 있습니다(실사례: 남산타운 - 표제부
  // 5,150세대 vs 전유부 실측 5,152세대, 표제부/K-apt 기준과 2세대 차이). 아래
  // pickAddableUnmatchedTypes의 ±2세대 오차 허용치 안에 들어오면 조용히 통과되므로,
  // 이 지점에서 원본 수치 차이를 콘솔에 남겨 나중에 추적할 수 있게 합니다. 이 로그는
  // 경고일 뿐 반영 자체를 막지는 않습니다 - 대부분은 아래처럼 government 데이터 자체의
  // 미세한 오차이지 저희 로직 문제가 아닙니다.
  const registryBuildingTotalNum = Number(result.registryBuildingTotal) || 0;
  if (registryBuildingTotalNum > 0 && result.totalUnits !== registryBuildingTotalNum) {
    console.warn(`[등기 총계 불일치] ${aptKey}: 전유부 실측 합계(${result.totalUnits}세대)가 표제부 총괄 합계(${registryBuildingTotalNum}세대)와 ${result.totalUnits - registryBuildingTotalNum}세대 차이납니다 - 정부 등기 시스템 간 원본 데이터 불일치로 추정됩니다.`);
  }

  // 건축HUB 전유공용면적/표제부 API는 단지명이 아니라 "지번" 단위로만 조회되므로,
  // 같은 지번에 서로 무관한 여러 단지가 함께 있으면(실사례: 강남구 개포동 12번지 -
  // 성원대치2단지/삼익대청/SH공사대치1단지 3개 단지가 한 지번을 공유) items 자체가
  // 여러 단지의 호실이 섞여 올 수 있습니다. 서버가 표제부 동번호 구간으로 이 단지
  // 몫만 걸러내는 데 성공하면 result.dongFiltered가 true로 내려오므로 그때만 등기
  // 데이터를 신뢰합니다. 구간을 걸러내지 못했는데(dongFiltered=false) 지번을 여러
  // 단지가 공유하는 경우는 result.areas가 섞인 값일 수 있어 등기 반영을 건너뜁니다.
  if (!result.dongFiltered) {
    const jibunPrefix = aptKey.split(" · ")[0];
    const complexesAtJibun = new Set(
      rawData
        .filter(item => item.apt_key.split(" · ")[0] === jibunPrefix)
        .map(item => item.apt_key)
    );
    if (complexesAtJibun.size > 1) {
      console.warn(`[전유공용면적 반영 건너뜀] ${aptKey}: 같은 지번(${jibunPrefix})을 ${complexesAtJibun.size}개 단지가 공유하는데 동번호 구간으로 분리하지 못했습니다 - K-apt 공식 세대수를 그대로 유지합니다.`);
      rerenderIfStillSelected(aptKey);
      return;
    }
  }

  // 교차검증 기준값. 두 개의 독립 소스 중 더 큰 쪽을 신뢰합니다:
  //  1) K-apt/부동산원 공식 총세대수 - 갱신 전 이 단지 행들의 세대수 합(배치 파이프라인이
  //     평형별로 안분해둔 값이라 합은 곧 "공식 총세대수"). 반드시 아래 매칭 루프가
  //     generation_count를 덮어쓰기 전에 읽어야 합니다.
  //  2) 건축물대장 표제부 총세대수(서버가 계산해 result.registryBuildingTotal로 내려줌) -
  //     그 지번에 등록된 모든 건물(동)의 hhldCnt 합. K-apt는 HOA(입주자대표회의) 관리
  //     대상만 등록하므로, 기타임대동처럼 별도 관리되는 동은 K-apt 총세대수에서 빠지는
  //     경우가 있습니다(한진해모로 104동/116세대 실사례) - 표제부 총계는 이런 동도 포함된
  //     "건축물대장 기준 진짜 총세대수"라 K-apt보다 클 수 있고, 그럴 때는 이쪽을 따릅니다.
  // dongFiltered가 true면 registryBuildingTotal은 이미 이 단지 동(棟)만의 합계이므로
  // 그대로 씁니다(다른 단지분이 섞이지 않음).
  const referenceTotal = Math.max(officialTotal, Number(result.registryBuildingTotal) || 0);

  // rawData 안의 해당 단지 행들을 등기 기준 실제 전용면적과 가장 가까운(0.5㎡ 이내)
  // 값끼리 매칭해 세대수를 덮어씁니다.
  const TOLERANCE = 0.5;
  let updatedCount = 0;
  const matchedRegistryAreas = new Set(); // 이번 루프에서 rawData 행에 매칭된 등기 평형(중복 매칭 방지)
  aptRows.forEach(item => {
    let best = null;
    let bestDiff = TOLERANCE;
    for (const a of result.areas) {
      const diff = Math.abs(a.exclusiveArea - item.exclusive_area);
      if (diff < bestDiff) {
        bestDiff = diff;
        best = a;
      }
    }
    if (best) {
      item.generation_count = best.unitCount;
      item.is_estimated_units = false;
      item.units_source = "registry";
      // 공급면적(전용 + 주거공용)은 건축물대장에만 있는 값이라 이때 처음 채워집니다.
      if (best.supplyArea > 0) item.supply_area = best.supplyArea;
      matchedRegistryAreas.add(best);
      updatedCount++;
    }
  });

  // 등기에는 존재하지만 조회 기간 내 실거래가 없어 화면에 행이 없던 평형의 처리.
  // 무조건 추가하면 같은 지번의 "단지 밖 건물"(임대동 등, 용도도 '아파트'라 필터 불가)까지
  // 딸려 들어오므로, 공식 총세대수와 잔여분이 맞아떨어지는 조합만 추가합니다
  // (pickAddableUnmatchedTypes 주석 참고 - 한진해모로 104동 사례).
  const matchedTotal = [...matchedRegistryAreas].reduce((s, a) => s + a.unitCount, 0);
  const unmatched = result.areas.filter(a => !matchedRegistryAreas.has(a) && a.unitCount > 0);
  const addable = pickAddableUnmatchedTypes(unmatched, referenceTotal, matchedTotal);

  // "임대 추정" 판정: K-apt 공식 총세대수만으로도 정당화되는 평형(예: 실거래 이력이
  // 우연히 없었을 뿐인 정규 분양 세대)과, 표제부 총세대수까지 동원해야만 정당화되는
  // 평형(=K-apt/HOA 관리 대상 밖 - 실사례로는 기타임대동)을 구분합니다. 같은 unmatched
  // 목록으로 K-apt 총세대수만 기준 삼아 다시 돌려, 그때도 뽑히면 정규 분양분입니다.
  const addableByOfficialOnly = pickAddableUnmatchedTypes(unmatched, officialTotal, matchedTotal);
  const rentalSuspectedAreas = new Set(addable.filter(a => !addableByOfficialOnly.includes(a)));

  const templateRow = aptRows[0];
  let addedCount = 0;
  if (templateRow) {
    addable.forEach(a => {
      rawData.push({
        ...templateRow,
        exclusive_area: a.exclusiveArea,
        supply_area: a.supplyArea > 0 ? a.supplyArea : undefined,
        generation_count: a.unitCount,
        is_estimated_units: false,
        units_source: "registry",
        // K-apt(HOA 관리) 공식 총세대수만으로는 설명되지 않고 건축물대장 표제부
        // 총세대수까지 필요했던 평형만 "임대 추정"으로 표시합니다(아래 rentalSuspectedAreas
        // 계산 참고). 매매 실거래가 자체가 없는 게 일반적이므로(임대주택은 매매 대상이
        // 아님) 확정이 아니라 추정입니다 - 실제로는 관리주체가 다른 별도 분양동일 수도
        // 있어, 화면에도 "추정" 문구와 판정 근거를 함께 보여줍니다.
        is_rental_suspected: rentalSuspectedAreas.has(a),
        unit_type: "",
        trade_count: 0,
        turnover_rate: 0,
        annualized_rate: 0,
        avg_deal_amount: 0,
        min_deal_amount: 0,
        max_deal_amount: 0,
        deals: []
      });
      addedCount++;
    });
  }

  const excluded = unmatched.filter(a => !addable.includes(a));
  if (updatedCount > 0 || addedCount > 0) {
    console.log(`[전유공용면적 반영] ${aptKey}: ${updatedCount}개 평형 세대수 갱신, 거래 이력 없던 ${addedCount}개 평형 신규 추가(교차검증 기준 ${referenceTotal}세대 = max(K-apt ${officialTotal}, 표제부 ${result.registryBuildingTotal || 0}) 통과).`);
  }
  if (excluded.length > 0) {
    const detail = excluded.map(a => `${a.exclusiveArea}㎡×${a.unitCount}세대`).join(", ");
    console.log(`[전유공용면적 제외] ${aptKey}: 같은 지번 등기에는 있으나 공식 총세대수(${referenceTotal}세대)와 교차검증되지 않아 제외 - ${detail} (임대동 등 단지 밖 건물로 추정)`);
  }
  // updatedCount/addedCount가 0이어도(매칭되는 행이 없는 경우 등) 로딩 배지는 반드시 해제해야 합니다.
  rerenderIfStillSelected(aptKey);
}

// R-ONE 거시 시장 통계 선그래프 렌더링 함수
function renderROneStatsChart(guName) {
  const chartCanvas = document.getElementById("roneStatsChart");
  if (!chartCanvas) return;
  const ctx = chartCanvas.getContext("2d");
  
  if (roneChart) {
    roneChart.destroy();
  }

  const guData = roneStatsData[guName] || [];
  const subtitle = document.getElementById("roneStatsSubtitle");
  const errorDiv = document.getElementById("roneStatsError");

  if (guData.length === 0) {
    if (subtitle) {
      subtitle.textContent = "한국부동산원 통계 서버 응답 지연 (데이터 부재)";
    }
    if (chartCanvas) chartCanvas.style.display = "none";
    if (errorDiv) {
      errorDiv.style.display = "flex";
      errorDiv.textContent = `한국부동산원 통계 서버 응답 지연 (${guName} 데이터 부재)`;
    }
    return;
  }

  if (subtitle) {
    subtitle.textContent = `${guName} 아파트 월별 매매거래량 추이 (최근 2개년)`;
  }
  if (chartCanvas) chartCanvas.style.display = "block";
  if (errorDiv) errorDiv.style.display = "none";

  // X축 포맷: 'YY.MM'
  const labels = guData.map(d => `${d.month.substring(2, 4)}.${d.month.substring(4, 6)}`);
  const values = guData.map(d => d.value);

  // 서울시 전체 추이: 25개 자치구 데이터를 월별로 합산합니다(별도 API 호출 없이
  // 이미 로드된 구별 R-ONE 데이터를 그대로 활용). guData와 동일한 월 순서를 기준으로
  // 삼아, 각 월에 해당하는 가구별 값을 찾아 더합니다.
  const seoulTotals = guData.map(d => {
    let sum = 0;
    for (const districtData of Object.values(roneStatsData)) {
      const match = districtData.find(x => x.month === d.month);
      if (match) sum += match.value;
    }
    return sum;
  });

  roneChart = new Chart(ctx, {
    type: "line",
    data: {
      labels: labels,
      datasets: [
        {
          // 서울시 전체 추이 - 해당 구 그래프보다 먼저 그려 뒤쪽에 배치하고,
          // 투명도를 높여 배경처럼 은은하게 보이도록 합니다. 절대 거래량 규모가
          // 훨씬 커서(25개 구 합산) 같은 축을 쓰면 해당 구 선이 눌려 보이므로
          // 보조(오른쪽) y축을 따로 씁니다.
          label: "서울시 전체",
          data: seoulTotals,
          borderColor: "rgba(167, 139, 250, 0.35)",
          backgroundColor: "rgba(167, 139, 250, 0.08)",
          borderWidth: 1.5,
          pointRadius: 0,
          fill: true,
          tension: 0.35,
          yAxisID: "y1",
          order: 2
        },
        {
          label: "해당 구",
          data: values,
          borderColor: "rgba(6, 182, 212, 1)",
          backgroundColor: "rgba(6, 182, 212, 0.15)",
          borderWidth: 2,
          pointBackgroundColor: "rgba(6, 182, 212, 1)",
          pointRadius: 2.5,
          fill: true,
          tension: 0.35,
          yAxisID: "y",
          order: 1
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          display: true,
          labels: {
            color: "#9ca3af",
            font: { size: 10 },
            boxWidth: 12,
            boxHeight: 2
          }
        },
        tooltip: {
          backgroundColor: "rgba(17, 22, 44, 0.95)",
          titleColor: "#f3f4f6",
          bodyColor: "#d1d5db",
          borderColor: "rgba(255, 255, 255, 0.1)",
          borderWidth: 1,
          padding: 10
        }
      },
      scales: {
        x: {
          grid: {
            display: false
          },
          ticks: {
            color: "#9ca3af",
            font: {
              size: 9
            },
            maxTicksLimit: 12
          }
        },
        y: {
          position: "left",
          grid: {
            color: "rgba(255, 255, 255, 0.05)"
          },
          ticks: {
            color: "#9ca3af",
            font: {
              size: 9
            }
          }
        },
        y1: {
          position: "right",
          grid: {
            display: false
          },
          ticks: {
            color: "rgba(167, 139, 250, 0.5)",
            font: {
              size: 9
            }
          }
        }
      }
    }
  });
}

// 회전율 구간 (연 환산 기준). 표의 상태 배지(침체/안정/활발)와 같은 색을 씁니다.
const TURNOVER_BANDS = [
  { key: "low", label: "침체", annualFrom: 0, annualTo: 5, rgb: "59, 130, 246" },
  { key: "stable", label: "안정", annualFrom: 5, annualTo: 10, rgb: "16, 185, 129" },
  { key: "active", label: "활발", annualFrom: 10, annualTo: Infinity, rgb: "239, 68, 68" }
];

function getTurnoverBand(annualRate) {
  return TURNOVER_BANDS.find(band => annualRate < band.annualTo) || TURNOVER_BANDS[TURNOVER_BANDS.length - 1];
}

// 차트 배경에 회전율 구간 띠와 경계선을 그리는 Chart.js 인라인 플러그인.
// beforeDatasetsDraw 시점이라 막대/선 뒤에 깔립니다.
const turnoverBandsPlugin = {
  id: "turnoverBands",
  beforeDatasetsDraw(chart, _args, opts) {
    const yRate = chart.scales.yRate;
    const area = chart.chartArea;
    if (!yRate || !area || !opts?.bands?.length) return;

    const ctx = chart.ctx;
    ctx.save();

    for (const band of opts.bands) {
      const top = yRate.getPixelForValue(Math.min(band.to, yRate.max));
      const bottom = yRate.getPixelForValue(Math.max(band.from, yRate.min));
      if (bottom - top <= 0) continue;

      ctx.fillStyle = `rgba(${band.rgb}, 0.07)`;
      ctx.fillRect(area.left, top, area.right - area.left, bottom - top);

      // 구간 경계선 + 라벨 (차트 상단을 넘어가는 경계는 그리지 않습니다)
      if (band.tickLabel && band.to <= yRate.max) {
        ctx.setLineDash([5, 4]);
        ctx.lineWidth = 1;
        ctx.strokeStyle = `rgba(${band.rgb}, 0.55)`;
        ctx.beginPath();
        ctx.moveTo(area.left, top);
        ctx.lineTo(area.right, top);
        ctx.stroke();
        ctx.setLineDash([]);

        ctx.fillStyle = `rgba(${band.rgb}, 0.95)`;
        ctx.font = "600 10px Outfit, sans-serif";
        ctx.textAlign = "right";
        ctx.textBaseline = "bottom";
        ctx.fillText(band.tickLabel, area.right - 6, top - 2);
      }

      // 띠 이름(침체/안정/활발)은 띠가 충분히 두꺼울 때만 왼쪽에 흐리게 표시합니다.
      if (bottom - top > 26) {
        ctx.fillStyle = `rgba(${band.rgb}, 0.5)`;
        ctx.font = "700 10px Outfit, sans-serif";
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        ctx.fillText(band.label, area.left + 6, (top + bottom) / 2);
      }
    }

    ctx.restore();
  }
};

if (typeof Chart !== "undefined") Chart.register(turnoverBandsPlugin);

// Chart.js 듀얼축 렌더링
function renderChart(aptData) {
  const ctx = document.getElementById("turnoverChart").getContext("2d");

  if (currentChart) {
    currentChart.destroy();
  }

  const sortedData = [...aptData].sort((a, b) => a.exclusive_area - b.exclusive_area);

  // 공급면적(전용+주거공용)이 등기 실측으로 채워진 평형은 공급면적을, 아직 조회 전이라
  // 없는 평형은 전용면적을 그대로 보여줍니다(값이 아예 없는 것보다는 낫습니다).
  const labels = sortedData.map(item => {
    const area = formatArea(item.supply_area > 0 ? item.supply_area : item.exclusive_area);
    return item.is_rental_suspected ? `${area} 🏠` : area; // 임대 추정 평형 표시(표의 배지와 동일 기준)
  });
  const rates = sortedData.map(item => item.turnover_rate);
  const trades = sortedData.map(item => item.trade_count);

  // 5%/10% 기준은 "연간" 회전율 기준인데 이 차트의 막대는 조회 기간(monthsCount개월)
  // 동안의 회전율입니다. 그래서 기준선을 같은 축으로 환산해서 긋습니다.
  // 예: 24개월 조회 시 연 5%는 이 차트에서 10% 위치에 그어집니다.
  const { monthsCount } = getParsedMonths();
  const toPeriodScale = (annual) => annual * (monthsCount / 12);

  const bands = TURNOVER_BANDS.map(band => ({
    rgb: band.rgb,
    label: band.label,
    from: toPeriodScale(band.annualFrom),
    to: band.annualTo === Infinity ? Infinity : toPeriodScale(band.annualTo),
    // 마지막(10%~) 구간은 위쪽 경계가 없어 경계선/라벨을 그리지 않습니다.
    tickLabel: band.annualTo === Infinity ? null : `연 ${band.annualTo}%`
  }));

  // 막대 색도 그 평형이 속한 구간 색으로 칠해, 띠와 막대를 눈으로 바로 맞출 수 있게 합니다.
  const barColors = sortedData.map(item => getTurnoverBand(item.annualized_rate ?? 0).rgb);

  currentChart = new Chart(ctx, {
    type: "bar",
    data: {
      labels: labels,
      datasets: [
        {
          label: "평형별 거래회전율 (%)",
          data: rates,
          backgroundColor: barColors.map(rgb => `rgba(${rgb}, 0.65)`),
          borderColor: barColors.map(rgb => `rgba(${rgb}, 1)`),
          borderWidth: 1.5,
          yAxisID: "yRate",
          borderRadius: 6
        },
        {
          label: "평형별 거래량 (건)",
          data: trades,
          type: "line",
          borderColor: "rgba(6, 182, 212, 1)",
          backgroundColor: "rgba(6, 182, 212, 0.1)",
          borderWidth: 3,
          pointBackgroundColor: "rgba(6, 182, 212, 1)",
          pointRadius: 4,
          tension: 0.3,
          yAxisID: "yTrade"
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: {
        mode: "index",
        intersect: false
      },
      plugins: {
        legend: {
          position: "top",
          labels: {
            color: "#e5e7eb",
            font: { family: "Outfit, sans-serif", size: 12 }
          }
        },
        tooltip: {
          backgroundColor: "rgba(17, 22, 44, 0.95)",
          titleColor: "#f3f4f6",
          bodyColor: "#d1d5db",
          borderColor: "rgba(255, 255, 255, 0.1)",
          borderWidth: 1,
          padding: 12,
          callbacks: {
            // 막대 색의 근거(연 환산 회전율과 그 구간)를 툴팁에서 바로 확인할 수 있게 합니다.
            afterBody: (items) => {
              const item = sortedData[items[0]?.dataIndex];
              if (!item) return "";
              const annual = item.annualized_rate ?? 0;
              return `연 환산: ${annual.toFixed(2)}% (${getTurnoverBand(annual).label})`;
            }
          }
        },
        turnoverBands: { bands }
      },
      scales: {
        x: {
          grid: { color: "rgba(255, 255, 255, 0.05)" },
          ticks: {
            // 평형 라벨 자체도 그 평형이 속한 회전율 구간 색으로 물들입니다(막대 색과 동일
            // 기준). "안정"/"활발" 구간은 굵게 강조해 정상 거래가 되는 평형이 한눈에
            // 띄도록 하고, "침체"는 색만 다르고 굵기는 기본값으로 둡니다.
            color: (ctx) => `rgb(${barColors[ctx.index] || "156, 163, 175"})`,
            font: (ctx) => {
              const bandLabel = getTurnoverBand(sortedData[ctx.index]?.annualized_rate ?? 0).label;
              return {
                family: "Outfit, sans-serif",
                weight: bandLabel === "침체" ? "500" : "800",
                size: 11
              };
            }
          }
        },
        yRate: {
          type: "linear",
          position: "left",
          beginAtZero: true, // 0부터 시작해야 구간 띠(0~5%)가 잘리지 않습니다.
          title: {
            display: true,
            text: "회전율 (%)",
            color: "#9ca3af",
            font: { weight: "bold" }
          },
          grid: { color: "rgba(255, 255, 255, 0.05)" },
          ticks: { color: "#9ca3af" }
        },
        yTrade: {
          type: "linear",
          position: "right",
          title: {
            display: true,
            text: "거래량 (건)",
            color: "rgba(6, 182, 212, 1)",
            font: { weight: "bold" }
          },
          grid: { drawOnChartArea: false },
          ticks: { color: "#9ca3af", stepSize: 1 }
        }
      }
    }
  });
}

// 자치구별 라이브 실거래 재조회 결과의 클라이언트 캐시(구 -> {fetchedAt, months, trades}).
// 서버도 같은 목적의 TTL 캐시를 두고 있지만, 짧은 시간 안에 같은 구를 반복 조회할 때
// 네트워크 왕복 자체를 생략하기 위해 클라이언트에도 둡니다.
const liveTradesCacheByGu = new Map();
const liveTradesInFlightByGu = new Map(); // 같은 구에 대한 동시 중복 호출 합류용
let liveTradesRefreshSeq = 0;

// 특정 구의 최근 실거래를 국토부 API에서 라이브로 재조회합니다(/api/live-trades).
function fetchLiveTradesForGu(guName) {
  const cached = liveTradesCacheByGu.get(guName);
  if (cached && Date.now() - cached.fetchedAt < 5 * 60 * 1000) return Promise.resolve(cached);

  const inFlight = liveTradesInFlightByGu.get(guName);
  if (inFlight) return inFlight;

  const promise = fetchLiveTradesForGuUncached(guName).finally(() => liveTradesInFlightByGu.delete(guName));
  liveTradesInFlightByGu.set(guName, promise);
  return promise;
}

async function fetchLiveTradesForGuUncached(guName) {
  try {
    const response = await fetch(apiUrl(`/api/live-trades?guName=${encodeURIComponent(guName)}`), { cache: "no-store" });
    if (!response.ok) return null;
    const json = await response.json();
    if (json.status !== "ok") return null;
    liveTradesCacheByGu.set(guName, json);
    return json;
  } catch (err) {
    console.warn("[LIVE TRADES WARNING] 실시간 실거래 조회 실패:", err.message);
    return null;
  }
}

// 라이브 조회 결과를 rawData에 병합합니다. 조회 대상 개월(months)에 해당하는 기존
// deals는 정적 스냅샷 시점의 낡은 값일 수 있으므로 버리고 라이브 값으로 교체하며,
// 그보다 오래된(신고가 마감된) deals는 그대로 둡니다.
//
// 주소 키는 processor.js의 buildAddressKey와 같은 형식("시/도 구 동 지번")으로 직접
// 재구성합니다. 다만 같은 지번에 다른 이름의 단지가 여럿 있어 " · 단지명" 접미사가 붙은
// apt_key(index.js의 지번 공유 단지 분리 로직 참고)는 이 단순 재구성으로 매칭되지 않아
// 라이브 갱신이 적용되지 않습니다 - 드문 사례라 정적 데이터로 폴백되는 정도로 둡니다.
function mergeLiveTradesIntoRawData(guName, liveResult) {
  const recentMonthSet = new Set(liveResult.months.map(m => parseInt(m, 10)));
  const freshDealsByKey = new Map(); // "addressKey||areaKey" -> deals[]

  for (const trade of liveResult.trades) {
    if (!trade.dong || !trade.jibun || !trade.apt_name || !(trade.deal_amount > 0)) continue;
    const addressKey = `서울특별시 ${guName} ${trade.dong} ${trade.jibun}`;
    const areaKey = parseFloat(Number(trade.exclusive_area).toFixed(2));
    const mapKey = `${addressKey}||${areaKey}`;
    if (!freshDealsByKey.has(mapKey)) freshDealsByKey.set(mapKey, []);
    freshDealsByKey.get(mapKey).push({ year: trade.deal_year, month: trade.deal_month, day: trade.deal_day, floor: trade.floor, amount: trade.deal_amount });
  }

  rawData.forEach(item => {
    const mapKey = `${item.apt_key}||${item.exclusive_area}`;
    const freshDeals = freshDealsByKey.get(mapKey);
    if (!freshDeals) return;
    const settledDeals = (item.deals || []).filter(d => !recentMonthSet.has(d.year * 100 + d.month));
    item.deals = settledDeals.concat(freshDeals);
  });
}

// 선택된 단지의 소속 구를 기준으로 라이브 재조회를 실행하고, 병합 후 다시 그립니다.
// 사용자가 다른 단지로 빠르게 전환하면(응답이 요청 순서와 다르게 도착할 수 있음) 낡은
// 결과는 버립니다.
async function refreshLiveTradesForApt(aptKey) {
  const item = rawData.find(d => d.apt_key === aptKey);
  if (!item || !item.gu_name) return;

  const seq = ++liveTradesRefreshSeq;
  const liveResult = await fetchLiveTradesForGu(item.gu_name);
  if (!liveResult) return;
  if (seq !== liveTradesRefreshSeq || selectedApt !== aptKey) return; // 그사이 다른 단지로 전환됨

  mergeLiveTradesIntoRawData(item.gu_name, liveResult);
  renderAptDashboard(aptKey, { skipLiveRefresh: true });
}

// HSL -> "r, g, b" 문자열 변환(산점도 팔레트 생성용).
function hslToRgbString(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs((h / 60) % 2 - 1));
  const m = l - c / 2;
  let r, g, b;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return `${Math.round((r + m) * 255)}, ${Math.round((g + m) * 255)}, ${Math.round((b + m) * 255)}`;
}

// 평형(전용면적)별로 산점도의 점 색을 구분하기 위한 32색 팔레트. 색상환을 균등
// 분할하지 않고 황금각(137.508°)만큼씩 건너뛰어 배정해, 면적 오름차순으로 이웃한
// 평형끼리도(자주 같이 비교됨) 색이 비슷해지지 않게 합니다.
const SCATTER_COLOR_PALETTE = Array.from({ length: 32 }, (_, i) => {
  const hue = (i * 137.508) % 360;
  const ring = i % 2; // 링을 번갈아 채도/명도를 달리해 저채도 구간에서도 구분이 되게 함
  return hslToRgbString(hue, ring === 0 ? 0.72 : 0.6, ring === 0 ? 0.56 : 0.45);
});

// 산점도 전용 기간 필터(1/3/5/7/10년/전체). 회전율 계산에 쓰이는 메인 "분석 기간"과는
// 별개로, 가격 흐름만 더 길게/짧게 훑어보기 위한 퀵 선택입니다.
let scatterPeriodYears = 1;
// 기간 버튼을 다시 누를 때 렌더링을 다시 시작하지 않고 재사용하기 위한, 마지막으로
// renderPriceScatterChart에 전달된 원본(비필터) 단지 배열.
let scatterAptData = [];

// 등기 실측 반영 시 사실상 같은 평형이 76.76㎡/76.79㎡처럼 소수점 단위로 여러 개로
// 쪼개져 나타나는 문제를 완화하기 위한 그룹핑 기준. 면적 오름차순으로 인접한 값끼리
// 이 값 이내면 같은 평형으로 묶고, 초과하면 별개 평형으로 분리합니다.
const SCATTER_AREA_GROUP_GAP = 2;
// 산점도에 그려진(면적 오름차순 정렬) 평형 그룹 - 색상 인덱스를 고정하는 기준이자
// 선택칩 렌더링에도 재사용합니다.
let scatterGroups = [];
// 현재 비교 중인 평형 그룹의 key 목록(최대 3개). 단지를 바꾸면 거래량 1위로 초기화됩니다.
let scatterSelectedKeys = [];
// scatterSelectedKeys를 초기화해야 할 시점(단지 전환)을 판단하기 위한 마지막 apt_key.
let scatterGroupsAptKey = null;

// 거래가 있는 평형들을 면적 오름차순으로 훑으며, 이웃과의 간격이
// SCATTER_AREA_GROUP_GAP 이내면 같은 그룹으로 묶습니다(연쇄 병합이라 그룹 전체 폭이
// 기준값을 넘을 수 있지만, 실제 등기 소수점 편차 사례에서는 매우 드뭅니다).
function groupAreasForScatter(aptData) {
  const sorted = [...aptData]
    .filter(item => item.deals && item.deals.length > 0)
    .sort((a, b) => a.exclusive_area - b.exclusive_area);

  const rawGroups = [];
  for (const item of sorted) {
    const last = rawGroups[rawGroups.length - 1];
    const prevArea = last ? last[last.length - 1].exclusive_area : null;
    if (last && item.exclusive_area - prevArea <= SCATTER_AREA_GROUP_GAP) {
      last.push(item);
    } else {
      rawGroups.push([item]);
    }
  }

  return rawGroups.map(members => {
    // 그룹 안에서 거래가 가장 많은 세부 평형을 라벨/색상 기준의 "대표값"으로 씁니다.
    const dominant = members.reduce((best, m) => (m.deals.length > best.deals.length ? m : best), members[0]);
    return {
      key: `${dominant.exclusive_area.toFixed(2)}`,
      repExclusiveArea: dominant.exclusive_area,
      repSupplyArea: dominant.supply_area,
      isRentalSuspected: members.some(m => m.is_rental_suspected),
      deals: members.flatMap(m => m.deals || [])
    };
  });
}

// 산점도 그룹은 비슷한 면적(SCATTER_AREA_GROUP_GAP 이내)을 하나로 합친 것이라, 대표값을
// 소수점까지 그대로 보여주면 "61.7평"처럼 특정 세부 평형만 표시된 것으로 오해할 수 있습니다.
// 그래서 정수 단위로 반올림해 "62평형"처럼 그룹 전체를 아우르는 명칭으로 보여줍니다.
function formatScatterGroupLabel(group) {
  const areaValue = Number(group.repSupplyArea > 0 ? group.repSupplyArea : group.repExclusiveArea);
  if (!areaValue || areaValue <= 0) return "-";
  return areaUnit === "pyeong"
    ? `${Math.round(areaValue / SQM_PER_PYEONG)}평형`
    : `${Math.round(areaValue)}㎡형`;
}

// 산점도 상단의 평형 선택칩(작은 면적 -> 큰 면적 순 정렬)을 그립니다. 클릭 시 최대
// 3개까지 토글로 선택되며, 다시 렌더링해 선택 결과를 차트에 반영합니다.
function renderScatterAreaChips(groups) {
  const container = document.getElementById("scatterAreaChips");
  const hint = document.getElementById("scatterAreaHint");
  if (!container) return;

  // groups는 호출부(renderPriceScatterChart)에서 이미 면적 오름차순으로 정렬해 넘깁니다.
  // 건수는 그룹 전체 누적이 아니라 현재 선택된 산점도 기간(scatterPeriodYears) 기준으로 셉니다.
  container.innerHTML = groups.map(g => {
    const areaLabel = formatScatterGroupLabel(g);
    const rentalMark = g.isRentalSuspected ? " 🏠" : "";
    const activeClass = scatterSelectedKeys.includes(g.key) ? "active" : "";
    const periodDealCount = filterDealsByScatterPeriod(g.deals).length;
    return `<button type="button" class="unit-type-btn scatter-area-chip ${activeClass}" data-key="${g.key}">${areaLabel}${rentalMark} · ${periodDealCount}건</button>`;
  }).join("");

  container.querySelectorAll(".scatter-area-chip").forEach(button => {
    button.addEventListener("click", () => {
      const key = button.dataset.key;
      const idx = scatterSelectedKeys.indexOf(key);
      if (idx >= 0) {
        scatterSelectedKeys.splice(idx, 1);
      } else {
        if (scatterSelectedKeys.length >= 3) return; // 최대 3개까지만 동시 비교
        scatterSelectedKeys.push(key);
      }
      renderPriceScatterChart(scatterAptData);
    });
  });

  if (hint) {
    hint.textContent = `평형을 최대 3개까지 선택해 비교할 수 있습니다 (${scatterSelectedKeys.length}/3 선택됨)`;
  }
}

function filterDealsByScatterPeriod(deals) {
  if (scatterPeriodYears === "all") return deals;
  const now = new Date();
  const cutoff = new Date(now.getFullYear() - scatterPeriodYears, now.getMonth(), now.getDate());
  const cutoffVal = cutoff.getFullYear() * 10000 + (cutoff.getMonth() + 1) * 100 + cutoff.getDate();
  return deals.filter(d => (d.year * 10000 + d.month * 100 + (d.day || 1)) >= cutoffVal);
}

// 산점도 카드 상단의 1/3/5/7/10년/전체 기간 버튼을 초기화합니다. 버튼 자체는
// index.html에 고정 마크업으로 존재하므로 한 번만 바인딩하면 됩니다.
function initScatterPeriodButtons() {
  const buttons = document.querySelectorAll(".scatter-period-btn");
  buttons.forEach(button => {
    button.addEventListener("click", () => {
      const years = button.dataset.years === "all" ? "all" : parseInt(button.dataset.years, 10);
      scatterPeriodYears = years;
      buttons.forEach(b => b.classList.toggle("active", b === button));
      renderPriceScatterChart(scatterAptData);
    });
  });
}

// 선택된 단지의 개별 실거래를 x축=계약일, y축=거래금액 산점도로 그립니다.
// 회전율 막대 차트(renderChart)와 달리 평형별 "요약값"이 아니라 거래 하나하나를
// 점으로 찍어, 같은 평형 안에서도 시기별 가격 흐름과 편차를 한눈에 볼 수 있게 합니다.
// aptData는 메인 "분석 기간" 필터를 타지 않은 단지의 전체 deals를 담고 있어야 합니다 -
// 산점도 자체 기간(scatterPeriodYears)이 따로 잘라서 씁니다.
//
// 평형이 많은 대단지는 한 화면에 다 그리면 색이 겹치고 알아보기도 어려워, 거래량이
// 가장 많은 평형을 기본으로 보여주고 사용자가 최대 3개까지 골라 비교하게 합니다
// (renderScatterAreaChips). 색상 인덱스는 면적 오름차순 기준으로 고정해, 어떤 3개를
// 고르든 같은 평형은 항상 같은 색으로 보입니다.
function renderPriceScatterChart(aptData) {
  scatterAptData = aptData;

  const groups = groupAreasForScatter(aptData).sort((a, b) => a.repExclusiveArea - b.repExclusiveArea);
  scatterGroups = groups;

  const currentAptKey = aptData[0]?.apt_key || null;
  if (currentAptKey !== scatterGroupsAptKey) {
    // 단지가 바뀌었으면 거래량 1위 평형 하나로 선택을 초기화합니다.
    scatterGroupsAptKey = currentAptKey;
    const topGroup = [...groups].sort((a, b) => b.deals.length - a.deals.length)[0];
    scatterSelectedKeys = topGroup ? [topGroup.key] : [];
  } else {
    // 같은 단지 내 기간/선택 변경 - 이제 존재하지 않는 키만 방어적으로 정리합니다.
    scatterSelectedKeys = scatterSelectedKeys.filter(key => groups.some(g => g.key === key));
  }

  renderScatterAreaChips(groups);

  const canvas = document.getElementById("priceScatterChart");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");

  if (priceScatterChart) {
    priceScatterChart.destroy();
    priceScatterChart = null;
  }

  const datasets = groups
    .map((g, idx) => ({ g, idx }))
    .filter(({ g }) => scatterSelectedKeys.includes(g.key))
    .map(({ g, idx }) => {
      const rgb = SCATTER_COLOR_PALETTE[idx % SCATTER_COLOR_PALETTE.length];
      const areaLabel = formatScatterGroupLabel(g);
      const label = g.isRentalSuspected ? `${areaLabel} 🏠` : areaLabel;

      const points = filterDealsByScatterPeriod(g.deals).map(d => ({
        // 옛 캐시 데이터는 day가 없을 수 있어 그 달 1일로 대체합니다(가로축 위치만
        // 대략적으로 밀릴 뿐 값 자체에는 영향 없음).
        x: new Date(d.year, (d.month || 1) - 1, d.day || 1),
        y: d.amount,
        floor: d.floor || 0
      }));

      return {
        label,
        data: points,
        backgroundColor: `rgba(${rgb}, 0.75)`,
        borderColor: `rgba(${rgb}, 1)`,
        pointRadius: 5,
        pointHoverRadius: 7
      };
    })
    .filter(ds => ds.data.length > 0); // 선택된 기간에 거래가 없으면 범례에서도 뺌

  priceScatterChart = new Chart(ctx, {
    type: "scatter",
    data: { datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          display: datasets.length > 0,
          position: "top",
          labels: {
            color: "#e5e7eb",
            font: { family: "Outfit, sans-serif", size: 12 }
          }
        },
        tooltip: {
          backgroundColor: "rgba(17, 22, 44, 0.95)",
          titleColor: "#f3f4f6",
          bodyColor: "#d1d5db",
          borderColor: "rgba(255, 255, 255, 0.1)",
          borderWidth: 1,
          padding: 12,
          callbacks: {
            label: (item) => {
              const floorLabel = item.raw.floor > 0 ? `${item.raw.floor}층 · ` : "";
              return `${item.dataset.label} · ${item.raw.x.toLocaleDateString("ko-KR")} · ${floorLabel}${formatKrw(item.raw.y)}`;
            }
          }
        }
      },
      scales: {
        x: {
          type: "time",
          time: {
            tooltipFormat: "yyyy-MM-dd",
            // 연도 뒤 두 자리만 쓰는 짧은 표기("25.10")로 눈금이 붙어 보이지 않게 합니다.
            displayFormats: { month: "yy.MM", quarter: "yy.MM", year: "yy" }
          },
          grid: { color: "rgba(255, 255, 255, 0.05)" },
          ticks: {
            color: "#9ca3af",
            autoSkip: true,
            maxTicksLimit: 7,
            maxRotation: 0
          }
        },
        y: {
          beginAtZero: false,
          title: {
            display: true,
            text: "거래금액",
            color: "#9ca3af",
            font: { weight: "bold" }
          },
          grid: { color: "rgba(255, 255, 255, 0.05)" },
          ticks: {
            color: "#9ca3af",
            callback: (value) => formatKrw(value)
          }
        }
      }
    }
  });
}

// 테이블 데이터 정렬 렌더링 호출용 랩퍼 함수
function renderTable(aptName) {
  renderAptDashboard(aptName);
}

// 실질적으로 테이블을 그리는 동적 렌더러 함수
function renderTableData(aptData) {
  const tableBody = document.getElementById("tableBody");
  
  if (aptData.length === 0) {
    tableBody.innerHTML = `<tr><td colspan="6" class="empty-row">데이터가 없습니다.</td></tr>`;
    return;
  }
  
  aptData.sort((a, b) => {
    let valA = a[currentSort.key];
    let valB = b[currentSort.key];
    
    if (typeof valA === "string") {
      return valA.localeCompare(valB, "ko") * currentSort.direction;
    }
    return (valA - valB) * currentSort.direction;
  });

  tableBody.innerHTML = aptData
    .map(item => {
      const rangeStr = item.trade_count > 0 
        ? `${formatKrw(item.min_deal_amount)} ~ ${formatKrw(item.max_deal_amount)}`
        : "-";
        
      const annRate = item.annualized_rate;
      let statusBadge = "";
      if (annRate < 5) {
        statusBadge = `<span class="status-badge status-low">❄️ 침체</span>`;
      } else if (annRate < 10) {
        statusBadge = `<span class="status-badge status-stable">👍 안정</span>`;
      } else {
        statusBadge = `<span class="status-badge status-active">🔥 활발</span>`;
      }

      const typeLabelHtml = item.unit_type
        ? `<span class="unit-type-badge" title="청약홈 분양정보 기준 주택형">${item.unit_type}타입</span>`
        : "";
      let unitsBadgeHtml;
      if (unitTypesInFlight.has(item.apt_key)) {
        unitsBadgeHtml = `<span class="units-source-badge units-loading" title="국토교통부 건축물대장 전유부(등기 원본)에서 실제 세대수를 조회하고 있습니다">⏳ 조회 중</span>`;
      } else if (item.units_source === "registry") {
        unitsBadgeHtml = `<span class="units-source-badge units-registry" title="국토교통부 건축물대장 전유부(등기 원본) 기준 실제 세대수 - 조합원 분양분 포함">실측</span>`;
      } else if (item.is_estimated_units) {
        unitsBadgeHtml = `<span class="units-source-badge units-estimated" title="이 평형의 실제 세대수를 확인할 자료(등기 원본/청약홈 분양정보)가 없어, 총 세대수를 남은 평형 종류 수로 균등 안분한 값입니다. 실제 세대수와 다를 수 있습니다.">미확인</span>`;
      } else {
        unitsBadgeHtml = `<span class="units-source-badge units-confirmed" title="등기 원본이 아닌 청약홈 분양 공고 기준 일반+특별공급 세대수입니다. 조합원 분양분(재건축/재개발) 등은 반영되지 않아 실제 세대수보다 적을 수 있어 '실측'이 아닌 '예상'으로 표시합니다.">예상</span>`;
      }

      // 임대 추정 배지: K-apt(HOA 관리) 공식 총세대수로는 설명이 안 되고 건축물대장
      // 표제부 총세대수까지 있어야 설명되는 평형입니다. 매매 실거래가 없는 것도
      // 정황상 일치합니다(임대주택은 매매 대상이 아님). 다만 확정 데이터는 아니라서
      // "추정"이라 표기하고, 근거를 툴팁에 그대로 밝힙니다.
      const rentalBadgeHtml = item.is_rental_suspected
        ? `<span class="units-source-badge units-rental" title="K-apt(입주자대표회의 관리) 공식 세대수에는 없고 건축물대장 표제부에만 등록된 세대입니다. 관리 주체가 다른 임대동일 가능성이 높지만, 공공데이터로 임대 여부 자체가 확정되지는 않아 추정으로 표시합니다.">🏠 임대 추정</span>`
        : "";

      return `
        <tr>
          <td class="font-outfit font-medium">${formatAreaPair(item.supply_area, item.exclusive_area)} ${typeLabelHtml} ${rentalBadgeHtml}</td>
          <td>${item.generation_count.toLocaleString()} 세대 ${unitsBadgeHtml}</td>
          <td><span class="badge badge-cyan">${item.trade_count} 건</span></td>
          <td>
            <span class="badge badge-purple">${item.turnover_rate.toFixed(4)} %</span>
            ${statusBadge}
            <span style="font-size: 0.75rem; color: rgba(229, 231, 235, 0.5); display: block; margin-top: 4px;">
              (연 환산: ${annRate.toFixed(2)}%)
            </span>
          </td>
          <td class="font-semibold">${formatKrw(item.avg_deal_amount)}</td>
          <td class="text-secondary">${rangeStr}</td>
        </tr>
      `;
    })
    .join("");
}

const MAINTENANCE_AVERAGE_LOOKBACK_MONTHS = 24;
const MAINTENANCE_RANGE_LIMIT_MONTHS = 60;
const SUMMER_MONTHS = new Set([6, 7, 8]);
const WINTER_MONTHS = new Set([12, 1, 2]);

const maintenanceState = {
  requestSeq: 0,
  currentAptKey: "",
  loading: false,
  kaptCode: "",
  activeMonth: "",
  totalGen: 0,
  // 세대당 환산에 필요한 상태: 사용자가 고른 평형과, 환산 전 "단지 전체" 원본 금액들
  // (월 변경/평형 변경 때 재요청 없이 다시 계산합니다).
  selectedTypeKey: "",
  monthData: null,
  recentMonthData: []
};

const molitMonthDataCache = new Map();

function setElementText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

function toNumber(value) {
  if (value === null || value === undefined) return 0;
  const parsed = parseFloat(String(value).replace(/[^\d.-]/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function getCurrentMonthKey() {
  const now = new Date();
  return `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}`;
}

function shiftMonthKey(monthKey, diff) {
  const year = Number(monthKey.substring(0, 4));
  const monthIndex = Number(monthKey.substring(4, 6)) - 1 + diff;
  const date = new Date(year, monthIndex, 1);
  return `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function monthKeyToInputValue(monthKey) {
  if (!monthKey || monthKey.length !== 6) return "";
  return `${monthKey.substring(0, 4)}-${monthKey.substring(4, 6)}`;
}

function inputValueToMonthKey(value) {
  if (!value) return "";
  return value.replace("-", "");
}

function formatMonthKey(monthKey) {
  if (!monthKey || monthKey.length !== 6) return "-";
  return `${monthKey.substring(0, 4)}년 ${monthKey.substring(4, 6)}월`;
}

function getMonthNumber(monthKey) {
  return Number(monthKey.substring(4, 6));
}

// 서울시 공동주택 관리비(OA-15822 로컬 인덱스, /api/seoul-maintenance) 응답의 "비용명"
// 카테고리를 세대분+공동분으로 합산합니다. 장기수선충당금은 이 데이터셋 자체에 카테고리가
// 없어(적립금 성격이라 월별 "비용" 항목으로 공시되지 않는 것으로 보임) 항상 0입니다.
function getMetricValue(monthData, key) {
  const costs = monthData?.costs;
  if (!costs) return 0;
  const sum = (...names) => names.reduce((s, n) => s + (toNumber(costs[n])), 0);
  switch (key) {
    case "elecCost":
      return sum("세대전기료", "공동전기료");
    case "waterCost":
      return sum("세대수도료", "공동수도료");
    case "hotWaterCost":
      return sum("세대급탕비", "공동급탕비");
    case "heatCost":
      return sum("세대난방비", "공동난방비");
    case "gasCost":
      return sum("세대가스료", "공동가스료");
    case "repairsCost":
      return 0; // 이 데이터셋에 없는 항목 - 항상 "정보 없음"으로 표시됩니다.
    default:
      return 0;
  }
}

function hasMaintenanceData(monthData) {
  if (!monthData || !monthData.costs) return false;
  return ["elecCost", "waterCost", "hotWaterCost", "heatCost", "gasCost"]
    .some(key => getMetricValue(monthData, key) > 0);
}

function formatWon(value) {
  return value > 0 ? `${Math.round(value).toLocaleString()} 원` : "-";
}

const COST_METRICS = [
  { key: "elecCost", label: "전기료", elId: "costElec" },
  { key: "waterCost", label: "수도료", elId: "costWater" },
  { key: "hotWaterCost", label: "급탕비", elId: "costHotWater" },
  { key: "heatCost", label: "난방비", elId: "costHeat" },
  { key: "gasCost", label: "가스료", elId: "costGas" }
];

// 전용면적을 내림한 값(59.84㎡ -> "59타입")으로 평형을 묶습니다. rawData의 unit_type
// 필드는 대부분의 단지에서 비어 있어(청약홈 매칭분만 존재) 기준으로 쓸 수 없습니다.
//
// 중요: apt_key(지번)가 아니라 kaptCode로 묶습니다. 관리비 총액은 K-apt "단지" 단위로
// 공시되는데, 한 단지가 여러 지번에 걸쳐 있는 경우가 있어(예: 개포2차현대 A13524006은
// 개포동 654 + 655-2) 지번 하나의 세대수로 나누면 세대당 금액이 크게 부풀려집니다.
function getUnitGroups(kaptCode) {
  const groups = new Map();
  if (!kaptCode) return [];
  rawData.forEach(item => {
    if (item.kapt_code !== kaptCode) return;
    const area = Number(item.exclusive_area) || 0;
    const count = Number(item.generation_count) || 0;
    if (area <= 0 || count <= 0) return;

    const key = String(Math.floor(area));
    const group = groups.get(key) || { key, label: `${key}타입`, count: 0, areaSum: 0, supplySum: 0, supplyCount: 0 };
    group.count += count;
    group.areaSum += area * count; // 면적 지분(면적 × 세대수) 합
    // 공급면적은 등기 실측이 끝난 행에만 있어, 있는 행만 모아 평균냅니다.
    if (Number(item.supply_area) > 0) {
      group.supplySum += Number(item.supply_area) * count;
      group.supplyCount += count;
    }
    groups.set(key, group);
  });

  return [...groups.values()]
    .map(group => ({
      ...group,
      area: group.areaSum / group.count,
      supplyArea: group.supplyCount > 0 ? group.supplySum / group.supplyCount : 0
    }))
    .sort((a, b) => a.area - b.area);
}

function getTotalWeightedArea(groups) {
  return groups.reduce((sum, group) => sum + group.areaSum, 0);
}

/**
 * 단지 전체 부과액을 전용면적 지분으로 안분해 "그 평형 1세대"가 부담하는 금액으로
 * 환산합니다. 서울시 데이터는 단지 총액만 공시하므로 세대별 실제 사용량(계량기)은
 * 알 수 없고, 공용관리비의 표준 배분 방식인 전용면적 비례를 전 항목에 적용한
 * 근사치입니다. 따라서 실제 고지서와는 차이가 날 수 있습니다.
 * 검산: Σ(평형별 세대당 금액 × 그 평형 세대수) = 단지 총액.
 */
function perHouseholdCost(monthData, group, totalArea, metricKey) {
  if (!group || totalArea <= 0) return 0;
  return getMetricValue(monthData, metricKey) * (group.area / totalArea);
}

function perHouseholdTotal(monthData, group, totalArea) {
  return COST_METRICS.reduce(
    (sum, metric) => sum + perHouseholdCost(monthData, group, totalArea, metric.key),
    0
  );
}

// 현재 선택된 평형(없으면 세대수가 가장 많은 대표 평형)을 돌려줍니다.
function getSelectedGroup(groups) {
  if (groups.length === 0) return null;
  const found = groups.find(group => group.key === maintenanceState.selectedTypeKey);
  if (found) return found;
  return groups.reduce((best, group) => (group.count > best.count ? group : best), groups[0]);
}

// ㎡ <-> 평 전환. 표의 면적 칸과 관리비 섹션의 평형 설명이 함께 바뀝니다.
// 표(#btnAreaUnit)와 차트(#btnAreaUnitChart) 두 곳에 같은 버튼이 있어, 하나를 눌러도
// 상태와 문구가 둘 다 같이 바뀌어야 합니다. 이 버튼들의 표시만 갱신하는 함수를 따로 빼서
// 초기화 시점과 클릭 시점 양쪽에서 재사용합니다.
function syncAreaUnitButtons() {
  const isPyeong = areaUnit === "pyeong";
  document.querySelectorAll(".area-unit-toggle").forEach(button => {
    button.textContent = isPyeong ? "㎡로 보기" : "평으로 보기";
    button.setAttribute("aria-pressed", String(isPyeong));
  });
}

function initAreaUnitToggle() {
  const buttons = document.querySelectorAll(".area-unit-toggle");
  if (buttons.length === 0) return;

  syncAreaUnitButtons();
  buttons.forEach(button => {
    button.addEventListener("click", () => {
      areaUnit = areaUnit === "sqm" ? "pyeong" : "sqm";
      syncAreaUnitButtons();
      if (selectedApt) renderAptDashboard(selectedApt);
    });
  });
}

function initMaintenanceControls() {
  const monthButton = document.getElementById("btnLoadMaintenanceMonth");
  const monthInput = document.getElementById("maintenanceMonth");

  if (monthButton) {
    monthButton.addEventListener("click", () => {
      loadSelectedMaintenanceMonth();
    });
  }

  if (monthInput) {
    monthInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") loadSelectedMaintenanceMonth();
    });
  }
}

function resetMaintenanceValues() {
  COST_METRICS.forEach(metric => setElementText(metric.elId, "-"));
  setElementText("costHeroVal", "-");
  setElementText("costHeroSub", "전기·수도·급탕·난방·가스 총합 평균");
  setElementText("costHeroNote", "");
}

function setAverageCard(metaId, linesId, metaText, linesHtml) {
  const meta = document.getElementById(metaId);
  const lines = document.getElementById(linesId);
  if (meta) meta.textContent = metaText;
  if (lines) lines.innerHTML = linesHtml;
}

function setAverageCardsLoading() {
  const loadingHtml = `<span>계산 중...</span>`;
  setAverageCard("avgSummerMeta", "avgSummerLines", "-", loadingHtml);
  setAverageCard("avgWinterMeta", "avgWinterLines", "-", loadingHtml);
}

function setAverageCardsEmpty() {
  setAverageCard("avgSummerMeta", "avgSummerLines", "-", `<span>자료 없음</span>`);
  setAverageCard("avgWinterMeta", "avgWinterLines", "-", `<span>자료 없음</span>`);
}

// 계절 평균은 항목별로 쪼개지 않고, "그 평형 1세대가 그 달에 낸 총액"의 월평균만 냅니다.
function calculateSeasonalAverage(monthDataList, group, totalArea) {
  const validMonths = monthDataList.filter(hasMaintenanceData);
  if (validMonths.length === 0 || !group) return { monthCount: 0, average: 0 };

  const totals = validMonths.map(monthData => perHouseholdTotal(monthData, group, totalArea));
  return {
    monthCount: validMonths.length,
    average: totals.reduce((sum, value) => sum + value, 0) / totals.length
  };
}

function renderAverageCard(metaId, linesId, averageData, emptyText, group) {
  if (!averageData || averageData.monthCount === 0 || averageData.average <= 0) {
    setAverageCard(metaId, linesId, "-", `<span>${emptyText}</span>`);
    return;
  }

  const linesHtml = `<span class="average-total">${formatWon(averageData.average)}</span>`
    + `<span class="average-note">${group.label} 세대당 월 총합 평균</span>`;
  setAverageCard(metaId, linesId, `${averageData.monthCount}개월 반영`, linesHtml);
}

function updateMaintenanceInputBounds(activeMonth) {
  const currentMonth = getCurrentMonthKey();
  const minMonth = shiftMonthKey(currentMonth, -MAINTENANCE_RANGE_LIMIT_MONTHS);
  const monthInput = document.getElementById("maintenanceMonth");

  if (monthInput) {
    monthInput.min = monthKeyToInputValue(minMonth);
    monthInput.max = monthKeyToInputValue(currentMonth);
  }

  if (activeMonth && monthInput) {
    monthInput.value = monthKeyToInputValue(activeMonth);
  }
}

// 참고: 이전에는 여기서 fetchMolitAptData()가 AptListService3로 kaptCode를 실시간
// 조회했지만, 그 API가 항상 0건만 반환하는 문제가 있어 제거했습니다. kaptCode는
// 이제 index.js 파이프라인이 K-apt 파일(kapt_basic_info.json)과 미리 매칭해
// turnover_results.json에 실어 보내므로, loadMolitData()가 바로 사용합니다.

// 이 단지(kaptCode)가 서울시 공동주택 관리비 데이터에 공시한 전체 월(YYYYMM) 목록을
// 가져옵니다. 서버가 이미 로컬 인덱스로 들고 있어(온디맨드 외부 API 호출 없음) 즉시 응답합니다.
async function fetchMaintenanceMonths(kaptCode) {
  try {
    const json = await fetchServerJson(`/api/seoul-maintenance-months?kaptCode=${encodeURIComponent(kaptCode)}`);
    return json.months || [];
  } catch (err) {
    console.warn(`[서울시 관리비 월 목록 조회 실패] ${kaptCode}:`, err.message);
    return [];
  }
}

async function fetchMaintenanceMonthData(kaptCode, month) {
  const cacheKey = `${kaptCode}_${month}`;
  if (molitMonthDataCache.has(cacheKey)) {
    return molitMonthDataCache.get(cacheKey);
  }

  let costs = null;
  try {
    const json = await fetchServerJson(`/api/seoul-maintenance?kaptCode=${encodeURIComponent(kaptCode)}&month=${month}`);
    if (json.status === "ok") costs = json.costs;
  } catch (err) {
    console.warn(`[서울시 관리비 조회 실패] ${month}:`, err.message);
  }

  const monthData = { month, costs };
  monthData.hasData = hasMaintenanceData(monthData);
  molitMonthDataCache.set(cacheKey, monthData);
  return monthData;
}

async function fetchMaintenanceMonthDataList(kaptCode, months, seq) {
  const results = [];
  const chunkSize = 3;

  for (let idx = 0; idx < months.length; idx += chunkSize) {
    if (seq !== maintenanceState.requestSeq) return results;
    const chunk = months.slice(idx, idx + chunkSize);
    const chunkResults = await Promise.all(chunk.map(month => fetchMaintenanceMonthData(kaptCode, month)));
    results.push(...chunkResults.filter(hasMaintenanceData));
  }

  return results;
}

// 참고: renderMolitAptIdentity()/renderMolitBasisInfo()는 더 이상 필요하지 않아
// 제거했습니다. "단지 상세 제원 패널"은 이제 renderAptDashboard()에서
// turnover_results.json의 값(K-apt 파일 매칭 결과)으로 바로 채워집니다.

// 평형 선택 스위치. 클릭하면 재조회 없이 이미 받아둔 원본 금액을 그 평형 기준으로
// 다시 환산하기만 합니다.
function renderUnitTypeSwitch(groups, selectedGroup) {
  const row = document.getElementById("unitTypeRow");
  const container = document.getElementById("unitTypeSwitch");
  if (!row || !container) return;

  if (groups.length === 0) {
    row.style.display = "none";
    container.innerHTML = "";
    return;
  }

  row.style.display = "";
  container.innerHTML = groups
    .map(group => {
      const active = group.key === selectedGroup.key ? " active" : "";
      return `<button type="button" class="unit-type-btn${active}" data-type-key="${group.key}"`
        + ` title="${group.supplyArea > 0 ? "공급/전용" : "전용"} ${formatAreaPair(group.supplyArea, group.area)} · ${group.count.toLocaleString()}세대">`
        + `${group.label}</button>`;
    })
    .join("");

  container.querySelectorAll(".unit-type-btn").forEach(button => {
    button.addEventListener("click", () => {
      maintenanceState.selectedTypeKey = button.dataset.typeKey;
      renderMaintenanceView();
    });
  });
}

// 이미 받아둔 monthData/recentMonthData를 현재 선택 평형 기준으로 다시 그립니다
// (네트워크 요청 없음). 평형 스위치 클릭·세대수 실측 갱신 시에도 이 함수만 호출합니다.
function renderMaintenanceView() {
  const contentDiv = document.getElementById("maintenanceContent");
  const errorDiv = document.getElementById("maintenanceError");
  const monthData = maintenanceState.monthData;

  resetMaintenanceValues();

  if (!monthData) {
    setElementText("maintenancePeriod", "조회 가능한 월 없음");
    if (contentDiv) contentDiv.style.display = "none";
    if (errorDiv) {
      errorDiv.textContent = "최근 기간에서 공시된 유지관리/에너지 정보를 찾지 못했습니다.";
      errorDiv.style.display = "block";
    }
    return;
  }

  setElementText(
    "maintenancePeriod",
    monthData.hasData ? `조회 월: ${formatMonthKey(monthData.month)}` : `조회 월: ${formatMonthKey(monthData.month)} (자료 없음)`
  );

  if (contentDiv) contentDiv.style.display = "flex";
  if (errorDiv) {
    errorDiv.textContent = monthData.hasData
      ? "해당 단지의 상세/관리비 정보가 공시되지 않았습니다."
      : `${formatMonthKey(monthData.month)} 자료가 공시되지 않았습니다. 다른 월을 선택해 주세요.`;
    errorDiv.style.display = monthData.hasData ? "none" : "block";
  }

  const groups = getUnitGroups(maintenanceState.kaptCode);
  const selectedGroup = getSelectedGroup(groups);
  const totalArea = getTotalWeightedArea(groups);

  renderUnitTypeSwitch(groups, selectedGroup || { key: "" });

  if (!selectedGroup || totalArea <= 0) {
    // 평형 정보가 없으면 세대당 환산이 불가능하므로 단지 총액을 그대로 보여줍니다.
    setElementText("costHeroVal", formatWon(COST_METRICS.reduce((s, m) => s + getMetricValue(monthData, m.key), 0)));
    setElementText("costHeroSub", "단지 전체 합계 (평형 정보가 없어 세대당 환산 불가)");
    setElementText("costGridCaption", "항목별 단지 전체 금액");
    COST_METRICS.forEach(metric => setElementText(metric.elId, formatWon(getMetricValue(monthData, metric.key))));
    setAverageCardsEmpty();
    return;
  }

  maintenanceState.selectedTypeKey = selectedGroup.key;

  setElementText("costHeroVal", formatWon(perHouseholdTotal(monthData, selectedGroup, totalArea)));
  setElementText(
    "costHeroSub",
    `${selectedGroup.label} 세대당 · ${selectedGroup.supplyArea > 0 ? "공급/전용 " : "전용 "}`
      + `${formatAreaPair(selectedGroup.supplyArea, selectedGroup.area)}`
      + ` · ${selectedGroup.count.toLocaleString()}세대 · 전기·수도·급탕·난방·가스 총합 평균`
  );
  setElementText(
    "costHeroNote",
    "단지 전체 부과액을 전용면적 지분으로 나눈 평균치입니다. 세대별 실제 고지액과는 차이가 있습니다."
  );
  setElementText("costGridCaption", `${selectedGroup.label} 기준 항목별 세대당 평균 환산액`);

  COST_METRICS.forEach(metric => {
    setElementText(metric.elId, formatWon(perHouseholdCost(monthData, selectedGroup, totalArea, metric.key)));
  });

  renderSeasonalView(selectedGroup, totalArea);
}

function renderSeasonalView(selectedGroup, totalArea) {
  const recent = maintenanceState.recentMonthData;
  if (!recent || recent.length === 0) {
    setAverageCardsEmpty();
    return;
  }

  const summerData = recent.filter(monthData => SUMMER_MONTHS.has(getMonthNumber(monthData.month)));
  const winterData = recent.filter(monthData => WINTER_MONTHS.has(getMonthNumber(monthData.month)));

  renderAverageCard(
    "avgSummerMeta", "avgSummerLines",
    calculateSeasonalAverage(summerData, selectedGroup, totalArea),
    "최근 24개월 내 여름철 자료 없음", selectedGroup
  );
  renderAverageCard(
    "avgWinterMeta", "avgWinterLines",
    calculateSeasonalAverage(winterData, selectedGroup, totalArea),
    "최근 24개월 내 겨울철 자료 없음", selectedGroup
  );
}

async function loadSeasonalMonths(kaptCode, allMonths, seq) {
  if (!kaptCode || allMonths.length === 0) {
    maintenanceState.recentMonthData = [];
    setAverageCardsEmpty();
    return;
  }

  setAverageCardsLoading();

  // allMonths는 이 단지가 실제로 공시한 월만 담고 있어(서버가 로컬 인덱스에서 바로 알려줌),
  // 존재하지도 않는 월을 하나씩 찔러보던 예전 방식과 달리 헛수고 없이 최근 N개월만 취합니다.
  const recentMonths = allMonths.slice(-MAINTENANCE_AVERAGE_LOOKBACK_MONTHS);
  const recentMonthData = await fetchMaintenanceMonthDataList(kaptCode, recentMonths, seq);
  if (seq !== maintenanceState.requestSeq) return;

  maintenanceState.recentMonthData = recentMonthData;

  const groups = getUnitGroups(maintenanceState.kaptCode);
  const selectedGroup = getSelectedGroup(groups);
  if (!selectedGroup) {
    setAverageCardsEmpty();
    return;
  }
  renderSeasonalView(selectedGroup, getTotalWeightedArea(groups));
}

async function loadSelectedMaintenanceMonth() {
  const month = inputValueToMonthKey(document.getElementById("maintenanceMonth")?.value || "");
  const seq = maintenanceState.requestSeq;

  if (!maintenanceState.kaptCode || !month) return;

  setElementText("maintenancePeriod", `${formatMonthKey(month)} 조회 중...`);
  const monthData = await fetchMaintenanceMonthData(maintenanceState.kaptCode, month);
  if (seq !== maintenanceState.requestSeq) return;

  maintenanceState.activeMonth = month;
  maintenanceState.monthData = monthData;
  renderMaintenanceView();
}

/**
 * kaptCode(index.js가 K-apt 파일과 미리 매칭해둔 값)를 이용해 전기료/수도료/급탕비/
 * 난방비/가스료(서울시 공동주택 관리비 정보, 서버가 미리 로드해둔 로컬 인덱스)를
 * 조회합니다. 국토교통부 구버전 관리비 API는 2025-09-30 대체서비스 공지로 사실상
 * 폐지되어(값이 항상 비어 있음) 서울시가 공식 대체로 안내한 이 소스로 교체했습니다 -
 * 서울 소재 단지만 커버되고, 장기수선충당금은 이 데이터셋 자체에 없습니다.
 * 단지 상세 제원(난방방식/복도유형/시공사 등)은 이미 renderAptDashboard()에서
 * turnover_results.json 값으로 채워졌으므로 여기서는 다루지 않습니다.
 */
async function loadMolitData(kaptCode) {
  const contentDiv = document.getElementById("maintenanceContent");
  const errorDiv = document.getElementById("maintenanceError");

  if (!kaptCode) {
    maintenanceState.requestSeq += 1;
    maintenanceState.currentAptKey = "";
    maintenanceState.kaptCode = "";
    maintenanceState.activeMonth = "";
    maintenanceState.monthData = null;
    maintenanceState.recentMonthData = [];
    setElementText("maintenancePeriod", "조회 월: -");
    resetMaintenanceValues();
    renderUnitTypeSwitch([], { key: "" });
    setAverageCardsEmpty();
    if (contentDiv) contentDiv.style.display = "none";
    if (errorDiv) {
      errorDiv.textContent = "해당 단지는 K-apt 단지코드가 확인되지 않아 관리비/에너지 정보를 조회할 수 없습니다.";
      errorDiv.style.display = "block";
    }
    return;
  }

  // 같은 단지를 다시 그리는 경우(예: 등기 세대수 실측이 도착해 rawData가 갱신됨)에는
  // 재요청 없이 이미 받아둔 금액을 새 세대수 기준으로 다시 환산만 합니다.
  if (maintenanceState.currentAptKey === kaptCode && (maintenanceState.loading || maintenanceState.kaptCode)) {
    if (!maintenanceState.loading && maintenanceState.monthData) renderMaintenanceView();
    return;
  }

  const seq = maintenanceState.requestSeq + 1;
  maintenanceState.requestSeq = seq;
  maintenanceState.currentAptKey = kaptCode;
  maintenanceState.loading = true;
  maintenanceState.kaptCode = kaptCode;
  maintenanceState.activeMonth = "";
  maintenanceState.selectedTypeKey = "";
  maintenanceState.monthData = null;
  maintenanceState.recentMonthData = [];

  // 초기화 및 로딩 인디케이터
  setElementText("maintenancePeriod", "최신 공시 월 탐색 중...");
  resetMaintenanceValues();
  setAverageCardsLoading();
  if (contentDiv) contentDiv.style.display = "none";
  if (errorDiv) errorDiv.style.display = "none";

  const allMonths = await fetchMaintenanceMonths(kaptCode);
  if (seq !== maintenanceState.requestSeq) return;

  maintenanceState.loading = false;

  if (allMonths.length === 0) {
    setElementText("maintenancePeriod", "조회 월: -");
    renderUnitTypeSwitch([], { key: "" });
    setAverageCardsEmpty();
    if (errorDiv) {
      errorDiv.textContent = "해당 단지의 관리비 정보가 서울시 공동주택 관리비 데이터에 없습니다(서울 외 지역이거나 미공시).";
      errorDiv.style.display = "block";
    }
    return;
  }

  const latestMonth = allMonths[allMonths.length - 1];
  const monthData = await fetchMaintenanceMonthData(kaptCode, latestMonth);
  if (seq !== maintenanceState.requestSeq) return;

  maintenanceState.activeMonth = monthData.month;
  maintenanceState.monthData = monthData;

  updateMaintenanceInputBounds(monthData.month || getCurrentMonthKey());
  renderMaintenanceView();
  await loadSeasonalMonths(kaptCode, allMonths, seq);
}
