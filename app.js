const app = document.getElementById('app');
const cache = new Map(JSON.parse(localStorage.getItem('analysisCache') || '[]'));
const FALLBACK_LOCATION = { lat: 37.5665, lon: 126.978, display_name: '서울특별시 시청 (기본 위치)' };

const MODES = {
  founder: { name: '창업', weights: { demand: 40, competition: 35, accessibility: 15, risk: 5, trend: 5 } },
  franchise: { name: '프랜차이즈', weights: { demand: 35, competition: 25, homogeneity: 25, accessibility: 10, risk: 5 } },
  realestate: { name: '부동산', weights: { trend: 35, demand: 20, accessibility: 15, competition: 10, risk: 20 } }
};

function navigate(page, params = {}) {
  const url = new URL(location.href);
  url.searchParams.set('page', page);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  location.href = url.toString();
}

function getParams() { return new URLSearchParams(location.search); }
function clamp(v, min = 0, max = 100) { return Math.max(min, Math.min(max, v)); }
function scoreFromDensity(v, scale) { return clamp(100 * (1 - Math.exp(-v / scale))); }

async function geocode(query) {
  const res = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=8&addressdetails=1&q=${encodeURIComponent(query)}`);
  const data = await res.json();
  return Array.isArray(data) && data.length ? data : [FALLBACK_LOCATION];
}

async function reverseGeocode(lat, lon) {
  const res = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}`);
  return res.json();
}

async function overpassAround(lat, lon, radius, q) {
  const body = `[out:json][timeout:25];(${q});out center;`;
  const res = await fetch('https://overpass-api.de/api/interpreter', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `data=${encodeURIComponent(body)}`
  });
  const json = await res.json();
  return (json.elements || []).map((e) => ({ lat: e.lat || e.center?.lat, lon: e.lon || e.center?.lon, tags: e.tags || {} }));
}

async function elevation(lat, lon) {
  const res = await fetch(`https://api.open-meteo.com/v1/elevation?latitude=${lat}&longitude=${lon}`);
  const json = await res.json();
  return json.elevation?.[0] ?? null;
}

function toKey({ lat, lon, radius, mode }) { return `${lat.toFixed(4)}:${lon.toFixed(4)}:${radius}:${mode}`; }

