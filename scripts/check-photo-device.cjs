// Installed-package diagnostic. Uses engine reference fixtures, never user photos or pairing state.
const fs = require('node:fs');
const path = require('node:path');
const {createRequire} = require('node:module');
const {createHash} = require('node:crypto');
const {execFileSync} = require('node:child_process');

async function check(root, cpuOnly = false) {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('HARMONY_PHOTO_') || key.startsWith('PC_IMAGE_')) delete process.env[key];
  }
  const report = {version: 1, checkedAt: new Date().toISOString(), scope: 'installation-reference-only',
    cpu: {state: 'NOT_TESTED'}, gpu: {state: 'NOT_TESTED'}, models: {}, pairingChanged: false};
  const req = createRequire(path.join(root, 'services/pc-agent/dist/host-main.js'));
  try {
    const config = JSON.parse(fs.readFileSync(path.join(root, 'services/pc-agent/dist/photo/runtime.json')));
    for (const key of ['model', 'runner', 'vulkan']) {
      if (!config[key] || path.isAbsolute(config[key])) throw Error('PHOTO_RUNTIME_NOT_PORTABLE');
    }
    req('./photo-installation.js');
    const expected = {
      'realesrgan-x4plus.param': '35330ececcea33b6c397a72548e788d5d53becee4734c50b7fada36e89f10a86',
      'realesrgan-x4plus.bin': '713ee713b0353afaa27976f0563a64a5043bd70b9bd8936c2e26e25ebcdbcddf'
    };
    for (const [name, digest] of Object.entries(expected)) {
      const actual = createHash('sha256').update(fs.readFileSync(path.join(process.env.HARMONY_PHOTO_MODEL, name))).digest('hex');
      if (actual !== digest) throw Error('PHOTO_MODEL_HASH');
      report.models[name] = actual;
    }
    for (const file of [process.env.HARMONY_PHOTO_RUNNER, process.env.HARMONY_PHOTO_VULKAN,
      ...(config.vulkanRuntime==='harmony-raw-v1'?[]:[path.join(path.dirname(process.env.HARMONY_PHOTO_VULKAN), 'vcomp140.dll')])]) {
      if (!fs.existsSync(file)) throw Error('PHOTO_RUNTIME_INCOMPLETE');
    }
    report.runtime = JSON.parse(execFileSync(process.env.HARMONY_PHOTO_RUNNER,
      ['--runtime-info', '4'], {encoding: 'utf8', windowsHide: true, timeout: 10000}));
    const pack = req('@harmony/reference-capabilities').photoPacks().find(p => p.manifest.contract.capability === 'photo.enhance.v1');
    report.contract = pack.manifest.contract;
    const sample = pack.cases.find(c => c.id === 'fused-prepare-threads-4');
    if (!sample) throw Error('PHOTO_FUSED_CONTRACT_MISSING');
    const started = performance.now();
    const execute = await req('./executors/registry.js').cpuRegistry.load('photo.enhance.v1');
    const result = await execute(sample.input, JSON.parse(sample.parameters), sample.config, AbortSignal.timeout(120000));
    const score = await pack.evaluate(sample, result.output);
    if (score < pack.manifest.qualityThreshold) throw Error('PHOTO_CPU_QUALITY_FAILED');
    report.cpu = {state: 'READY', score, referenceMs: Math.round(performance.now() - started)};
  } catch (error) {
    report.cpu = {state: 'FAILED', reason: error.message};
  }
  if (cpuOnly) report.gpu = {state: 'NOT_TESTED', reason: 'CPU_ONLY_REQUESTED'};
  else {
    try {
      const encoder = await req('./photo-accelerator.js').openPhotoAccelerator();
      // Also check the fused source->prepare->enhance contract used by the current phone App.
      const sample = encoder.pack.cases.find(c => c.id === 'fused-prepare-threads-4');
      const offer = {target: {backend: 'VULKAN', executorId: 'ncnn.photo.vulkan.v1'},
        task: {parameters: sample.parameters}, allowedConfigs: [sample.config]};
      const result = await encoder.execute(offer, sample.input, AbortSignal.timeout(120000));
      const score = await encoder.pack.evaluate(sample, result.bytes);
      if (score < encoder.pack.manifest.qualityThreshold) throw Error('PHOTO_GPU_FUSED_QUALITY_FAILED');
      const count=encoder.gpu.pipelineSlots||1,start=performance.now();
      const parallel=await Promise.all(Array.from({length:count},()=>encoder.execute(offer,sample.input,AbortSignal.timeout(120000))));
      const parallelMs=Math.round(performance.now()-start);
      const scores=await Promise.all(parallel.map(r=>encoder.pack.evaluate(sample,r.bytes)));
      if(scores.some(s=>s<encoder.pack.manifest.qualityThreshold))throw Error('PHOTO_GPU_PARALLEL_QUALITY_FAILED');
      const warm=await encoder.execute(offer,sample.input,AbortSignal.timeout(120000));
      if(await encoder.pack.evaluate(sample,warm.bytes)<encoder.pack.manifest.qualityThreshold)throw Error('PHOTO_GPU_WARM_QUALITY_FAILED');
      report.gpu = {state: 'READY', device:encoder.gpu.name, pipelineSlots:count,
        referencePipeline:{scope:'installation-reference-only-not-business-speedup',count,parallelMs,scores,timings:parallel.map(r=>r.timing??null),warm: warm.timing??null}, backend: 'VULKAN', executorId: 'ncnn.photo.vulkan.v1',
        index: Number(process.env.HARMONY_PHOTO_GPU_ID), vramBytes: encoder.gpu.totalBytes, score,
        runtime: process.env.HARMONY_PHOTO_VULKAN_RUNTIME || 'legacy-realesrgan-cli'};
    } catch (error) {
      report.gpu = {state: 'UNAVAILABLE', reason: error.message, ...(error.diagnostic?{diagnostic:error.diagnostic}:{})};
    }
  }
  return report;
}

if (require.main === module) {
  check(path.resolve(__dirname, '..'), process.argv.includes('--cpu-only')).then(report => {
    fs.writeFileSync(path.resolve(__dirname, '../PHOTO-DEVICE-CHECK.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    console.log('\n报告已保存为 PHOTO-DEVICE-CHECK.json；此检查不会加入/退出空间，不是业务加速成绩。');
    process.exit(report.cpu.state === 'READY' && (process.argv.includes('--cpu-only') || report.gpu.state === 'READY') ? 0 : 1);
  }).catch(error => {console.error(error.message); process.exit(1);});
}
module.exports = {check};
