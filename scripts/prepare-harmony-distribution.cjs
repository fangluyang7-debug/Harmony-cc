const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {createRequire} = require('node:module');
const {execFileSync} = require('node:child_process');
const {createHash} = require('node:crypto');
const root = path.resolve(__dirname, '..');
const release = process.argv[2] || '调度系统分发-20261108';
if (!/^调度系统分发-\d{8}(?:-r\d+)?$/.test(release)) throw Error('发行目录格式须为 调度系统分发-YYYYMMDD，可追加 -rN');
const out = path.join(root, 'dist', release);
const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'harmony-distribution-'));
const nodeHome = path.join(root, 'dist/node-v24.16.0-win-x64');

function copy(src, dest) {
  fs.mkdirSync(path.dirname(dest), {recursive: true});
  fs.cpSync(src, dest, {
    recursive: true,
    filter: name => !/\.(?:tmp\d*|log|tsbuildinfo)$/.test(name) && path.basename(name) !== 'node_modules'
  });
}

const README_CENTER = `# Windows x64 协调中心

完整解压后双击 Start.cmd。选择可供其他设备访问的局域网 IPv4，点击中央电源按钮启动。就绪后点击“设备配对”进入空间并生成设备邀请，点击“打开调度盘”查看运行状态。

包内已带 Node.js 运行时和 OpenSSL。首次启动会在 services/coordinator/data/desktop-<IP> 下生成证书和数据库，请保留该目录用于备份与迁移。默认 HTTPS TCP 7443，发现使用 UDP 7444，设备之间须能互访。端口冲突可在高级设置中更改。停止服务时再次点击中央电源按钮。
`;

const README_AGENT = `# Windows x64 设备调度件

完整解压后双击 Start.cmd。选择发现的协调中心或直接点击“导入设备邀请”，导入由中心生成的设备邀请 JSON。配对后进入“贡献上限”，点击“开启设备调度件”。安装身份默认保存在当前用户的 HarmonyRuntime/device，重新启动时可直接使用。

基础 CPU 能力使用包内运行时，不需要在本机安装 Node.js。若需要执行图像编码，请另配 Python、模型与可信评测套件；包内 services/image-worker/requirements.txt 列出了 Python 依赖。使用 CUDA 时另外准备 NVIDIA 驱动和支持 CUDA 的 PyTorch，启动页选择 CUDA 并填写 Python 和套件路径，中心需配置同一评测套件。
`;

// The coordinator creates its TLS certificate with OpenSSL. Ship the one from Git for Windows
// so a clean machine works without installing Git, and place it where Start.cmd adds it to PATH.
function bundleOpenSsl(dest) {
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  if (process.platform === 'win32') try {
    for (const git of execFileSync('where.exe', ['git'], {encoding: 'utf8', windowsHide: true}).trim().split(/\r?\n/)) {
      const bin = path.dirname(git);
      dirs.push(path.join(bin, '..', 'mingw64', 'bin'), path.join(bin, '..', 'usr', 'bin'));
    }
  } catch {}
  for (const dir of dirs) {
    if (!fs.existsSync(path.join(dir, 'openssl.exe'))) continue;
    const dlls = fs.readdirSync(dir).filter(name => /^lib(?:ssl|crypto).*\.dll$/i.test(name));
    if (!dlls.length) continue;
    const target = path.join(dest, 'runtime/openssl');
    fs.mkdirSync(target, {recursive: true});
    fs.copyFileSync(path.join(dir, 'openssl.exe'), path.join(target, 'openssl.exe'));
    for (const dll of dlls) fs.copyFileSync(path.join(dir, dll), path.join(target, dll));
    // OpenSSL derives its prefix from the binary location and reads <prefix>/etc/ssl/openssl.cnf.
    // With the binary under runtime/openssl, that config has to live in runtime/etc/ssl.
    const config = path.join(dir, '..', 'etc', 'ssl', 'openssl.cnf');
    if (fs.existsSync(config)) {
      fs.mkdirSync(path.join(dest, 'runtime/etc/ssl'), {recursive: true});
      fs.copyFileSync(config, path.join(dest, 'runtime/etc/ssl/openssl.cnf'));
    } else {
      throw Error('OPENSSL_CONFIG_NOT_FOUND: expected ' + config);
    }
    console.log('bundled OpenSSL from ' + dir + ' (' + dlls.length + ' dll)');
    return;
  }
  throw Error('OPENSSL_NOT_FOUND: install Git for Windows or put openssl.exe on PATH');
}