async function analyze({ lat, lon, radius, mode }) {
  const key = toKey({ lat, lon, radius, mode });
  if (cache.has(key)) return { ...cache.get(key), cached: true };
  const warnings = [];

  const q = {
    shops: `node(around:${radius},${lat},${lon})[shop];way(around:${radius},${lat},${lon})[shop]`,
    transport: `node(around:${radius},${lat},${lon})[public_transport];node(around:${radius},${lat},${lon})[highway=bus_stop];node(around:${radius},${lat},${lon})[railway=station]`,
    demand: `node(around:${radius},${lat},${lon})[amenity];node(around:${radius},${lat},${lon})[building=residential]`,
    risk: `node(around:${radius},${lat},${lon})[landuse=construction];way(around:${radius},${lat},${lon})[landuse=construction]`
  };

  let shops = [], transport = [], demandPois = [], riskPois = [], elev = null, address = '';
  try { shops = await overpassAround(lat, lon, radius, q.shops); } catch { warnings.push('경쟁 데이터 일부 누락'); }
  try { transport = await overpassAround(lat, lon, radius, q.transport); } catch { warnings.push('교통 데이터 일부 누락'); }
  try { demandPois = await overpassAround(lat, lon, radius, q.demand); } catch { warnings.push('수요 데이터 일부 누락'); }
  try { riskPois = await overpassAround(lat, lon, radius, q.risk); } catch { warnings.push('리스크 데이터 일부 누락'); }
  try { elev = await elevation(lat, lon); } catch { warnings.push('고도 데이터 누락'); }
  try { address = (await reverseGeocode(lat, lon)).display_name || `${lat}, ${lon}`; } catch { address = `${lat}, ${lon}`; }

  const area = Math.PI * radius * radius;
  const demandDensity = demandPois.length / area * 1e6;
  const competitionDensity = shops.length / area * 1e6;
  const transportDensity = transport.length / area * 1e6;
  const constructionDensity = riskPois.length / area * 1e6;

  const demand = scoreFromDensity(demandDensity, 30);
  const competitionRaw = scoreFromDensity(competitionDensity, 20);
  const competition = clamp(100 - competitionRaw + demand * 0.2);
  const accessibility = scoreFromDensity(transportDensity, 15);
  const risk = clamp(100 - scoreFromDensity(constructionDensity, 10) - (elev !== null ? clamp((20 - elev) * 2, 0, 30) : 0));
  const trend = clamp((demand * 0.4 + accessibility * 0.3 + (100 - competition) * 0.2 + risk * 0.1));

  const homogeneity = calcHomogeneity({ lat, lon, radius, points: demandPois });

  if (!shops.length && !transport.length && !demandPois.length) {
    warnings.push('외부 API 응답이 없어 기본 추정치로 분석했습니다.');
  }
  const metrics = { demand, competition, accessibility, risk, trend, homogeneity };

  const modeDef = MODES[mode];
  const availableWeights = Object.entries(modeDef.weights).filter(([k]) => Number.isFinite(metrics[k]));
  const totalW = availableWeights.reduce((s, [, w]) => s + w, 0) || 1;
  const totalScore = availableWeights.reduce((s, [k, w]) => s + metrics[k] * w, 0) / totalW;

  const percentile = Math.round(totalScore);
  const topCards = makeTopCards(mode, metrics, totalScore);
  const reasons = makeReasons(mode, metrics);
  const headline = makeHeadline(mode, metrics);

  const result = {
    query: { lat, lon, radius, mode },
    address,
    generatedAt: new Date().toISOString(),
    asOf: new Date().toISOString().slice(0, 10),
    warnings,
    metrics,
    totalScore: Math.round(totalScore),
    percentile,
    topCards,
    reasons,
    headline,
    layers: { shops, transport, demandPois, riskPois }
  };

  cache.set(key, result);
  localStorage.setItem('analysisCache', JSON.stringify(Array.from(cache.entries()).slice(-30)));
  return result;
}

function calcHomogeneity({ lat, lon, radius, points }) {
  const quadCounts = [0, 0, 0, 0];
  points.forEach((p) => {
    const east = p.lon >= lon;
    const north = p.lat >= lat;
    const idx = north && east ? 0 : north && !east ? 1 : !north && east ? 2 : 3;
    quadCounts[idx]++;
  });
  const mean = quadCounts.reduce((a, b) => a + b, 0) / 4;
  if (!mean) return 0;
  const std = Math.sqrt(quadCounts.reduce((s, c) => s + (c - mean) ** 2, 0) / 4);
  const cv = std / mean;
  return clamp(100 - cv * 100);
}

function makeTopCards(mode, m, total) {
  if (mode === 'founder') return [
    ['수요 점수', m.demand],
    ['경쟁 부담(낮을수록 좋음)', 100 - m.competition],
    ['매출 가능성 등급', total]
  ];
  if (mode === 'franchise') return [
    ['확장 가능성', total],
    ['상권 규모', m.demand],
    ['균질성', m.homogeneity]
  ];
  return [
    ['성장 잠재력', m.trend],
    ['임대 안정성', (m.demand + m.risk) / 2],
    ['리스크 안전성', m.risk]
  ];
}

function makeHeadline(mode, m) {
  const level = (v) => v > 70 ? '상' : v > 45 ? '중' : '하';
  if (mode === 'founder') return `이 위치는 창업 성공 가능성 ${level((m.demand + m.competition) / 2)}. 핵심 요인은 수요/경쟁입니다.`;
  if (mode === 'franchise') return `이 상권은 확장 가능성 ${level((m.demand + m.homogeneity) / 2)}. 균질성 ${level(m.homogeneity)}로 복제 출점 ${m.homogeneity > 55 ? '유리' : '불리'}.`;
  return `이 지역은 성장 잠재력 ${level(m.trend)}. 다만 리스크 요인(저지대/공사)은 주의가 필요합니다.`;
}

