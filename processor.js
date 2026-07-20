// 서울 시군구코드(5자리) -> 자치구 명칭 매핑
const LAWD_CD_TO_GU = {
  "11110": "종로구", "11140": "중구", "11170": "용산구", "11200": "성동구",
  "11215": "광진구", "11230": "동대문구", "11260": "중랑구", "11290": "성북구",
  "11305": "강북구", "11320": "도봉구", "11350": "노원구", "11380": "은평구",
  "11410": "서대문구", "11440": "마포구", "11470": "양천구", "11500": "강서구",
  "11530": "구로구", "11545": "금천구", "11560": "영등포구", "11590": "동작구",
  "11620": "관악구", "11650": "서초구", "11680": "강남구", "11710": "송파구",
  "11740": "강동구"
};

// 실거래 레코드로부터 index.js의 uniqueAptKeys와 정확히 동일한 형식의 주소 키를
// 만듭니다("서울특별시 XX구 XX동 지번"). 국토부 실거래가 단지명은 자유 텍스트라
// 서로 다른 실제 건물이 같은 이름을 쓰는 경우가 흔합니다(예: "삼성"이 서울에만
// 22곳, "현대"가 30곳 존재). 이름만으로 단지를 식별하면 이런 동명이건물 데이터가
// 서로 뒤섞이므로, REB/K-apt/건축물대장/청약홈 매칭 단계와 동일하게 "주소"를
// 단지의 유일 식별자로 사용합니다.
function buildAddressKey(trade) {
  const guName = LAWD_CD_TO_GU[trade.lawd_cd] || "";
  if (!guName || !trade.dong || !trade.jibun || !trade.apt_name) return null;
  const city = trade.lawd_cd.startsWith("11") ? "서울특별시" : "경기도";
  return `${city} ${guName} ${trade.dong} ${trade.jibun}`.trim();
}

export class ApartmentTurnoverProcessor {
  constructor() {}