function windowsPackage(name, role) {
  const dest = path.join(stage, name);
  const center = role === 'center';
  const service = 'services/' + (center ? 'coordinator' : 'pc-agent');
  const manifest = path.join(root, service, 'package.json');
  const files = [service + '/dist', 'scripts/runtime-desktop.cjs', 'scripts/start-coordinator-lan.cjs',
    'capabilities/coverage-requirements.json', 'capabilities/capability-hints.json'];
  if (center) files.push(service + '/generated/client', service + '/scripts/migrate.cjs',
    service + '/prisma', 'apps/team-space-web');
  else files.push('services/image-worker/encode_once.py', 'services/image-worker/app/main.py',
    'services/image-worker/app/__init__.py', 'services/image-worker/requirements.txt',
    'services/image-worker/README.md');
  for (const file of files) copy(path.join(root, file), path.join(dest, file));

  // Keep npm's installed dependency layout, materializing internal workspace libraries.
  const visited = new Set();
  function dependency(name, owner, optional = false) {
    const paths = createRequire(owner).resolve.paths('harmony-distribution-probe') || [];
    const pkgDir = paths.map(base => path.join(base, name)).find(dir =>
      fs.existsSync(path.join(dir, 'package.json')));
    if (!pkgDir) {
      if (optional) return;
      throw Error('Missing runtime dependency ' + name + ' from ' + owner);
    }
    const relative = path.relative(root, pkgDir);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw Error('Dependency outside workspace: ' + name);
    if (visited.has(relative)) return;
    visited.add(relative);
    const pkg = path.join(pkgDir, 'package.json');
    if (name.startsWith('@harmony/')) {
      const actual = fs.realpathSync(pkgDir);
      const workspacePath = path.relative(root, actual);
      if (!workspacePath.startsWith('packages' + path.sep)) throw Error('Unexpected internal package: ' + name);
      for (const target of [relative, workspacePath]) {
        copy(pkg, path.join(dest, target, 'package.json'));
        copy(path.join(pkgDir, 'dist'), path.join(dest, target, 'dist'));
      }
    } else {
      copy(pkgDir, path.join(dest, relative));
    }
    const meta = JSON.parse(fs.readFileSync(pkg, 'utf8'));
    for (const [key, value] of Object.entries(meta.dependencies || {}))
      if (!Object.hasOwn(meta.optionalDependencies || {}, key)) dependency(key, pkg);
    for (const key of Object.keys(meta.optionalDependencies || {})) dependency(key, pkg, true);
    for (const key of Object.keys(meta.peerDependencies || {}))
      dependency(key, pkg, meta.peerDependenciesMeta?.[key]?.optional === true);
  }
  for (const key of Object.keys(JSON.parse(fs.readFileSync(manifest, 'utf8')).dependencies))
    dependency(key, manifest);
  if (center) dependency('prisma', manifest);
  for (const file of ['node.exe', 'LICENSE']) copy(path.join(nodeHome, file), path.join(dest, 'runtime', file));
  if (center) bundleOpenSsl(dest);
  copy(path.join(root, 'capabilities/coverage-requirements.json'), path.join(dest, 'node_modules/capabilities/coverage-requirements.json'));
  for (const file of [center ? 'index.html' : 'agent.html', 'desktop.js']) {
    const asset = path.join('apps/runtime-desktop', file);
    copy(path.join(root, asset), path.join(dest, asset));
  }
  fs.writeFileSync(path.join(dest, 'README.md'), center ? README_CENTER : README_AGENT);
  // The bundled OpenSSL must be reachable through PATH: the launcher only accepts an
  // absolute COORDINATOR_OPENSSL or an openssl.exe found next to a PATH entry.
  fs.writeFileSync(path.join(dest, 'Start.cmd'), [
    '@echo off', 'cd /d "%~dp0"',
    'if exist "runtime\\openssl\\openssl.exe" set "PATH=%PATH%;%~dp0runtime\\openssl"',
    '"runtime/node.exe" scripts/runtime-desktop.cjs ' + role, 'pause', ''
  ].join('\r\n').replaceAll('/', '\\').replace('cd \\d', 'cd /d'));
  console.log(name + ': ' + visited.size + ' runtime dependencies');
  return dest;
}