function makeReasons(mode, m) {
  if (mode === 'founder') return [
    `수요 ${Math.round(m.demand)}점으로 배후 잠재수요가 ${m.demand > 60 ? '양호' : '보통/낮음'}합니다.`,
    `경쟁 ${Math.round(m.competition)}점(수요 대비 보정)으로 포화도는 ${m.competition > 60 ? '관리 가능' : '주의'}입니다.`,
    `접근성 ${Math.round(m.accessibility)}점으로 유입 편의성이 반영되었습니다.`
  ];
  if (mode === 'franchise') return [
    `수요 총량 ${Math.round(m.demand)}점과 경쟁 보정값을 합쳐 확장성을 계산했습니다.`,
    `균질성 ${Math.round(m.homogeneity)}점(4분면 편차 기반)으로 지역 편차를 확인했습니다.`,
    `권장 출점 수는 ${m.homogeneity > 60 ? '2~4개' : '1~2개'} 범위로 추정됩니다.`
  ];
  return [
    `트렌드 ${Math.round(m.trend)}점은 수요·접근성·경쟁 변수를 합산한 상대평가입니다.`,
    `임대 안정성은 수요 ${Math.round(m.demand)}점과 리스크 ${Math.round(m.risk)}점 기반 근사입니다.`,
    `리스크가 낮을수록(점수 높음) 장기 공실 위험 방어력이 높습니다.`
  ];
}

function renderHome() {
  app.innerHTML = document.getElementById('home-template').innerHTML;
  const form = document.getElementById('search-form');
  const list = document.getElementById('autocomplete');
  const queryEl = document.getElementById('query');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const items = await geocode(queryEl.value);
    list.innerHTML = '';
    items.slice(0, 5).forEach((it) => {
      const b = document.createElement('button');
      b.textContent = it.display_name;
      b.onclick = () => navigate('result', { lat: it.lat, lon: it.lon, mode: 'founder', radius: 500 });
      list.appendChild(b);
    });
  });

  let inputTimer = null;
  queryEl.addEventListener('input', () => {
    clearTimeout(inputTimer);
    const keyword = queryEl.value.trim();
    if (keyword.length < 2) {
      list.innerHTML = '';
      return;
    }
    inputTimer = setTimeout(async () => {
      const items = await geocode(keyword);
      list.innerHTML = '';
      items.slice(0, 5).forEach((it) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = it.display_name;
        b.onclick = () => navigate('result', { lat: it.lat, lon: it.lon, mode: 'founder', radius: 500 });
        list.appendChild(b);
      });
    }, 250);
  });

  document.getElementById('use-location').onclick = () => {
    if (!navigator.geolocation) return alert('브라우저 위치 기능 미지원');
    navigator.geolocation.getCurrentPosition(
      (pos) => navigate('result', { lat: pos.coords.latitude, lon: pos.coords.longitude, mode: 'founder', radius: 500 }),
      () => alert('위치 권한이 거부되어 수동 검색으로 전환합니다.')
    );
  };

  document.getElementById('pick-map').onclick = () => {
    const sec = document.getElementById('picker-section');
    sec.classList.remove('hidden');
    const m = L.map('picker-map').setView([37.5665, 126.978], 13);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '&copy; OSM' }).addTo(m);
    let picked = null;
    m.on('click', (e) => {
      picked = e.latlng;
      if (window.pickMarker) m.removeLayer(window.pickMarker);
      window.pickMarker = L.marker(e.latlng).addTo(m);
    });
    document.getElementById('analyze-picked').onclick = () => {
      if (!picked) return alert('지도를 클릭해 위치를 선택하세요.');
      navigate('result', { lat: picked.lat, lon: picked.lng, mode: 'founder', radius: 500 });
    };
  };
}

