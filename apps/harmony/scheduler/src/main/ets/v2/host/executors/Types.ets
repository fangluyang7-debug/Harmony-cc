import {common} from '@kit.AbilityKit';
import {ModelManifestV2} from '../../protocol/ResourcesV2';
export interface EngineResult {overheadMs?:number;data:Uint8Array;schemaId:string;}
export interface EngineInput {threads?:number;context:common.UIAbilityContext;input:Uint8Array;parameters:string;model:ModelManifestV2|null;cancelled:()=>boolean;}
export type LocalExecutor=(request:EngineInput)=>Promise<EngineResult>;