windowsPackage('01-Coordinator-Windows-x64', 'center');
windowsPackage('02-Device-Agent-Windows-x64', 'agent');

// Zip with the platform tar (bsdtar writes standard separators and keeps every entry).
// Do not use a filter that skips node_modules by name: services/coordinator keeps its NestJS
// dependencies in a nested node_modules, and dropping them makes the coordinator exit with
// "Cannot find module '@nestjs/common'" right after the migrations run.
function zipPackage(dir) {
  const folder = path.join(out, dir);
  fs.mkdirSync(folder, {recursive: true});
  const archive = path.join(folder, dir + '.zip');
  fs.rmSync(archive, {force: true});
  fs.rmSync(path.join(out, dir + '.zip'), {force: true});
  const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
  const entries = fs.readdirSync(path.join(stage, dir));
  execFileSync(tar, ['-a', '-cf', archive, '-C', path.join(stage, dir), ...entries], {stdio: 'inherit'});
  fs.copyFileSync(path.join(stage, dir, 'README.md'), path.join(folder, 'README.md'));
  console.log(dir + '.zip: ' + fs.statSync(archive).size + ' bytes');
  return archive;
}

const archives = [zipPackage('01-Coordinator-Windows-x64'), zipPackage('02-Device-Agent-Windows-x64')];
const haps = [];
for (const [dir, project, filename] of [
  ['03-Device-Agent-HarmonyOS', 'harmony-agent', 'Harmony-Device-Agent-API22-unsigned.hap'],
  ['04-SoleAI-HarmonyOS', 'harmony', 'SoleAI-Cooperative-API22-unsigned.hap']
]) {
  const hap = path.join(root, '.test/s2-' + project, 'entry/build/default/outputs/default/entry-default-unsigned.hap');
  copy(hap, path.join(stage, dir, filename));
  fs.mkdirSync(path.join(out, dir), {recursive: true});
  fs.copyFileSync(hap, path.join(out, dir, filename));
  haps.push(path.join(out, dir, filename));
}
// Checksums are regenerated from the files that were just written, so they cannot drift.
const sums = [...archives, ...haps].map(file => {
  const hash = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  return hash + '  ' + path.relative(out, file).replaceAll('\\', '/');
});
fs.writeFileSync(path.join(out, 'SHA256SUMS.txt'), sums.join('\n') + '\n');
const baseline = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {cwd: root, encoding: 'utf8'}).trim();
const dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], {cwd: root, encoding: 'utf8'}).trim();
fs.writeFileSync(path.join(out, '00-使用说明.md'), `# 智调鸿枢分发包

发行目录 ${release}。构建基线 \`${baseline}\`${dirty ? '，包含构建时工作区改动' : ''}。

| 分组 | 安装设备 | 启动方式 |
| --- | --- | --- |
| 01-Coordinator-Windows-x64 | 运行协调中心的 Windows x64 电脑 | 完整解压后双击 Start.cmd |
| 02-Device-Agent-Windows-x64 | Windows x64 执行设备 | 完整解压后双击 Start.cmd |
| 03-Device-Agent-HarmonyOS | HarmonyOS 6.0.2 / API 22 执行设备 | 用 org.harmonycc.agent 对应的签名配置签名后安装 |
| 04-SoleAI-HarmonyOS | HarmonyOS 6.0.2 / API 22 业务演示手机 | 用 org.harmonycc.soleai 对应的签名配置签名后安装 |

两份 Windows ZIP 内含运行依赖。两份 HAP 为未签名产物。

先启动协调中心并创建空间，再为每台设备生成独立邀请。Windows 导入邀请文件，鸿蒙调度件扫描邀请二维码。演示手机安装第 03、04 包，先配对设备，再打开 SoleAI 的「使用协同调度」并授权。

校验值见 SHA256SUMS.txt。完整签名和联调步骤见仓库 docs/scheduler-v2/分发包分组与联调说明.md。
`);
console.log(sums.join('\n'));
fs.writeFileSync(path.join(root, 'dist', 'harmony-distribution-stage.txt'), stage);
console.log(stage);