  /**
   * 단지별, 평형별 거래 회전율 및 가격대 통계를 계산합니다.
   *
   * @param {Array<Object>} trades - 실거래가 데이터 리스트
   * @param {Object} rebAptDataByApt - 주소를 키로 하고 부동산원 단지 제원(오브젝트)을 값으로 하는 객체
   * @param {Object} kaptDataByApt - 주소를 키로 하고 K-apt 단지 기본정보(kaptCode/난방방식 등)를 값으로 하는 객체
   * @param {Object} bldRgstDataByApt - 주소를 키로 하고 건축물대장 건폐율(bcRat)/용적률(vlRat)을 값으로 하는 객체
   * @param {Object} subscriptionTypesByApt - 주소를 키로 하고 { "전용면적(2자리)": {unitCount, typeLabel} } 맵을 값으로 하는
   *   청약홈 주택형별 분양정보 매칭 결과 객체. 평형별 실제 세대수/타입(A/B/C) 확인용.
   * @param {Object} subscriptionOnlyAptMeta - 실거래가 한 건도 없는(사용승인 전 신축 등) 단지를 청약홈
   *   데이터만으로 시딩하기 위한 메타 정보. 주소를 키로, { apt_name, gu_name, dong_name, jibun, raw_address }를
   *   값으로 합니다. 이런 단지는 REB/K-apt/건축HUB 어디에도 아직 없어 rebAptDataByApt에 세대수가 없으므로,
   *   총 세대수를 subscriptionTypesByApt 확정 물량 합계로 대체합니다(청약홈은 조합원 분양분을 포함하지
   *   않으므로 재건축/재개발 단지는 이 합계가 실제 총 세대수보다 적을 수 있습니다).
   * @param {Object} duplicateAddressMergeMap - 지번 경계에 걸쳐 REB/실거래가에는 별개 주소로 잡히지만
   *   실제로는 같은 물리적 단지인 경우, "부주소 -> 대표주소" 매핑(index.js에서 단지명+준공일자
   *   일치로 자동 감지). 이 맵에 있는 주소의 거래는 대표주소 쪽 apt_key로 합쳐집니다.
   * @param {Map<string,string>} sharedJibunDisambiguationMap - "baseAddress||원본apt_name" -> 분리된
   *   최종 addressKey. 같은 지번에 이름이 완전히 다른 단지가 여럿 있는 경우(예: 강남구 개포동
   *   12번지의 삼익대청아파트/성원대치2단지), index.js가 실거래 apt_name 유사도로 미리 감지해
   *   "주소 · 단지명" 형태의 키로 분리해둔 것을 그대로 적용합니다.
   * @returns {Array<Object>} 단지별/평형별 회전율 및 금액 정보 통계 목록
   */
  calculateTurnoverRates(trades, rebAptDataByApt, kaptDataByApt = {}, bldRgstDataByApt = {}, subscriptionTypesByApt = {}, subscriptionOnlyAptMeta = {}, duplicateAddressMergeMap = {}, sharedJibunDisambiguationMap = new Map()) {
    const aggregatedData = {};
    let unmatchedCount = 0;

    for (const trade of trades) {
      const area = trade.exclusive_area;
      const amount = trade.deal_amount;

      // 이름이 아니라 주소(구+동+지번)로 단지를 식별합니다. REB/K-apt/건축물대장/
      // 청약홈 매칭 단계(index.js)가 전부 이 형식의 주소를 키로 사용하므로,
      // 여기서는 별도의 이름 유사도 매칭 없이 정확히 일치하는 주소만 채택합니다.
      let addressKey = buildAddressKey(trade);

      // 같은 지번에 이름이 다른 단지가 여럿 있으면(위 sharedJibunDisambiguationMap 설명
      // 참고) 이 거래의 apt_name 기준으로 분리된 키를 적용합니다. 반드시 아래 duplicateAddressMergeMap
      // 적용보다 먼저 해야 합니다 - 분리가 먼저 이뤄져야 그 결과 키를 병합 대상으로 볼 수 있습니다.
      if (addressKey) {
        const disambiguated = sharedJibunDisambiguationMap.get(`${addressKey}||${trade.apt_name}`);
        if (disambiguated) addressKey = disambiguated;
      }

      // 지번 경계에 걸친 동일 단지는 대표 주소 하나로 합칩니다(위 duplicateAddressMergeMap 설명 참고).
      if (addressKey && duplicateAddressMergeMap[addressKey]) {
        addressKey = duplicateAddressMergeMap[addressKey];
      }

      if (!addressKey || !rebAptDataByApt[addressKey]) {
        unmatchedCount++;
        continue;
      }

      if (!aggregatedData[addressKey]) {
        // gu/dong/jibun은 trade 필드가 아니라 addressKey(대표 주소) 자체에서 파싱합니다.
        // 병합된 단지의 경우 이 addressKey에 도달한 "첫" 거래가 부주소(예: 신당동 845)의
        // 거래일 수도 있는데, 그 trade.dong/jibun을 그대로 쓰면 apt_key는 대표 주소(하왕십리동
        // 1050)인데 표시 주소는 부주소(신당동 845)로 나오는 불일치가 생깁니다. addressKey는
        // 기본적으로 "시/도 구 동 지번" 형식(buildAddressKey 참고)이라 역파싱이 안전합니다 -
        // 다만 지번 공유 단지 분리로 " · 단지명" 접미사가 붙어 있을 수 있어 먼저 잘라냅니다.
        const physicalKeyPart = addressKey.split(" · ")[0];
        const keyParts = physicalKeyPart.split(" ");
        aggregatedData[addressKey] = {};
        aggregatedData[addressKey]._meta = {
          apt_name: trade.apt_name,
          gu_name: keyParts[1] || LAWD_CD_TO_GU[trade.lawd_cd] || "기타구",
          dong_name: keyParts[2] || trade.dong || "",
          jibun: keyParts.slice(3).join(" ") || trade.jibun || ""
        };
      }

      const areaKey = parseFloat(area.toFixed(2));

      if (!aggregatedData[addressKey][areaKey]) {
        aggregatedData[addressKey][areaKey] = {
          exclusive_area: areaKey,
          trade_count: 0,
          deals: []
        };
      }

      aggregatedData[addressKey][areaKey].trade_count += 1;

      if (amount > 0) {
        aggregatedData[addressKey][areaKey].deals.push({
          year: trade.deal_year,
          month: trade.deal_month,
          day: trade.deal_day,
          floor: trade.floor,
          amount: amount
        });
      }
    }

    if (unmatchedCount > 0) {
      console.log(`[INFO] 전체 실거래 중 ${unmatchedCount}건이 단지명 미매칭(부동산원 단지 식별 정보 부재) 처리되었습니다.`);
    }

    // 실거래가 전혀 없어 위 루프에서 한 번도 등장하지 않은 단지(청약 공고만 있는 사용승인 전
    // 신축 등)도 청약홈 데이터가 있으면 목록에 추가합니다 - 모든 평형이 0건/0%로 표시됩니다.
    for (const [addressKey, meta] of Object.entries(subscriptionOnlyAptMeta)) {
      if (aggregatedData[addressKey]) continue; // 이미 실거래로 등장한 단지는 건너뜀
      aggregatedData[addressKey] = { _meta: meta };
    }

    const results = [];

    for (const [addressKey, areasMap] of Object.entries(aggregatedData)) {
      const meta = areasMap._meta || { apt_name: "", gu_name: "기타구", dong_name: "", jibun: "" };
      const aptName = meta.apt_name;

      const areasList = Object.values(areasMap).filter(item => item.exclusive_area !== undefined);

      // 제원 오브젝트 획득 및 총 세대수 추출 (모두 주소 키로 조회 - 동명이건물 혼선 방지)
      const complexInfo = rebAptDataByApt[addressKey];
      const kaptInfo = kaptDataByApt[addressKey] || null;
      const bldRgstInfo = bldRgstDataByApt[addressKey] || null;
      const subscriptionMap = subscriptionTypesByApt[addressKey] || null;
      // REB/K-apt/건축HUB 어디에도 없는 신축(사용승인 전) 단지는 complexInfo가 없습니다.
      // 이 경우 총 세대수를 청약홈 확정 물량 합계로 대신합니다 - 조합원 분양분이 있는
      // 재건축/재개발 단지는 이 합계가 실제보다 적을 수 있습니다(대시보드 "확인" 배지로 구분).
      const subscriptionUnitsSum = subscriptionMap
        ? Object.values(subscriptionMap).reduce((sum, v) => sum + v.unitCount, 0)
        : 0;
      // K-apt는 이제(index.js) 지번이 정확히 일치할 때만 매칭되므로(이름 유사도만으로는
      // 채택하지 않음), kaptInfo가 있다는 것 자체가 "이 주소의 진짜 단지"라는 확인입니다.
      // 그런데 한국부동산원 단지식별정보 API는 같은 단지의 동(棟) 일부만 그 지번으로
      // 잡아 세대수를 실제보다 적게 반환하는 경우가 실측으로 확인됐습니다(예: 하왕십리동
      // 1050 한진해모로 - REB는 108세대/1개동, K-apt 공동주택관리정보는 246세대/3개동 -
      // 같은 지번, 같은 이름으로 명백히 동일 단지). REB가 K-apt보다 작으면 REB의 부분
      // 집계로 보고 더 큰(더 완전한) 쪽을 총 세대수로 채택합니다.
      const kaptUnits = kaptInfo ? (kaptInfo.unitCnt || 0) : 0;
      const totalUnits = complexInfo ? Math.max(complexInfo.unitCount || 0, kaptUnits) : (kaptUnits || subscriptionUnitsSum);

      // 청약홈 데이터로 이 단지의 "설계상 존재하는 모든 평형"을 알 수 있는 경우,
      // 실거래가 한 건도 없었던 평형도 0건으로 함께 표시합니다(거래가 없다는 것도
      // 유의미한 정보이며, 실거래만 보여주면 회전율이 0%인 평형이 통째로 누락돼
      // "평형이 몇 개 없다"는 오해를 줄 수 있습니다). 청약홈 데이터가 없는 단지는
      // 어떤 평형이 존재하는지 알 방법이 없어 기존처럼 실거래된 평형만 표시합니다.
      if (subscriptionMap) {
        for (const [areaKey2, subEntry] of Object.entries(subscriptionMap)) {
          const areaNum = parseFloat(areaKey2);
          if (!areasMap[areaNum]) {
            areasMap[areaNum] = {
              exclusive_area: areaNum,
              trade_count: 0,
              deals: []
            };
            areasList.push(areasMap[areaNum]);
          }
        }
      }
      const finalAreasCount = areasList.length;

      if (finalAreasCount === 0 || totalUnits === 0) continue;

      // 평형별 세대수 산정: 청약홈 주택형별 분양정보로 실제 세대수가 확인되는 평형은
      // 그 값을 그대로 사용하고(is_estimated=false), 확인되지 않는 평형만 "남은 세대수"를
      // "남은 평형 종류 수"로 균등 안분합니다(is_estimated=true, 기존 로직과 동일한 방식).
      // 이렇게 하면 일부 평형만 청약 데이터가 있어도 나머지 평형의 안분 정확도가 왜곡되지 않습니다.
      let confirmedUnitsSum = 0;
      const areaAllocations = new Map(); // exclusive_area -> { genCnt, unitType, isEstimated }
      const areasToEstimate = [];

      for (const info of areasList) {
        const areaKey2 = info.exclusive_area.toFixed(2);
        const subEntry = subscriptionMap ? subscriptionMap[areaKey2] : null;

        if (subEntry && subEntry.unitCount > 0) {
          areaAllocations.set(info.exclusive_area, {
            genCnt: subEntry.unitCount,
            unitType: subEntry.typeLabel || "",
            isEstimated: false
          });
          confirmedUnitsSum += subEntry.unitCount;
        } else {
          areasToEstimate.push(info);
        }
      }

      const remainingUnits = Math.max(0, totalUnits - confirmedUnitsSum);
      const remainingCount = areasToEstimate.length;
      const baseGenCount = remainingCount > 0 ? Math.floor(remainingUnits / remainingCount) : 0;
      let remainder = remainingUnits - (baseGenCount * remainingCount);

      for (const info of areasToEstimate) {
        let genCnt = baseGenCount;
        if (remainder > 0) {
          genCnt += 1;
          remainder -= 1;
        }
        if (genCnt <= 0) genCnt = 1;
        areaAllocations.set(info.exclusive_area, { genCnt, unitType: "", isEstimated: true });
      }

      for (let i = 0; i < finalAreasCount; i++) {
        const info = areasList[i];
        const allocation = areaAllocations.get(info.exclusive_area);
        const genCnt = allocation.genCnt;
        const unitType = allocation.unitType;
        const isEstimatedUnits = allocation.isEstimated;

        const tradeCnt = info.trade_count;
        const deals = info.deals;
        const amounts = deals.map(d => d.amount);

        const turnoverRate = (tradeCnt / genCnt) * 100;

        let avgDealAmount = 0;
        let minDealAmount = 0;
        let maxDealAmount = 0;

        if (amounts.length > 0) {
          const sum = amounts.reduce((acc, curr) => acc + curr, 0);
          avgDealAmount = Math.round(sum / amounts.length);
          minDealAmount = Math.min(...amounts);
          maxDealAmount = Math.max(...amounts);
        }

        results.push({
          // apt_key: 주소 기반 유일 식별자(동명이건물 구분용). apt_name은 화면 표시용
          // 이름일 뿐이라 여러 실제 건물이 같은 값을 가질 수 있습니다(예: "삼성" 22곳).
          apt_key: addressKey,
          apt_name: aptName,
          jibun: meta.jibun,
          gu_name: meta.gu_name,
          dong_name: meta.dong_name,
          exclusive_area: info.exclusive_area,
          generation_count: genCnt,
          // unit_type: 청약홈 주택형별 분양정보에서 확인된 A/B/C 타입 라벨(없으면 빈 문자열).
          // is_estimated_units: true면 generation_count가 실측이 아닌 균등 안분 추정치입니다.
          unit_type: unitType,
          is_estimated_units: isEstimatedUnits,
          trade_count: tradeCnt,
          turnover_rate: parseFloat(turnoverRate.toFixed(4)),
          avg_deal_amount: avgDealAmount,
          min_deal_amount: minDealAmount,
          max_deal_amount: maxDealAmount,
          deals: deals,

          // 단지 상세 제원 필드
          // - adres/useapr_dt: 한국부동산원 단지식별정보 API(실측 확인된 필드)
          // - kapt_code/heat_type/corridor_type/builder/office_tel: 건축물대장에는 존재하지
          //   않는 개념이라(공동주택관리법상 K-apt 등록 정보) K-apt 매칭 실패 시(의무관리대상이
          //   아닌 소규모 단지 등) 보완할 방법이 없어 그대로 빈 값입니다.
          // - floor_cnt_max/total_parking: K-apt에 없어도 건축물대장(표제부/총괄표제부)
          //   자체에 있는 정보라 bldRgstInfo로 보완 가능합니다.
          // adres: REB가 실패하면(신축 단지 등) K-apt 도로명/지번주소 -> 건축물대장
          // 총괄표제부 대지위치 -> 청약홈 공고 주소(사용승인 전이라 위 셋 다 없는 단지) 순으로 폴백합니다.
          adres: (complexInfo && complexInfo.adres) || (kaptInfo && (kaptInfo.roadAddr || kaptInfo.bjdAddr)) || (bldRgstInfo && bldRgstInfo.platPlc) || meta.raw_address || "",
          dong_cnt: (kaptInfo && kaptInfo.dongCnt) || (complexInfo && complexInfo.dongCnt) || 0,
          useapr_dt: (complexInfo && complexInfo.useaprDt) || (kaptInfo && kaptInfo.useDate) || "",
          kapt_code: (kaptInfo && kaptInfo.kaptCode) || "",
          heat_type: (kaptInfo && kaptInfo.heatType) || "",
          corridor_type: (kaptInfo && kaptInfo.corridorType) || "",
          floor_cnt_max: (kaptInfo && kaptInfo.topFloor) || (bldRgstInfo && bldRgstInfo.floorCntMax) || 0,
          builder: (kaptInfo && kaptInfo.builder) || "",
          total_parking: (kaptInfo && kaptInfo.totalParking) || (bldRgstInfo && bldRgstInfo.totalParking) || 0,
          office_tel: (kaptInfo && kaptInfo.officeTel) || "",

          // 건폐율/용적률: 국토교통부 건축HUB_건축물대장정보 서비스(getBrRecapTitleInfo/getBrTitleInfo) 매칭 결과.
          // 매칭 실패 시(지번 불일치, 미승인 지역 등) 0으로 채워지며 대시보드에서 "정보 없음"으로 표시됩니다.
          bc_rat: (bldRgstInfo && bldRgstInfo.bcRat) || 0,
          vl_rat: (bldRgstInfo && bldRgstInfo.vlRat) || 0
        });
      }
    }

    results.sort((a, b) => {
      if (a.gu_name !== b.gu_name) return a.gu_name.localeCompare(b.gu_name, "ko");
      if (a.dong_name !== b.dong_name) return a.dong_name.localeCompare(b.dong_name, "ko");
      if (a.apt_name !== b.apt_name) return a.apt_name.localeCompare(b.apt_name, "ko");
      // 같은 구/동/이름이라도 동명이건물이면(apt_key가 다름) 지번 순으로 안정 정렬합니다.
      if (a.apt_key !== b.apt_key) return a.apt_key.localeCompare(b.apt_key, "ko");
      return a.exclusive_area - b.exclusive_area;
    });

    return results;
  }
}