async function renderResult() {
  app.innerHTML = document.getElementById('result-template').innerHTML;
  const p = getParams();
  const lat = Number(p.get('lat'));
  const lon = Number(p.get('lon'));
  const mode = p.get('mode') || 'founder';
  const radius = Number(p.get('radius') || 500);
  if (!lat || !lon) return (app.innerHTML = '<section class="card">좌표가 없어 분석할 수 없습니다.</section>');

  document.getElementById('mode-select').value = mode;
  document.getElementById('radius-select').value = String(radius);
  document.getElementById('mode-select').onchange = (e) => navigate('result', { lat, lon, mode: e.target.value, radius });
  document.getElementById('radius-select').onchange = (e) => navigate('result', { lat, lon, mode, radius: e.target.value });

  const data = await analyze({ lat, lon, mode, radius });
  document.getElementById('headline').textContent = `${data.headline} (종합 ${data.totalScore}점 / 상위 ${data.percentile}%)`;

  const badges = document.getElementById('warning-badges');
  data.warnings.forEach((w) => {
    const b = document.createElement('span');
    b.className = 'badge';
    b.textContent = w;
    badges.appendChild(b);
  });

  const cards = document.getElementById('top-cards');
  data.topCards.forEach(([name, score]) => {
    const el = document.createElement('article');
    el.className = 'mini-card';
    el.innerHTML = `<h4>${name}</h4><div class='score'>${Math.round(score)}</div><small>상대평가</small>`;
    cards.appendChild(el);
  });

  const reasonEl = document.getElementById('reasons');
  data.reasons.slice(0, 3).forEach((r) => {
    const li = document.createElement('li');
    li.textContent = r;
    reasonEl.appendChild(li);
  });

  document.getElementById('detail-demand').textContent = `점수 ${Math.round(data.metrics.demand)} / POI ${data.layers.demandPois.length}`;
  document.getElementById('detail-competition').textContent = `점수 ${Math.round(data.metrics.competition)} / 동종업종 ${data.layers.shops.length}`;
  document.getElementById('detail-accessibility').textContent = `점수 ${Math.round(data.metrics.accessibility)} / 교통노드 ${data.layers.transport.length}`;
  document.getElementById('detail-risk').textContent = `점수 ${Math.round(data.metrics.risk)} / 공사요소 ${data.layers.riskPois.length}`;
  document.getElementById('detail-trend').textContent = `점수 ${Math.round(data.metrics.trend)} / 생성일 ${data.generatedAt}`;

  document.getElementById('add-compare').onclick = () => {
    const box = JSON.parse(localStorage.getItem('compareBox') || '[]');
    const next = [
      ...box.filter((x) => x.query.lat !== data.query.lat || x.query.lon !== data.query.lon),
      data
    ].slice(-3);
    localStorage.setItem('compareBox', JSON.stringify(next));
    alert('비교함에 추가되었습니다.');
  };

  document.getElementById('download-pdf').onclick = () => window.print();
  document.getElementById('share-link').onclick = () => {
    const id = `s_${Date.now()}`;
    const shares = JSON.parse(localStorage.getItem('shares') || '{}');
    shares[id] = data;
    localStorage.setItem('shares', JSON.stringify(shares));
    const link = `${location.origin}${location.pathname}?page=share&id=${id}`;
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(link);
      alert('공유 링크가 복사되었습니다.');
    } else {
      prompt('클립보드가 제한되어 링크를 직접 복사하세요.', link);
    }
  };

  setupMap(data);
}

