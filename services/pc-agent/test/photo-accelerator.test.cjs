const {test}=require('node:test'),assert=require('node:assert/strict');
const {parseVulkanDevices,selectVulkanDevice}=require('../dist/photo-accelerator');
const log=['[0 Intel(R) UHD Graphics]  queueC=0[1]  queueG=0[1]  queueT=0[1]','[0 Intel(R) UHD Graphics]  bugsbn1=0  bugbilz=0  bugcopc=0  bugihfa=0',
 '[1 NVIDIA GeForce RTX 3060 Laptop GPU]  queueC=2[8]  queueG=0[16]  queueT=1[2]','[1 NVIDIA GeForce RTX 3060 Laptop GPU]  fp16-p/s/a=1/1/1  int8-p/s/a=1/1/1'].join('\r\n');
const nvidia=[{uuid:'GPU-1',name:'NVIDIA GeForce RTX 3060 Laptop GPU',totalBytes:6*1073741824}];

test('Vulkan device list is parsed from the engine diagnostics',()=>{
 assert.deepEqual(parseVulkanDevices(log),[{index:0,name:'Intel(R) UHD Graphics'},{index:0,name:'Intel(R) UHD Graphics'},{index:1,name:'NVIDIA GeForce RTX 3060 Laptop GPU'},{index:1,name:'NVIDIA GeForce RTX 3060 Laptop GPU'}]);
 assert.deepEqual(parseVulkanDevices(''),[]);
});

test('the NVIDIA-backed Vulkan index is chosen even when the integrated GPU is device 0',()=>{
 const chosen=selectVulkanDevice(parseVulkanDevices(log),nvidia,undefined);
 assert.equal(chosen.index,1);assert.equal(chosen.device.uuid,'GPU-1');
});

test('an explicit HARMONY_PHOTO_GPU_ID must itself be an NVIDIA device',()=>{
 assert.equal(selectVulkanDevice(parseVulkanDevices(log),nvidia,'0'),null,'0 is the integrated GPU');
 assert.equal(selectVulkanDevice(parseVulkanDevices(log),nvidia,'1').index,1);
 assert.equal(selectVulkanDevice(parseVulkanDevices(log),[{name:'NVIDIA GeForce RTX 4090'}],undefined),null,'no Vulkan device carries that name');
});
