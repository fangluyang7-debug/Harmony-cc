'use strict';

const $ = id => document.getElementById(id);
const token = location.hash.slice(1) || sessionStorage.getItem('runtime-token') || '';
if (location.hash) {
  sessionStorage.setItem('runtime-token', token);
  history.replaceState(null, '', location.pathname);
}
const isCenter = document.body.dataset.page === 'center';
const labels = {
  STOPPED: '未启动', STARTING: '正在启动', RUNNING: '运行中',
  STOPPING: '正在停止并结算', FAILED: '启动或运行失败，请查看日志'
};
let snapshot;
let busy = false;
let installation = { paired: false };

async function api(route, input) {
  const response = await fetch(route, {
    method: input === undefined ? 'GET' : 'POST',
    headers: { 'X-Runtime-Token': token, 'Content-Type': 'application/json' },
    body: input === undefined ? undefined : JSON.stringify(input)
  });
  if (response.status === 403) throw Error('本机控制会话已失效，请重新打开启动器。');
  const data = await response.json();
  if (!response.ok) throw Error(data.error || '请求失败');
  return data;
}

function message(id, value = '') {
  $(id).textContent = value;
  $(id).hidden = !value;
}

function render() {
  if (!snapshot) return;
  const { state, mode, url, addresses, logs, role } = snapshot;
  const pending = state === 'STARTING' || state === 'STOPPING';
  const running = state === 'RUNNING';
  const otherRole = (pending || running) && mode !== (isCenter ? 'center' : 'agent');
  document.body.dataset.state = otherRole ? 'STOPPED' : state;
  $('status').textContent = otherRole ? '另一个角色正在运行，请先停止该服务' : labels[state];
  $('logs').textContent = logs.join('\n') || '暂无运行日志';
  $('role-link').hidden = role !== 'both';

  if (isCenter) {
    const select = $('address');
    const selected = select.value;
    const options = JSON.stringify(addresses);
    if (select.dataset.items !== options) {
      select.replaceChildren(...addresses.map(item => new Option(item.name + ' · ' + item.address, item.address)));
      if (addresses.some(item => item.address === selected)) select.value = selected;
      select.dataset.items = options;
    }
    const ready = running && !otherRole;
    const action = ready ? '关闭协调中心' : pending && !otherRole ? labels[state] : '启动协调中心';
    $('power-title').textContent = action;
    $('power').setAttribute('aria-label', action);
    $('power').disabled = busy || pending || otherRole || (!ready && !select.value);
    select.disabled = busy || pending || running;
    $('port').disabled = select.disabled;
    $('center-suite').disabled = select.disabled;
    $('dashboard').disabled = !ready;
    $('devices').disabled = !ready;
    message('public-url', ready ? url : '');
    $('actual-port').value = ready ? new URL(url).port || '443' : '预设 ' + $('port').value;
    return;
  }

  $('agent-power').disabled = !installation.paired || busy || pending || otherRole;
  $('agent-power').textContent = running && !otherRole ? '停止设备调度件' : '开启设备调度件';
  $('nav-quota').disabled = !installation.paired;
  $('directory').disabled = busy || pending || running;
  $('load-installation').disabled = $('directory').disabled;
  $('import').disabled = busy || pending || running;
  $('scan').disabled = $('import').disabled;
  $('pair').disabled = $('import').disabled;
  for (const button of $('centers').children) button.disabled = $('import').disabled;
  $('connected-center').textContent = installation.paired ? '已配对 · ' + installation.address : '等待配对';
  $('cpu').textContent = installation.paired ? installation.cpu : '待分配';
  $('memory').textContent = installation.paired ? installation.memory / 1048576 + ' MiB' : '待分配';
}

let refreshing;
async function refresh() {
  if (!refreshing) {
    refreshing = api('/state').then(result => { snapshot = result; render(); })
      .finally(() => { refreshing = null; });
  }
  await refreshing;
}

async function action(work, errorId = 'error') {
  if (busy) return;
  busy = true;
  message(errorId);
  render();
  try {
    await work();
    // If polling had already started, wait for its older snapshot before re-reading.
    if (refreshing) await refreshing;
    await refresh();
  } catch (error) {
    message(errorId, error.message);
  } finally {
    busy = false;
    render();
  }
}

function initCenter() {
  $('port').oninput = render;
  $('power').onclick = () => {
    if (snapshot.state === 'RUNNING') {
      if (window.confirm('关闭协调中心后，已连接的设备将断开。确定关闭？')) {
        void action(() => api('/stop', {}));
      }
    } else if ($('port').reportValidity()) {
      void action(() => api('/center/start', {
        address: $('address').value, port: $('port').value, suite: $('center-suite').value
      }));
    }
  };
  $('dashboard').onclick = () => window.open(snapshot.url + '/dispatch.html', '_blank', 'noopener');
  $('devices').onclick = () => window.open(snapshot.url + '/', '_blank', 'noopener');
}

