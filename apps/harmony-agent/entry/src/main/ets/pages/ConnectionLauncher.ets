import { common } from '@kit.AbilityKit';
import { scanBarcode } from '@kit.ScanKit';
import { discoverCenters } from '../Discovery';
import { Bootstrap } from '../NativePlatform';
import { openAgent, contributeAgent } from '../AgentRuntime';

@Entry
@Component
struct ConnectionLauncher {
  @StorageLink('agentStatus') status: string = '';
  @StorageLink('agentPaired') paired: boolean = false;
  @StorageLink('agentCenter') center: string = '';
  @StorageLink('contributing') contributing: boolean = true;
  @StorageLink('maxCpuLimit') maxCpu: number = 0;
  @StorageLink('maxMemoryLimitMB') maxMemory: number = 0;

  @State private centers: string[] = [];
  @State private searching: boolean = false;
  @State private searchMessage: string = '正在搜索附近的协调中心…';
  @State private selected: string = '';
  @State private invitation: string = '';
  @State private details: string = '';
  @State private error: string = '';
  @State private pairingOpen: boolean = false;
  @State private pairing: boolean = false;
  @State private scanning: boolean = false;
  @State private changingContribution: boolean = false;

  aboutToAppear(): void {
    if (!this.paired) void this.discover();
  }

  private async discover(): Promise<void> {
    if (this.searching) return;
    this.searching = true;
    this.searchMessage = '正在搜索附近的协调中心…';
    try {
      this.centers = await discoverCenters();
      this.searchMessage = this.centers.length > 0 ? '发现 ' + this.centers.length + ' 个协调中心' : '未发现附近的协调中心';
    } catch (e) {
      this.centers = [];
      this.searchMessage = '搜索失败，可以直接扫描设备邀请二维码';
    } finally {
      this.searching = false;
    }
  }

  private openPair(center: string): void {
    this.selected = center;
    this.invitation = '';
    this.details = '';
    this.error = '';
    this.pairingOpen = true;
  }

  private parseInvitation(value: string): Bootstrap {
    if (value.length > 16384) throw Error('设备邀请过大');
    const bootstrap = JSON.parse(value) as Bootstrap;
    if (!bootstrap.invitation || bootstrap.invitation.version !== 2 || !bootstrap.contribution) {
      throw Error('请使用协调中心生成的完整设备邀请');
    }
    if (bootstrap.invitation.expiresAt <= Date.now()) throw Error('设备邀请已过期，请重新生成');
    if (this.selected && this.selected !== bootstrap.invitation.address) {
      throw Error('设备邀请与所选协调中心不一致');
    }
    return bootstrap;
  }

  private async scan(): Promise<void> {
    if (this.scanning || this.pairing) return;
    this.scanning = true;
    this.error = '';
    try {
      const result = await scanBarcode.startScanForResult(getContext(this) as common.UIAbilityContext);
      const bootstrap = this.parseInvitation(result.originalValue);
      this.invitation = result.originalValue;
      this.details = bootstrap.invitation.address + '\n证书指纹 · ' + bootstrap.invitation.fingerprint;
      this.pairingOpen = true;
    } catch (e) {
      this.error = '无法读取设备邀请：' + (e as Error).message;
    } finally {
      this.scanning = false;
    }
  }

  private async join(): Promise<void> {
    if (this.pairing || this.scanning) return;
    this.pairing = true;
    this.error = '';
    try {
      const bootstrap = this.parseInvitation(this.invitation);
      await openAgent(getContext(this) as common.UIAbilityContext, bootstrap);
      this.invitation = '';
      this.pairingOpen = false;
    } catch (e) {
      this.error = '配对失败：' + (e as Error).message;
    } finally {
      this.pairing = false;
    }
  }

  private async setContribution(enabled: boolean): Promise<void> {
    if (this.changingContribution) return;
    this.changingContribution = true;
    this.error = '';
    try {
      await contributeAgent(enabled);
    } catch (e) {
      this.error = '贡献设置失败：' + (e as Error).message;
    } finally {
      this.changingContribution = false;
    }
  }

  @Builder
  private headline(title: string) {
    Row({ space: 10 }) {
      Column({ space: 4 }) {
        Text('智调鸿枢').fontSize(13).fontColor('#60A5FA')
        Text(title).fontSize(24).fontWeight(FontWeight.Bold).fontColor(Color.White)
      }.alignItems(HorizontalAlign.Start).layoutWeight(1)
      if (!this.paired) {
        Button('扫一扫').fontSize(14).backgroundColor('#1C1C1E')
          .enabled(!this.scanning && !this.pairing)
          .onClick(() => { this.selected = ''; void this.scan(); })
      }
    }.width('100%')
  }

  @Builder
  private discoveryPage() {
    Column({ space: 16 }) {
      this.headline('加入调度中心')
      Row({ space: 12 }) {
        Text(this.searchMessage).fontSize(14).fontColor('#A1A1AA').layoutWeight(1)
        Button('重新搜索').fontSize(13).backgroundColor('#21242D')
          .enabled(!this.searching && !this.scanning)
          .onClick(() => { void this.discover(); })
      }.width('100%').padding(14).borderRadius(18).backgroundColor('#111827')
      Text('附近的协调中心').fontSize(14).fontColor('#A1A1AA')
      Column({ space: 1 }) {
        ForEach(this.centers, (address: string) => {
          Row({ space: 12 }) {
            Text('◉').fontSize(22).fontColor('#60A5FA')
            Column({ space: 4 }) {
              Text('协调中心').fontSize(17).fontWeight(FontWeight.Medium).fontColor(Color.White)
              Text(address).fontSize(13).fontColor('#A1A1AA')
              Text('需要设备邀请').fontSize(12).fontColor('#A1A1AA')
            }.alignItems(HorizontalAlign.Start).layoutWeight(1)
            Text('›').fontSize(24).fontColor('#A1A1AA')
          }.width('100%').padding(16).backgroundColor('#1C1C1E')
            .onClick(() => { this.openPair(address); })
        }, (address: string) => address)
      }.width('100%').borderRadius(20).clip(true)
      if (!this.searching && this.centers.length === 0) {
        Text('请确认两台设备在同一局域网，也可以直接扫一扫。')
          .fontSize(14).fontColor('#A1A1AA').padding(16).width('100%')
          .borderRadius(20).backgroundColor('#1C1C1E')
      }
      Button('粘贴设备邀请').backgroundColor('#1C1C1E')
        .onClick(() => { this.openPair(''); })
      if (this.error && !this.pairingOpen) {
        Text(this.error).fontSize(14).fontColor('#FDA4AF')
      }
    }.width('100%').alignItems(HorizontalAlign.Start).padding(20)
  }

