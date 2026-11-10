// Display controls only. Navigation and projection never change coordinator state.
const views = {
  overview: ['01 / RUNTIME OVERVIEW', '协同运行总览', '从设备接入到任务执行，让每一次协同清晰可见。'],
  resources: ['02 / DEVICE RESOURCES', '设备资源', '看清每个终端贡献的资源、执行能力与当前占用。'],
  tasks: ['03 / DECISION & TRACE', '任务调度与追踪', '谁在执行，为什么选择它，每个阶段发生了什么。'],
  network: ['04 / CONNECTIVITY', '网络与数据传输', '以方向探测和端点回执，观察设备之间的数据路径。'],
  recovery: ['05 / FAILURE & RECOVERY', '异常与恢复', '保留异常证据，区分任务状态与资源结算。']
};
export function showView(view, focus = false) {
  if (!Object.hasOwn(views, view)) view = 'overview';
  const [eyebrow, title, description] = views[view];
  document.getElementById('view-eyebrow').textContent = eyebrow;
  document.getElementById('view-title').replaceChildren(document.createTextNode(title));
  const dot = document.createElement('span'); dot.className = 'title-dot'; dot.textContent = '.';
  document.getElementById('view-title').append(dot);
  document.getElementById('view-description').textContent = description;
  for (const panel of document.querySelectorAll('[data-panel]')) panel.hidden = panel.dataset.panel !== view;
  for (const link of document.querySelectorAll('[data-view]')) {
    if (link.dataset.view === view) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
  }
  if (focus) { document.getElementById('main').focus({preventScroll:true}); window.scrollTo({top:0,behavior:'instant'}); }
}
export function navigate(view) {
  if (!Object.hasOwn(views, view)) return;
  if (location.hash !== '#'+view) history.pushState(null, '', '#'+view);
  showView(view, true);
}

// Keep disclosures, table scroll and keyboard focus stable during live refreshes.
export function replaceContent(id, html) {
  const root = document.getElementById(id);
  if (root.renderedContent === html && root.renderedNodes?.length === root.childNodes.length && root.renderedNodes.every((node,i)=>node===root.childNodes[i])) return;
  const opened = new Set([...root.querySelectorAll('details[open][data-detail]')].map(el=>el.dataset.detail));
  const active = root.contains(document.activeElement) ? document.activeElement : null;
  const job = active?.dataset.job, detail = active?.closest('details')?.dataset.detail;
  const device = active?.dataset.device, card = active?.dataset.deviceCard;
  const scrolls = [...root.querySelectorAll('.table-wrap,.topology-scroll,.network-list')].map(el=>[el.scrollLeft,el.scrollTop]);
  root.innerHTML = html;
  root.renderedContent = html;
  root.renderedNodes = [...root.childNodes];
  for (const el of root.querySelectorAll('details[data-detail]')) if (opened.has(el.dataset.detail)) el.open = true;
  [...root.querySelectorAll('.table-wrap,.topology-scroll,.network-list')].forEach((el,i)=>{if(scrolls[i]){el.scrollLeft=scrolls[i][0];el.scrollTop=scrolls[i][1];}});
  const target = job ? [...root.querySelectorAll('button[data-job]')].find(el=>el.dataset.job===job)
    : detail ? [...root.querySelectorAll('details[data-detail]')].find(el=>el.dataset.detail===detail)?.querySelector('summary')
    : device ? [...root.querySelectorAll('[data-device]')].find(el=>el.dataset.device===device)
    : card ? [...root.querySelectorAll('[data-device-card]')].find(el=>el.dataset.deviceCard===card) : null;
  target?.focus({preventScroll:true});
  if (id === 'topology') drawTopology();
}

// Route visual association lines from the rendered hub to the actual node cards.
// Geometry carries no reachability, packet-flow or latency semantics.
function drawTopology() {
  const scene = document.querySelector('.topology-scene');
  const svg = scene?.querySelector('.topology-wires'), hub = scene?.querySelector('.hub-orbit');
  if (!svg || !hub || !scene.clientWidth || getComputedStyle(svg).display === 'none') return;
  const box = scene.getBoundingClientRect(), source = hub.getBoundingClientRect();
  const x = source.right - box.left, y = source.top + source.height / 2 - box.top;
  svg.setAttribute('viewBox', `0 0 ${box.width} ${box.height}`);
  svg.replaceChildren();
  const ns = 'http://www.w3.org/2000/svg';
  for (const node of scene.querySelectorAll('.topo-device')) {
    const rect = node.getBoundingClientRect(), endX = rect.left-box.left, endY = rect.top+rect.height/2-box.top;
    const elbow = x + (endX-x) * .58;
    const path = document.createElementNS(ns,'path');
    path.setAttribute('d',`M${x} ${y} H${elbow} V${endY} H${endX}`);
    const point = document.createElementNS(ns,'circle');
    point.setAttribute('cx',String(endX)); point.setAttribute('cy',String(endY)); point.setAttribute('r','3');
    svg.append(path, point);
  }
}
const topologyObserver = new ResizeObserver(drawTopology);
topologyObserver.observe(document.getElementById('topology'));
document.fonts.ready.then(drawTopology);
window.addEventListener('resize',drawTopology);

document.addEventListener('click', event => {
  const link = event.target.closest('a[href^="#"]');
  if (!link || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || event.button !== 0) return;
  if (link.hash === '#main') { event.preventDefault(); document.getElementById('main').focus(); return; }
  const view = link.hash.slice(1); if (!Object.hasOwn(views, view)) return;
  event.preventDefault(); navigate(view);
});
window.addEventListener('popstate',()=>showView(location.hash.slice(1),true));
window.addEventListener('hashchange',()=>showView(location.hash.slice(1),true));
const present = document.getElementById('present');
present.addEventListener('click',()=>{
  const enabled = document.documentElement.classList.toggle('presentation');
  present.setAttribute('aria-pressed', String(enabled)); present.textContent = enabled ? '标准字号' : '大字展示';
});
const fullscreen = document.getElementById('fullscreen');
const displayMessage = document.getElementById('display-message');
fullscreen.addEventListener('click',async()=>{
  displayMessage.hidden = true;
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else if (document.documentElement.requestFullscreen) await document.documentElement.requestFullscreen();
    else throw new Error('FULLSCREEN_UNAVAILABLE');
  } catch {
    displayMessage.textContent = '当前浏览器未启用网页全屏。可使用浏览器的全屏功能，或切换“大字展示”。';
    displayMessage.hidden = false;
  }
});
document.addEventListener('fullscreenchange',()=>{
  fullscreen.setAttribute('aria-label',document.fullscreenElement?'退出全屏':'进入全屏');
  fullscreen.title = document.fullscreenElement ? '退出全屏（Esc）' : '全屏展示；Esc 退出';
});
showView(location.hash.slice(1));

{const link=document.getElementById('photo-studio-link');if(link)link.href='photo.html?space='+encodeURIComponent(new URL(location.href).searchParams.get('space')||'');}
