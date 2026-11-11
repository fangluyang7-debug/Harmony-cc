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
  if (!isCenter && snapshot.coordinatorGone && installation.paired) {
    installation = { paired: false };
    window.dispatchEvent(new Event('coordinator-gone'));
  }
  $('role-link').hidden = role !== 'both';

  if (isCenter) {
    const select = $('address');
    const selected = select.value;
    const visibleAddresses = addresses.filter(item =>
      !/^vEthernet\s*\(WSL\b|^VMware Network Adapter VMnet1$/i.test(item.name.trim())
    );
    const options = JSON.stringify(visibleAddresses);
    if (select.dataset.items !== options) {
      select.replaceChildren(...visibleAddresses.map(item => new Option(item.name + ' · ' + item.address, item.address)));
      if (visibleAddresses.some(item => item.address === selected)) select.value = selected;
      else { const wifi = visibleAddresses.find(item => /WLAN|Wi-Fi|Wireless|无线/i.test(item.name)); if (wifi) select.value = wifi.address; }
      select.dataset.items = options;
    }
    const ready = running && !otherRole;
    const advertised = ready ? new URL(url) : null;
    const addressLost = advertised !== null && !addresses.some(item => item.address === advertised.hostname);
    const action = ready ? '关闭协调中心' : pending && !otherRole ? labels[state] : '启动协调中心';
    $('power-title').textContent = action;
    $('power').setAttribute('aria-label', action);
    $('power').disabled = busy || pending || otherRole || (!ready && !select.value);
    select.disabled = busy || pending || running;
    $('port').disabled = select.disabled;
    $('center-suite').disabled = select.disabled;
    $('dashboard').disabled = !ready || addressLost;
    $('create-workspace').disabled=!ready||busy;
    $('workspace-name').textContent=snapshot.workspace?.name||'启动中心后读取当前空间';
    $('devices').disabled = !ready || addressLost || busy;
    if (addressLost && $('pair-dialog').open) $('pair-dialog').close();
    message('network-change', addressLost ? '网络已切换，旧地址已停止发布。请关闭协调中心，选择新的局域网地址后重新启动。' : '');
    message('public-url', ready ? url : '');
    $('actual-port').value = advertised ? advertised.port || '443' : '预设 ' + $('port').value;
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
  // VRAM appears only after the host opened a GPU engine and the coordinator confirmed the share.
  $('vram').textContent = !installation.paired ? '待分配' : installation.vram ? Math.round(installation.vram / 1048576) + ' MiB' : running ? '无 GPU 引擎' : '启动后探测';
}

let refreshing;
async function refresh() {
  if (!refreshing) {
    refreshing = api('/state').then(async result => {
      snapshot = result;
      if(isCenter&&result.state==='RUNNING'){try{snapshot.workspace=await api('/workspace');}catch{}}
      // Automatic policy changes are persisted by the host after pairing. Do
      // not keep showing the invitation's provisional 2 CPU / 1 GiB forever.
      if(!isCenter&&installation.paired&&!busy){try{installation=await api('/agent/status',{directory:installation.directory});}catch{}}
      render();
    })
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
  $('create-workspace').onclick=()=>void action(async()=>{await api('/workspace/create',{name:$('workspace-name-input').value});$('workspace-name-input').value='';});
  $('photo-display').onclick=()=>void action(async()=>{const r=await api('/display/open',{});window.open(r.url,'harmony-photo-display');});
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
  function openConsole(path) {
    void action(async () => {
      await api('/console/session', {});
      location.assign(path);
    });
  }
  $('dashboard').onclick = () => openConsole('/dispatch.html'+(snapshot.workspace?'?space='+encodeURIComponent(snapshot.workspace.id):''));
  const pairing = $('pair-dialog');
  const download = $('pair-download');
  let invitationTimer;
  function clearInvitation() {
    clearTimeout(invitationTimer);
    if (download.hasAttribute('href')) URL.revokeObjectURL(download.href);
    download.removeAttribute('href');
    download.hidden = true;
    $('pair-qr').removeAttribute('src');
    $('pair-details').hidden = true;
  }
  pairing.addEventListener('close', clearInvitation);
  $('devices').onclick = () => {
    if (busy) return;
    clearInvitation();
    $('pair-status').textContent = '正在生成配对二维码…';
    pairing.showModal();
    void action(async () => {
      try {
        await api('/console/session', {});
        const space = await api('/workspace');
        if (!space) throw Error('本地调度空间不可用。');
        if (!pairing.open) return;
        // The invitation carries a provisional 2-slot / 1 GiB ceiling for the first connection. With
        // capacityMode 'auto' the coordinator replaces it from the device's reported RAM/CPU once paired.
        const { invitation, holderInstanceId, domain, contribution, qr, pairingCode, pairingCodeExpiresAt } = await api(
          '/v2/spaces/' + encodeURIComponent(space.id) + '/devices', {
            name: '设备 ' + new Date().toLocaleString('zh-CN', { hour12: false }),
            qrFormat: 'link',
            settings: {
              ownerMode: 'dedicated', capacityMode: 'auto', maxCpuThreads: 2, maxMemoryBytes: 1073741824,
              reserveMemoryBytes: 1073741824
            }
          }
        );
        if (!pairing.open) return;
        const center = new URL(invitation.address);
        $('pair-address').textContent = center.hostname;
        $('pair-port').textContent = center.port || '443';
        $('pair-code').textContent = pairingCode || '请扫码';
        $('pair-fingerprint').textContent = invitation.fingerprint;
        $('pair-expires').textContent = new Date(pairingCodeExpiresAt || invitation.expiresAt).toLocaleTimeString('zh-CN');
        $('pair-qr').src = qr;
        download.href = URL.createObjectURL(new Blob(
          [JSON.stringify({ invitation, holderInstanceId, domain, contribution })],
          { type: 'application/json' }
        ));
        download.hidden = false;
        $('pair-details').hidden = false;
        $('pair-status').textContent = '设备可扫码，或选择此协调中心后输入 6 位配对码。数字码首次连接请核对两端证书指纹。配对后自动确定额度。';
        invitationTimer = setTimeout(() => {
          clearInvitation();
          $('pair-status').textContent = '邀请已过期。请关闭弹窗后重新点击「设备配对」。';
        }, Math.max(0, (pairingCodeExpiresAt || invitation.expiresAt) - Date.now()));
      } catch (error) {
        $('pair-status').textContent = '未能生成配对邀请。';
        throw error;
      }
    }, 'pair-error');
  };
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
    if(installation.directory)directory.value=installation.directory;
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
  let onlyDiscoveredCenter = '';
  function openPair(center = '', invitation = '') {
    $('pair-address-input').value = center;
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
    let address = $('pair-address-input').value.trim();
    let fingerprint;
    if (/^\d{6}$/.test(invitation)) {
      address ||= onlyDiscoveredCenter;
      if (!address) throw Error('请选择或填写协调中心地址');
      const trust = await api('/agent/certificate', { address });
      if (!window.confirm('请与协调中心配对窗口核对证书指纹，一致后继续：\n' + trust.fingerprint)) return;
      fingerprint = trust.fingerprint;
    } else if (invitation.startsWith('{')) {
      const target = new URL(JSON.parse(invitation).invitation.address).origin;
      if (address && address !== target) throw Error('邀请所属中心与所选中心不一致');
    }
    const result = await api('/agent/pair', { directory: directory.value, invitation, address, fingerprint });
    directory.value = result.directory;
    $('invitation').value = '';
    $('file').value = '';
    pairDialog.close();
    await loadInstallation();
  }, 'pair-error');

  async function discover() {
    $('discover').disabled = true;
    onlyDiscoveredCenter = '';
    $('search-status').textContent = '正在搜索附近的协调中心…';
    $('centers').replaceChildren();
    try {
      const { centers } = await api('/discover');
      $('search-status').textContent = centers.length ? '发现 ' + centers.length + ' 个协调中心' : '未发现附近的协调中心，可直接导入邀请。';
      onlyDiscoveredCenter = centers.length === 1 ? centers[0] : '';
      for (const address of centers) {
        const button = document.createElement('button');
        button.className = 'center';
        button.type = 'button';
        button.textContent = '协调中心';
        const subtitle = document.createElement('span');
        subtitle.textContent = address;
        const label = document.createElement('span');
        label.className = 'pair-label';
        label.textContent = '扫码或输入配对码 ›';
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
            if (result.rawValue.startsWith('https://')) {
              const center = new URL(result.rawValue).origin;
              scanDialog.close(); openPair(center, result.rawValue); break;
            }
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

  window.addEventListener('coordinator-gone', () => {
    showQuota(false);
    message('error', '协调中心已关闭，本机已断开并清除配对。请选择协调中心重新配对。');
    void discover();
  });
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