function initAgent() {
  const directory = $('directory');
  directory.value = sessionStorage.getItem('device-directory') || '';
  function showQuota(visible) {
    $('quota-panel').hidden = !visible;
    $('discover-panel').hidden = visible;
    $('nav-discover').setAttribute('aria-current', String(!visible));
    $('nav-quota').setAttribute('aria-current', String(visible));
  }
  async function loadInstallation() {
    installation = await api('/agent/status', { directory: directory.value });
    sessionStorage.setItem('device-directory', directory.value);
    showQuota(installation.paired);
  }
  $('load-installation').onclick = () => void action(loadInstallation);
  directory.oninput = () => {
    installation = { paired: false };
    showQuota(false);
    render();
  };
  $('nav-discover').onclick = () => showQuota(false);
  $('nav-quota').onclick = () => showQuota(true);
  $('agent-power').onclick = () => void action(() => snapshot.state === 'RUNNING'
    ? api('/stop', {})
    : api('/agent/start', { directory: directory.value, backend: $('backend').value, python: $('python').value, suite: $('suite').value }));

  const pairDialog = $('pair-dialog');
  let selectedCenter = '';
  function openPair(center = '', invitation = '') {
    selectedCenter = center;
    $('pair-center').textContent = center || '从邀请中读取协调中心地址';
    $('invitation').value = invitation;
    $('file').value = '';
    message('pair-error');
    pairDialog.showModal();
  }
  $('import').onclick = () => openPair();
  $('cancel-pair').onclick = () => { if (!busy) pairDialog.close(); };
  pairDialog.oncancel = event => { if (busy) event.preventDefault(); };
  $('file').onchange = async () => {
    const file = $('file').files[0];
    if (!file) return;
    $('invitation').value = '';
    try {
      if (file.size > 32768) throw Error('邀请文件过大');
      $('invitation').value = await file.text();
      message('pair-error');
    } catch (error) { message('pair-error', error.message); }
  };
  $('pair').onclick = () => void action(async () => {
    const invitation = $('invitation').value.trim();
    let address;
    try { address = new URL(JSON.parse(invitation).invitation.address).origin; }
    catch { throw Error('请导入有效的完整设备邀请'); }
    if (selectedCenter && address !== selectedCenter) throw Error('邀请所属中心与所选中心不一致');
    const result = await api('/agent/pair', { directory: directory.value, invitation });
    directory.value = result.directory;
    $('invitation').value = '';
    $('file').value = '';
    pairDialog.close();
    await loadInstallation();
  }, 'pair-error');

  async function discover() {
    $('discover').disabled = true;
    $('search-status').textContent = '正在搜索附近的协调中心…';
    $('centers').replaceChildren();
    try {
      const { centers } = await api('/discover');
      $('search-status').textContent = centers.length ? '发现 ' + centers.length + ' 个协调中心' : '未发现附近的协调中心，可直接导入邀请。';
      for (const address of centers) {
        const button = document.createElement('button');
        button.className = 'center';
        button.type = 'button';
        button.textContent = '协调中心';
        const subtitle = document.createElement('span');
        subtitle.textContent = address;
        const label = document.createElement('span');
        label.className = 'pair-label';
        label.textContent = '需要设备邀请 · 立即配对 ›';
        button.append(subtitle, label);
        button.onclick = () => openPair(address);
        $('centers').append(button);
      }
      render();
    } catch (error) { $('search-status').textContent = error.message; }
    finally { $('discover').disabled = false; }
  }
  $('discover').onclick = () => void discover();

  const scanDialog = $('scan-dialog');
  let camera;
  let scanning = false;
  $('scan').hidden = !window.BarcodeDetector || !navigator.mediaDevices?.getUserMedia;
  $('cancel-scan').onclick = () => scanDialog.close();
  scanDialog.onclose = () => {
    camera?.getTracks().forEach(track => track.stop());
    camera = null;
    $('camera').srcObject = null;
  };
  $('scan').onclick = async () => {
    if (scanning) return;
    scanning = true;
    message('scan-error');
    scanDialog.showModal();
    try {
      const detector = new BarcodeDetector({ formats: ['qr_code'] });
      camera = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
      if (!scanDialog.open) {
        camera.getTracks().forEach(track => track.stop());
        camera = null;
        return;
      }
      $('camera').srcObject = camera;
      while (scanDialog.open) {
        if ($('camera').readyState >= 2) {
          const [result] = await detector.detect($('camera'));
          if (result && scanDialog.open) {
            const bootstrap = JSON.parse(result.rawValue);
            const center = new URL(bootstrap.invitation.address).origin;
            if (bootstrap.invitation.version !== 2 || bootstrap.invitation.expiresAt <= Date.now()) {
              throw Error('二维码邀请已过期或版本不匹配');
            }
            scanDialog.close();
            openPair(center, result.rawValue);
            break;
          }
        }
        await new Promise(resolve => setTimeout(resolve, 200));
      }
    } catch (error) {
      camera?.getTracks().forEach(track => track.stop());
      if (scanDialog.open) message('scan-error', '无法使用此二维码或摄像头：' + error.message);
    } finally { scanning = false; }
  };

  void action(loadInstallation);
  void discover();
}

if (isCenter) initCenter();
else initAgent();

function poll() {
  void refresh().catch(error => message('error', error.message));
}
poll();
setInterval(poll, 2000);
