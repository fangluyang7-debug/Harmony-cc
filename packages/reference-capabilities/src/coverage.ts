import type {CapabilityPackV2} from '@harmony/scheduler-core';
import type {ReferenceCase} from './index';
const requirements=require('../../../capabilities/coverage-requirements.json') as Record<string,string[]>;

/** Installed reference suites opt into the contract dimensions defined by their schema family. */
export function validateCoverage(manifest:CapabilityPackV2,cases:ReferenceCase[]){
  const schemas=manifest.contract.inputSchemas;
  const needed=new Set(['boundary:empty','boundary:max',...schemas.map(s=>'schema:'+s)]);
  for(const schema of schemas)for(const tag of requirements[schema]??[])needed.add(tag);
  for(const p of manifest.contract.workModel?.parameters??[])for(const bound of ['min','max'])needed.add('param:'+p.name+':'+bound);
  const tested=new Set<string>(),accepted=new Set<string>(),rejected=new Set<string>();
  for(const c of cases){
    if(!Array.isArray(c.covers)||!c.covers.length||c.covers.some(tag=>typeof tag!=='string'||!tag)||!c.expect||!['OUTPUT','REJECT'].includes(c.expect.kind))throw Error('TRUSTED_PACK_COVERAGE');
    if(c.expect.kind==='OUTPUT'&&c.expected===undefined||c.expect.kind==='REJECT'&&!/^[A-Z][A-Z0-9_]*$/.test(c.expect.errorCode))throw Error('TRUSTED_PACK_COVERAGE');
    for(const tag of c.covers){tested.add(tag);if(c.expect.kind==='REJECT')rejected.add(tag);else accepted.add(tag);}
  }
  if([...needed].some(t=>!tested.has(t))||schemas.some(s=>!rejected.has('schema:'+s)||!accepted.has('schema:'+s)))throw Error('TRUSTED_PACK_COVERAGE');
}
