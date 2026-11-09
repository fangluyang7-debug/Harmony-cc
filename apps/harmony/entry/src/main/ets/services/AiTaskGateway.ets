import { util } from '@kit.ArkTS';
import { fileIo } from '@kit.CoreFileKit';
import { common } from '@kit.AbilityKit';
import { SchedulerSdk, SdkNode, SdkInput, SdkTask, WorkflowHandle } from 'scheduler';
import { ShoppingTaskService } from './ShoppingTaskService';
import { ShoppingResult } from '../models/ShoppingResult';
import { cooperative, CapabilityAvailability, DeclaredNode, WorkflowDeclaration } from './CooperativeSession';

/**
 * The single entry for every AI operation of this App (STATUS §87 §5).
 *
 * Switch OFF  -> local mode: the phone's own scheduler runs the workflow exactly as before.
 * Switch ON   -> the declared workflow is matched against what the coordinator can currently execute.
 *                Every node that has a qualified target is submitted to the scheduler (the planner picks
 *                the device); nodes without one run in local mode. The report says which was which and
 *                why, so a partial result is never silently presented as cooperative execution.
 */
export type NodeExecution = 'scheduler' | 'local';
export interface NodeReport { id: string; capability: string; execution: NodeExecution; targetId: string | null; reason: string; }
export interface ExecutionReport { workflowId: string; mode: 'LOCAL' | 'COOPERATIVE' | 'PARTIAL'; nodes: NodeReport[]; }
export interface GatewayOutcome { handle: WorkflowHandle<ShoppingResult>; report: ExecutionReport; }
interface CommitReceipt { sessionId?: string; created?: boolean; replay?: boolean; }
const cropParameters = '{"box":{"x":0,"y":0,"width":1,"height":1},"paddingRatio":0,"targetSize":1024,"jpegQuality":95}';

function describe(report: ExecutionReport): string {
  const scheduled = report.nodes.filter((n: NodeReport) => n.execution === 'scheduler').map((n: NodeReport) => n.id + (n.targetId ? '→' + n.targetId.slice(0, 8) : ''));
  const local = report.nodes.filter((n: NodeReport) => n.execution === 'local');
  if (report.mode === 'LOCAL') return '本机模式 · ' + report.workflowId;
  if (report.mode === 'COOPERATIVE') return '协同执行 · ' + scheduled.join(' ');
  return '部分协同 · 调度器：' + (scheduled.length ? scheduled.join(' ') : '无') + ' · 本机：' + local.map((n: NodeReport) => n.capability + '（' + n.reason + '）').join('，');
}

export class AiTaskGateway {
  private static readonly instance: AiTaskGateway = new AiTaskGateway();
  private context: common.UIAbilityContext | null = null;
  private active: SdkTask | null = null;
  private cancelRequested: boolean = false;
  public lastReport: ExecutionReport | null = null;
  public static getInstance(): AiTaskGateway { return AiTaskGateway.instance; }
  public initialize(context: common.UIAbilityContext): void { this.context = context; }
  private tasks(): ShoppingTaskService { return ShoppingTaskService.getInstance(); }

  public async cancel(): Promise<void> { this.cancelRequested = true; if (this.active) { await this.active.cancel(); } }

  /** Text shopping: shopping.text. No node of it has a schedulable target yet, so it runs locally with per-node reasons. */
  public async searchText(query: string, highQuality: boolean): Promise<GatewayOutcome> {
    const report = await this.plan('shopping.text');
    return this.publish({ handle: this.tasks().searchResult(query, highQuality), report });
  }

  /** Image shopping: shopping.image. The declared prefix (quality/crop) that has targets runs through the scheduler; the rest locally. */
  public async searchImage(photoUri: string): Promise<GatewayOutcome> {
    const report = await this.plan('shopping.image');
    const prefix = this.schedulablePrefix(report, ['image.quality.v1', 'image.crop.v1']);
    let prepared = photoUri;
    if (prefix.length > 0) {
      const sdk = await cooperative.availableClient();
      if (sdk === null) { prefix.forEach((n: NodeReport) => { n.execution = 'local'; n.targetId = null; n.reason = '协调中心不可用'; }); }
      else { prepared = await this.runImagePrefix(sdk, photoUri, prefix); }
    }
    report.mode = report.nodes.every((n: NodeReport) => n.execution === 'local') ? (cooperative.enabled() ? 'PARTIAL' : 'LOCAL') : 'PARTIAL';
    return this.publish({ handle: this.tasks().searchImageResult(prepared), report });
  }

