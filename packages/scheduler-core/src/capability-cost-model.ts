import { canonical } from './cost';
import { TaskContractV2, validWorkModelV2 } from './protocol-v2';
import { CapabilityCostModel } from './protocol-v1';
export type { CapabilityCostModel } from './protocol-v1';

/** Declared by the capability provider, not inferred from business request contents. */
export function costConfiguration(parameters:unknown, model?:CapabilityCostModel):unknown {
  if(!model)return {model:'size-only-v1'};
  if(!model.version||!Array.isArray(model.parameters)||model.parameters.length>16||
    new Set(model.parameters.map(p=>p.name)).size!==model.parameters.length)throw new Error('COST_MODEL_INVALID');
  const input=(parameters??{}) as Record<string,unknown>,values:Record<string,unknown>={};
  for(const rule of model.parameters){
    if(!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(rule.name))throw new Error('COST_MODEL_INVALID');
    const value=input[rule.name];
    if(rule.bucketWidth!==undefined){
      if(!Number.isFinite(rule.bucketWidth)||rule.bucketWidth<=0)throw new Error('COST_MODEL_INVALID');
      values[rule.name]=typeof value==='number'&&Number.isFinite(value)?Math.floor(value/rule.bucketWidth):null;
    }else{
      if(value!==undefined&&value!==null&&!['string','number','boolean'].includes(typeof value))throw new Error('COST_PARAMETER_INVALID');
      if(typeof value==='string'&&value.length>128)throw new Error('COST_PARAMETER_INVALID');
      values[rule.name]=value??null;
    }
  }
  return {model:model.version,values};
}

export function workKeyV2(contract:TaskContractV2, parameters:string, inputBytes:number):string {
  if(!Number.isSafeInteger(inputBytes)||inputBytes<0)throw new Error('INPUT_BYTES_INVALID');
  if(contract.workModel!==undefined&&!validWorkModelV2(contract.workModel))throw new Error('COST_MODEL_INVALID');
  const config=costConfiguration(contract.workModel?JSON.parse(parameters):null,contract.workModel);
  return canonical([contract.contractId,contract.version,config,Math.floor(Math.log2(Math.max(1,inputBytes)))]);
}
