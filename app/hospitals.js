// 시연용 병원 시드 목록 (프로토타입)
// 실제 운영 시에는 NEMC 응급의료기관 목록 API 또는 Firestore의 hospitals 컬렉션으로 대체합니다.
// level: 응급의료기관 종별 — '3'=상급종합(권역응급의료센터), '2'=종합병원(지역응급의료센터), '1'=병원급(지역응급의료기관)
export const LEVELS = {
    '3': { name: '3차', desc: '상급종합병원 · 권역응급의료센터' },
    '2': { name: '2차', desc: '종합병원 · 지역응급의료센터' },
    '1': { name: '1차', desc: '병원급 · 지역응급의료기관' },
};

export function levelName(level) {
    return LEVELS[level]?.name || '기타';
}

export const HOSPITALS = [
    // 3차 (상급종합병원 · 권역응급의료센터)
    { id: 'H001', name: '서울대학교병원', level: '3', sido: '서울특별시', sgg: '종로구', depts: ['흉부외과', '신경외과', '응급의학과', '소아과'] },
    { id: 'H002', name: '서울아산병원', level: '3', sido: '서울특별시', sgg: '송파구', depts: ['흉부외과', '신경외과', '심장내과', '외상외과'] },
    { id: 'H003', name: '세브란스병원', level: '3', sido: '서울특별시', sgg: '서대문구', depts: ['신경외과', '흉부외과', '응급의학과'] },
    { id: 'H004', name: '삼성서울병원', level: '3', sido: '서울특별시', sgg: '강남구', depts: ['심장내과', '신경외과', '응급의학과'] },
    { id: 'H005', name: '서울성모병원', level: '3', sido: '서울특별시', sgg: '서초구', depts: ['흉부외과', '소아과', '응급의학과'] },
    { id: 'H006', name: '고려대구로병원', level: '3', sido: '서울특별시', sgg: '구로구', depts: ['외상외과', '신경외과', '응급의학과'] },
    { id: 'H007', name: '한양대학교병원', level: '3', sido: '서울특별시', sgg: '성동구', depts: ['흉부외과', '응급의학과'] },
    { id: 'H008', name: '이대목동병원', level: '3', sido: '서울특별시', sgg: '양천구', depts: ['소아과', '산부인과', '응급의학과'] },

    // 2차 (종합병원 · 지역응급의료센터)
    { id: 'H009', name: '보라매병원', level: '2', sido: '서울특별시', sgg: '동작구', depts: ['응급의학과', '내과', '외과', '신경외과'] },
    { id: 'H010', name: '서울의료원', level: '2', sido: '서울특별시', sgg: '중랑구', depts: ['응급의학과', '내과', '외과'] },
    { id: 'H011', name: '강동성심병원', level: '2', sido: '서울특별시', sgg: '강동구', depts: ['응급의학과', '흉부외과', '신경외과'] },
    { id: 'H012', name: '에이치플러스 양지병원', level: '2', sido: '서울특별시', sgg: '관악구', depts: ['응급의학과', '내과', '외과'] },
    { id: 'H013', name: '한일병원', level: '2', sido: '서울특별시', sgg: '도봉구', depts: ['응급의학과', '내과'] },

    // 1차 (병원급 · 지역응급의료기관)
    { id: 'H014', name: '삼육서울병원', level: '1', sido: '서울특별시', sgg: '동대문구', depts: ['응급의학과', '내과'] },
    { id: 'H015', name: '동부제일병원', level: '1', sido: '서울특별시', sgg: '중랑구', depts: ['응급의학과', '정형외과'] },
];

export function hospitalById(id) {
    return HOSPITALS.find((h) => h.id === id) || null;
}