  /** Session operations (more / refine / read / shortlist) map to shopping.more / shopping.refine. */
  public async sessionOperation(operation: string, sessionId: string, bodyJson: string): Promise<GatewayOutcome> {
    const report = await this.plan(operation === 'refine' ? 'shopping.refine' : 'shopping.more');
    return this.publish({ handle: this.tasks().sessionResult(operation, sessionId, bodyJson), report });
  }

  private publish(outcome: GatewayOutcome): GatewayOutcome {
    this.lastReport = outcome.report;
    AppStorage.setOrCreate('aiExecutionReport', describe(outcome.report));
    return outcome;
  }

  /** Match the declared workflow against the coordinator's current qualified targets. Never pins a target. */
  private async plan(workflowId: string): Promise<ExecutionReport> {
    const declaration = cooperative.declaration();
    const workflow = declaration?.declaration.workflows.find((w: WorkflowDeclaration) => w.id === workflowId) ?? null;
    const nodes: DeclaredNode[] = workflow === null ? [] : (workflow.nodes ?? (workflow.alternatives ?? [])[0]?.nodes ?? []);
    if (!cooperative.enabled()) {
      return { workflowId, mode: 'LOCAL', nodes: nodes.map((n: DeclaredNode): NodeReport => ({ id: n.id, capability: n.capability, execution: 'local', targetId: null, reason: '协同未开启' })) };
    }
    const availability = await cooperative.capabilities();
    const reports = nodes.map((n: DeclaredNode): NodeReport => {
      const entry = availability.find((a: CapabilityAvailability) => a.capability === n.capability);
      const targets = entry === undefined ? 0 : entry.targets;
      if (targets > 0) return { id: n.id, capability: n.capability, execution: 'scheduler', targetId: null, reason: targets + ' 个合格目标' };
      return { id: n.id, capability: n.capability, execution: 'local', targetId: null, reason: entry === undefined ? '未登记' : '无合格目标' };
    });
    // Nodes behind an unschedulable node cannot be sent either: the scheduler would lack their input.
    let blocked = false;
    for (const r of reports) { if (r.execution === 'local') blocked = true; else if (blocked) { r.execution = 'local'; r.reason = '上游节点在本机执行'; } }
    const scheduled = reports.filter((r: NodeReport) => r.execution === 'scheduler').length;
    return { workflowId, mode: scheduled === 0 ? 'PARTIAL' : scheduled === reports.length ? 'COOPERATIVE' : 'PARTIAL', nodes: reports };
  }

  private schedulablePrefix(report: ExecutionReport, capabilities: string[]): NodeReport[] {
    const prefix: NodeReport[] = [];
    for (const n of report.nodes) { if (n.execution === 'scheduler' && capabilities.includes(n.capability)) prefix.push(n); else break; }
    return prefix;
  }

