// turnover_results.json(약 45MB)에 대한 등기 실측 영구반영을 전담하는 워커 스레드입니다.
// JSON.parse/JSON.stringify가 파일 크기만큼 메인 스레드를 동기적으로 블로킹하는데, 이 작업을
// 메인 스레드(HTTP 요청 처리)에서 그대로 하면 그 몇백 ms~몇 초 동안 다른 모든 요청(다른
// 사용자의 등기 조회 진행률 폴링 포함)이 멈춰버립니다. CPU가 넉넉하지 않은 배포 환경(Render
// 등)에서는 이게 누적되어 "등기 원본 조회를 시작하는 중..."에서 멈춘 것처럼 보이는 원인이
// 될 수 있어, 이 무거운 파일 작업만 별도 스레드로 분리했습니다.
import { parentPort } from "worker_threads";
import { readFile, writeFile, rename } from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { putRemoteObject } from "./remoteStorage.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TURNOVER_RESULTS_PATH = path.join(__dirname, "turnover_results.json");
const TURNOVER_RESULTS_TMP_PATH = `${TURNOVER_RESULTS_PATH}.tmp`;

// 등기(건축물대장)에는 있지만 조회 기간 내 실거래가 없어 turnover_results.json에 행이
// 없던 평형을 새로 추가하기 전, 어떤 평형 조합이 "진짜 이 단지 소속"인지 공식
// 총세대수와 교차검증합니다. dashboard.js의 pickAddableUnmatchedTypes와 동일한
// 알고리즘입니다(온디맨드 화면 반영 로직과 이 영구반영 로직 양쪽이 같은 판단 기준을
// 써야 해서 그대로 옮겨왔습니다 - 알고리즘을 바꿀 땐 두 곳 모두 반영해야 합니다).
function pickAddableUnmatchedTypesServer(unmatched, referenceTotal, matchedTotal) {
  if (unmatched.length === 0) return [];

  const gap = referenceTotal - matchedTotal;
  if (referenceTotal <= 0 || gap <= 0) return [];

  const sumAll = unmatched.reduce((s, a) => s + a.unitCount, 0);
  if (matchedTotal + sumAll <= referenceTotal) return unmatched;

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

// 이 워커는 메시지를 한 번에 하나씩만 처리합니다(parentPort의 message 콜백은 async지만,
// 아래 큐가 "이전 처리가 끝나야 다음 readFile 시작"을 보장합니다) - 서로 다른 aptKey
// 메시지가 거의 동시에 들어와도 서로의 쓰기를 덮어쓰는 lost-update를 막기 위함입니다.
let queueTail = Promise.resolve();

async function persistRegistryMatchToResultsLocked(aptKey, result) {
  let allResults;
  try {
    allResults = JSON.parse(await readFile(TURNOVER_RESULTS_PATH, "utf-8"));
  } catch (err) {
    console.warn(`[등기 실측 영구반영] turnover_results.json을 읽지 못해 건너뜁니다: ${err.message}`);
    return;
  }

  const aptRows = allResults.filter(r => r.apt_key === aptKey);
  if (aptRows.length === 0) return;

  // 이미 이 단지 전체가 등기로 반영돼 있으면(직전 요청이 이미 반영했거나, 이전 배치가
  // 반영해둔 경우) 다시 쓰지 않습니다 - 파일이 커서(수십 MB) 매 조회마다 다시 쓰지
  // 않기 위한 최소한의 가드입니다.
  if (aptRows.every(r => r.units_source === "registry")) return;

  // 전유공용면적 API는 지번 단위로만 조회되어 같은 지번을 여러 단지가 공유할 수 있습니다
  // (dashboard.js refineUnitCountsFromRegistry와 동일한 이유). 표제부 동번호 구간으로
  // 이 단지 몫만 분리하지 못했는데(dongFiltered=false) 같은 지번을 여러 단지가 쓰는
  // 경우는 result.areas가 섞인 값일 수 있어 반영을 건너뜁니다.
  if (!result.dongFiltered) {
    const jibunPrefix = aptKey.split(" · ")[0];
    const complexesAtJibun = new Set(
      allResults.filter(r => r.apt_key.split(" · ")[0] === jibunPrefix).map(r => r.apt_key)
    );
    if (complexesAtJibun.size > 1) {
      console.warn(`[등기 실측 영구반영 건너뜀] ${aptKey}: 같은 지번(${jibunPrefix})을 ${complexesAtJibun.size}개 단지가 공유하는데 동번호 구간으로 분리하지 못했습니다.`);
      return;
    }
  }

  // K-apt/부동산원 공식 총세대수는 파일에서 직접 다시 계산합니다(호출부가 보낸
  // officialTotal은 그 브라우저의 rawData 스냅샷 기준이라 파일의 최신 상태와 다를 수
  // 있음) - 지금 patch하려는 행들의 generation_count 합, 즉 매칭 루프가 덮어쓰기 전
  // 값이어야 합니다.
  const officialTotal = aptRows.reduce((s, r) => s + (Number(r.generation_count) || 0), 0);
  const referenceTotal = Math.max(officialTotal, Number(result.registryBuildingTotal) || 0);

  const TOLERANCE = 0.5;
  let updatedCount = 0;
  const matchedRegistryAreas = new Set();
  for (const item of aptRows) {
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
      if (best.supplyArea > 0) item.supply_area = best.supplyArea;
      matchedRegistryAreas.add(best);
      updatedCount++;
    }
  }

  const matchedTotal = [...matchedRegistryAreas].reduce((s, a) => s + a.unitCount, 0);
  const unmatched = result.areas.filter(a => !matchedRegistryAreas.has(a) && a.unitCount > 0);
  const addable = pickAddableUnmatchedTypesServer(unmatched, referenceTotal, matchedTotal);
  const addableByOfficialOnly = pickAddableUnmatchedTypesServer(unmatched, officialTotal, matchedTotal);
  const rentalSuspectedAreas = new Set(addable.filter(a => !addableByOfficialOnly.includes(a)));

  let addedCount = 0;
  const templateRow = aptRows[0];
  for (const a of addable) {
    allResults.push({
      ...templateRow,
      exclusive_area: a.exclusiveArea,
      supply_area: a.supplyArea > 0 ? a.supplyArea : undefined,
      generation_count: a.unitCount,
      is_estimated_units: false,
      units_source: "registry",
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
  }

  if (updatedCount === 0 && addedCount === 0) return;

  try {
    // 임시 파일에 먼저 다 쓴 뒤 rename으로 교체합니다 - 쓰는 도중 프로세스가 죽거나
    // 재시작돼도 원본 turnover_results.json은 마지막으로 완성된 상태 그대로 남습니다
    // (rename은 같은 파일시스템 안에서 원자적 교체입니다. 직전 실패로 남은 .tmp 찌꺼기가
    // 있어도 다음 저장이 그 자리를 덮어쓰므로 문제 없습니다).
    const json = JSON.stringify(allResults, null, 2);
    await writeFile(TURNOVER_RESULTS_TMP_PATH, json, "utf-8");
    await rename(TURNOVER_RESULTS_TMP_PATH, TURNOVER_RESULTS_PATH);
    console.log(`[등기 실측 영구반영] ${aptKey}: 갱신 ${updatedCount}건, 추가 ${addedCount}건 -> turnover_results.json 반영 완료 (CSV는 다음 배치 파이프라인 실행 시 갱신됩니다)`);

    // 로컬 반영 성공 직후, 원격 저장소(REMOTE_STORAGE_* 설정 시)에도 같은 내용을
    // 이중화합니다 - Render 재기동으로 로컬 디스크가 초기화돼도 다음 기동 시 이
    // 원격 사본으로 복구됩니다(index.js의 hydrateFromRemoteIfConfigured 참고).
    await putRemoteObject("turnover_results.json", json);
  } catch (err) {
    console.error(`[등기 실측 영구반영 실패] ${aptKey}: ${err.message}`);
  }
}

parentPort.on("message", ({ aptKey, result }) => {
  queueTail = queueTail
    .then(() => persistRegistryMatchToResultsLocked(aptKey, result))
    .catch(err => console.error(`[등기 실측 영구반영 실패] ${aptKey}: ${err.message}`));
});