function setupMap(data) {
  const { lat, lon, radius } = data.query;
  const map = L.map('result-map').setView([lat, lon], 15);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '&copy; OSM' }).addTo(map);
  L.circle([lat, lon], { radius }).addTo(map);
  L.marker([lat, lon]).addTo(map).bindPopup(data.address);

  const layerGroups = {
    competition: L.layerGroup(data.layers.shops.map((p) => L.circleMarker([p.lat, p.lon], { color: 'red', radius: 3 }))),
    transport: L.layerGroup(data.layers.transport.map((p) => L.circleMarker([p.lat, p.lon], { color: 'blue', radius: 3 }))),
    demand: L.layerGroup(data.layers.demandPois.map((p) => L.circleMarker([p.lat, p.lon], { color: 'green', radius: 2 }))),
    risk: L.layerGroup(data.layers.riskPois.map((p) => L.circleMarker([p.lat, p.lon], { color: 'orange', radius: 4 })))
  };
  layerGroups.competition.addTo(map);

  document.querySelectorAll('[data-layer]').forEach((chk) => {
    chk.onchange = (e) => {
      const g = layerGroups[e.target.dataset.layer];
      if (e.target.checked) g.addTo(map); else map.removeLayer(g);
    };
  });
}

function renderCompare() {
  app.innerHTML = document.getElementById('compare-template').innerHTML;
  const items = JSON.parse(localStorage.getItem('compareBox') || '[]');
  if (!items.length) {
    app.querySelector('.card').innerHTML += '<p>비교함이 비어 있습니다.</p>';
    return;
  }
  const cards = document.getElementById('compare-cards');
  items.forEach((it, idx) => {
    const c = document.createElement('article');
    c.className = 'mini-card';
    c.innerHTML = `<h4>후보 ${idx + 1}</h4><p>${it.address}</p><p>종합 ${it.totalScore}</p><button data-i="${idx}">제거</button>`;
    cards.appendChild(c);
  });
  cards.querySelectorAll('button').forEach((b) => {
    b.onclick = () => {
      const i = Number(b.dataset.i);
      items.splice(i, 1);
      localStorage.setItem('compareBox', JSON.stringify(items));
      renderCompare();
    };
  });

  const table = document.getElementById('compare-table');
  table.innerHTML = '<tr><th>지표</th>' + items.map((_, i) => `<th>후보 ${i + 1}</th>`).join('') + '</tr>';
  ['demand', 'competition', 'accessibility', 'risk', 'trend'].forEach((k) => {
    table.innerHTML += `<tr><td>${k}</td>${items.map((it) => `<td>${Math.round(it.metrics[k] ?? 0)}</td>`).join('')}</tr>`;
  });
  const best = items.map((it, i) => ({ i, s: it.totalScore })).sort((a, b) => b.s - a.s)[0];
  document.getElementById('recommendation').textContent = `모드 기준 1순위 추천: 후보 ${best.i + 1}`;
}

function renderShare() {
  app.innerHTML = document.getElementById('share-template').innerHTML;
  const id = getParams().get('id');
  const shares = JSON.parse(localStorage.getItem('shares') || '{}');
  const data = shares[id];
  if (!data) return (document.getElementById('share-summary').textContent = '공유 데이터가 없거나 만료되었습니다.');
  document.getElementById('share-summary').innerHTML = `
    <p><b>${data.address}</b></p>
    <p>${data.headline}</p>
    <p>Top3: ${data.topCards.map(([n, s]) => `${n} ${Math.round(s)}`).join(' / ')}</p>
  `;
  document.getElementById('open-report').href = `?page=result&lat=${data.query.lat}&lon=${data.query.lon}&radius=${data.query.radius}&mode=${data.query.mode}`;
}

function renderStatic(id) { app.innerHTML = document.getElementById(id).innerHTML; }

(async function bootstrap() {
  const page = getParams().get('page') || 'home';
  if (page === 'home') renderHome();
  else if (page === 'result') await renderResult();
  else if (page === 'compare') renderCompare();
  else if (page === 'about') renderStatic('about-template');
  else if (page === 'help') renderStatic('help-template');
  else if (page === 'share') renderShare();
  else renderHome();
})();