  /** Run the image prefix chain through the scheduler and return the prepared image URI. */
  private async runImagePrefix(sdk: SchedulerSdk, uri: string, prefix: NodeReport[]): Promise<string> {
    const context = this.context; if (context === null) throw Error('APP_CONTEXT_REQUIRED');
    this.cancelRequested = false;
    const file = fileIo.openSync(uri, fileIo.OpenMode.READ_ONLY); let data: Uint8Array;
    try {
      const size = fileIo.statSync(file.fd).size; if (size < 1 || size > 8388608) throw Error('IMAGE_SIZE_LIMIT');
      const buffer = new ArrayBuffer(size); if (fileIo.readSync(file.fd, buffer) !== size) throw Error('FILE_READ_INCOMPLETE'); data = new Uint8Array(buffer);
    } finally { fileIo.closeSync(file); }
    const id = util.generateRandomUUID(true), input: SdkInput = await sdk.registerInput(data, 'image.raster');
    try {
      if (this.cancelRequested) throw Error('协同任务已取消');
      const nodes: SdkNode[] = prefix.map((n: NodeReport, index: number): SdkNode => {
        const node: SdkNode = { id: n.id, capability: n.capability, parameters: n.capability === 'image.crop.v1' ? cropParameters : '{}', dependsOn: index === 0 ? [] : [prefix[index - 1].id], effects: 'PURE' };
        if (index === 0) node.input = input; else node.inputFrom = prefix[index - 1].id;
        return node;
      });
      const task = await sdk.submit({ version: 3, id, outputContract: 'image.raster', qualityTarget: 'reference', nodes }, { requestId: id, budgetMs: 30000, resultDestination: 'ORIGIN' });
      this.active = task; if (this.cancelRequested) { await task.cancel(); throw Error('协同任务已取消'); }
      const result = await task.result(); if (this.cancelRequested) throw Error('协同任务已取消');
      prefix.forEach((n: NodeReport) => { n.targetId = result.status.targetId; });
      const destination = context.cacheDir + '/cooperative-' + id + '.jpg', out = fileIo.openSync(destination, fileIo.OpenMode.CREATE | fileIo.OpenMode.WRITE_ONLY | fileIo.OpenMode.TRUNC);
      try { if (fileIo.writeSync(out.fd, result.output.slice().buffer) !== result.output.byteLength) throw Error('FILE_WRITE_INCOMPLETE'); } finally { fileIo.closeSync(out); }
      return 'file://' + destination;
    } finally { this.active = null; sdk.releaseInput(input); }
  }

  /** Chain-shaped workflows whose every node has a target run entirely through the scheduler; the commit receipt names the session to read. */
  public async runCooperativeChain(workflowId: string, bytes: Uint8Array, schemaId: string): Promise<string | null> {
    const report = await this.plan(workflowId);
    if (report.mode !== 'COOPERATIVE') return null;
    const sdk = await cooperative.availableClient(); if (sdk === null) return null;
    const declaration = cooperative.declaration();
    const workflow = declaration?.declaration.workflows.find((w: WorkflowDeclaration) => w.id === workflowId) ?? null;
    const declared: DeclaredNode[] = workflow?.nodes ?? [];
    if (declared.some((n: DeclaredNode) => n.dependsOn.length > 1)) return null; // multi-input nodes need S5 graph inputs
    const id = util.generateRandomUUID(true), input: SdkInput = await sdk.registerInput(bytes, schemaId);
    try {
      const nodes: SdkNode[] = declared.map((n: DeclaredNode, index: number): SdkNode => {
        const node: SdkNode = { id: n.id, capability: n.capability, parameters: n.parameters ?? '{}', dependsOn: n.dependsOn, effects: n.effects === 'COMMIT' ? 'COMMIT' : 'PURE' };
        if (n.privacy === 'LOCAL_ONLY' || n.privacy === 'OWNER_SERVICE' || n.privacy === 'SHARED') node.privacy = n.privacy;
        if (n.effects === 'COMMIT') node.businessIdempotencyKey = 'op-' + id;
        if (index === 0) node.input = input; else node.inputFrom = n.dependsOn[0];
        return node;
      });
      const task = await sdk.submit({ version: 3, id, outputContract: workflow?.outputContract ?? 'shopping.result', qualityTarget: 'reference', nodes }, { requestId: id, budgetMs: 60000, resultDestination: 'ORIGIN' });
      this.active = task;
      const result = await task.result();
      const receipt = JSON.parse(new util.TextDecoder('utf-8').decodeToString(result.output)) as CommitReceipt;
      report.nodes.forEach((n: NodeReport) => { n.targetId = result.status.targetId; });
      this.publish({ handle: this.tasks().readResult(receipt.sessionId ?? ''), report });
      return receipt.sessionId ?? null;
    } finally { this.active = null; sdk.releaseInput(input); }
  }
}
export const aiGateway = AiTaskGateway.getInstance();