  @Builder
  private quota(label: string, value: string) {
    Column({ space: 8 }) {
      Text(label).fontSize(14).fontColor('#A1A1AA')
      Text(value).fontSize(24).fontWeight(FontWeight.Bold).fontColor('#D4D4D8')
    }.layoutWeight(1).alignItems(HorizontalAlign.Start).padding(16)
      .borderRadius(18).backgroundColor('#242428')
  }

  @Builder
  private contributionPage() {
    Column({ space: 16 }) {
      this.headline('贡献上限')
      Column({ space: 7 }) {
        Text(this.status.startsWith('已连接') ? '已连接' : '已配对').fontColor('#30D158').fontSize(14)
        Text(this.center || '协调中心').fontSize(20).fontWeight(FontWeight.Bold).fontColor(Color.White)
        Text(this.status).fontSize(13).fontColor('#A1A1AA')
      }.width('100%').alignItems(HorizontalAlign.Start).padding(18).borderRadius(20).backgroundColor('#1C1C1E')
      Row({ space: 12 }) {
        this.quota('CPU 槽位', this.maxCpu > 0 ? String(this.maxCpu) : '待分配')
        this.quota('内存', this.maxMemory > 0 ? this.maxMemory + ' MiB' : '待分配')
      }.width('100%')
      Text('额度来自协调中心的设备配对配置。').fontSize(14).fontColor('#A1A1AA')
      Column({ space: 10 }) {
        Row() {
          Text('允许接收任务').fontSize(16).fontColor(Color.White).layoutWeight(1)
          Toggle({ type: ToggleType.Switch, isOn: this.contributing })
            .selectedColor('#0A59F7').enabled(!this.changingContribution)
            .onChange(value => { void this.setContribution(value); })
        }.width('100%')
        Text('关闭后暂停接收新任务。鸿蒙调度件切到后台时也会暂停接单。').fontSize(13).fontColor('#A1A1AA')
      }.width('100%').alignItems(HorizontalAlign.Start).padding(16).borderRadius(20).backgroundColor('#1C1C1E')
      Button('结果展示').backgroundColor('#1C1C1E')
        .onClick(() => { this.getUIContext().getRouter().pushUrl({ url: 'pages/Display' }); })
      if (this.error) Text(this.error).fontSize(14).fontColor('#FDA4AF')
    }.width('100%').alignItems(HorizontalAlign.Start).padding(20)
  }

  @Builder
  private pairingSheet() {
    Scroll() {
      Column({ space: 12 }) {
        Text('设备配对').fontSize(20).fontWeight(FontWeight.Bold).fontColor(Color.White)
        Text(this.details || this.selected || '使用协调中心生成的一次性设备邀请。')
          .fontSize(14).fontColor('#A1A1AA')
        if (!this.details) {
          TextArea({ placeholder: '也可粘贴完整设备邀请', text: this.invitation })
            .height(96).maxLength(16384).backgroundColor('#121216').fontColor(Color.White)
            .enabled(!this.pairing && !this.scanning)
            .onChange(value => { this.invitation = value; })
          Button('扫描邀请二维码').backgroundColor('#25252A').enabled(!this.pairing && !this.scanning)
            .onClick(() => { void this.scan(); })
        }
        if (this.error) Text(this.error).fontSize(14).fontColor('#FDA4AF')
        Row({ space: 10 }) {
          Button('取消').layoutWeight(1).backgroundColor('#303038').enabled(!this.pairing && !this.scanning)
            .onClick(() => { this.pairingOpen = false; this.invitation = ''; this.error = ''; })
          Button(this.pairing ? '连接中…' : '连接').layoutWeight(1).backgroundColor('#0A59F7')
            .enabled(this.invitation.trim().length > 0 && !this.pairing && !this.scanning)
            .onClick(() => { void this.join(); })
        }.width('100%')
      }.width('100%').alignItems(HorizontalAlign.Start).padding(22)
    }.width('100%').constraintSize({ maxHeight: '80%' })
      .borderRadius({ topLeft: 24, topRight: 24 }).backgroundColor('#1C1C1E')
  }

  build() {
    Stack({ alignContent: Alignment.Bottom }) {
      Scroll() {
        if (this.paired) {
          this.contributionPage()
        } else {
          this.discoveryPage()
        }
      }.width('100%').height('100%').align(Alignment.Top)
      if (this.pairingOpen) {
        Column().width('100%').height('100%').backgroundColor('#99000000').onClick(() => {
          if (!this.pairing && !this.scanning) {
            this.pairingOpen = false;
            this.invitation = '';
            this.error = '';
          }
        })
        this.pairingSheet()
      }
    }.width('100%').height('100%').backgroundColor(Color.Black)
  }
}
