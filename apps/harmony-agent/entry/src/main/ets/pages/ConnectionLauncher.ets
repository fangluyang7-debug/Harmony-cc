import { deviceInfo } from '@kit.BasicServicesKit';
import { common } from '@kit.AbilityKit';
import { scanBarcode, scanCore } from '@kit.ScanKit';
import { discoverCenters } from '../Discovery';
import { Bootstrap } from '../NativePlatform';
import { openAgent, contributeAgent, leaveAgent } from '../AgentRuntime';
import { resolveDevicePairingLink, readPairingTrust, resolvePairingCode, PairingTrust } from '../DevicePairingLink';

@Entry
@Component
struct ConnectionLauncher {
  @StorageLink('agentStatus') status: string = '';
  @StorageLink('agentPaired') paired: boolean = false;
  @StorageLink('agentCenter') center: string = '';
  @StorageLink('contributing') contributing: boolean = true;
  @StorageLink('maxCpuLimit') maxCpu: number = 0;
  @StorageLink('maxMemoryLimitMB') maxMemory: number = 0;
  @StorageLink('deviceTotalMemoryMB') deviceMemory: number = 0;

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

  @State private desktop: boolean = deviceInfo.deviceType === '2in1';
  @State private viewportWidth: number = 1100;
  @State private desktopSection: string = 'auto';

  private numericTrust: PairingTrust | null = null;
  private discoveryTimer: number = -1;
  private discoveryActive: boolean = false;
  private discoveryGeneration: number = 0;

  aboutToAppear(): void { this.startDiscovery(); }
  onPageShow(): void { this.startDiscovery(); }
  onPageHide(): void { this.stopDiscovery(); }
  aboutToDisappear(): void { this.stopDiscovery(); }

  private startDiscovery(): void {
    if (this.discoveryActive) return;
    this.discoveryActive = true;
    if (!this.paired) void this.discover();
    this.discoveryTimer = setInterval(() => {
      if (!this.paired && !this.scanning && !this.pairing) void this.discover(false);
    }, 5000);
  }

  private stopDiscovery(): void {
    this.discoveryActive = false;
    this.discoveryGeneration++;
    if (this.discoveryTimer !== -1) clearInterval(this.discoveryTimer);
    this.discoveryTimer = -1;
    this.searching = false;
    this.centers = [];
  }

  private async discover(clearPrevious: boolean = true): Promise<void> {
    if (this.searching) return;
    const generation = ++this.discoveryGeneration;
    this.searching = true;
    if (clearPrevious) {
      this.centers = [];
      this.searchMessage = '正在搜索附近的协调中心…';
    }
    try {
      const centers = await discoverCenters();
      if (!this.discoveryActive || generation !== this.discoveryGeneration) return;
      this.centers = centers;
      if (!this.pairingOpen && this.centers.indexOf(this.selected) < 0) this.selected = '';
      this.searchMessage = this.centers.length > 0 ? '发现 ' + this.centers.length + ' 个协调中心' : '未发现附近的协调中心';
    } catch (e) {
      if (!this.discoveryActive || generation !== this.discoveryGeneration) return;
      this.centers = [];
      this.searchMessage = '搜索失败，可以直接扫描设备邀请二维码';
    } finally {
      if (generation === this.discoveryGeneration) this.searching = false;
    }
  }

  private openPair(center: string): void {
    this.numericTrust = null;
    this.selected = center || (this.centers.length === 1 ? this.centers[0] : '');
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

  private async resolveInvitation(value: string): Promise<Bootstrap> {
    const input = value.trim();
    if (input.length > 16384) throw Error('设备邀请过大');
    if (!input.startsWith('https://')) return this.parseInvitation(input);
    const bootstrap = await resolveDevicePairingLink(input, this.selected, getContext(this) as common.UIAbilityContext);
    return this.parseInvitation(JSON.stringify(bootstrap));
  }

  private async scan(): Promise<void> {
    if (this.scanning || this.pairing) return;
    this.scanning = true;
    this.error = '';
    try {
      const result = await scanBarcode.startScanForResult(getContext(this) as common.UIAbilityContext, {
        scanTypes: [scanCore.ScanType.QR_CODE], enableMultiMode: false, enableAlbum: true
      });
      const bootstrap = await this.resolveInvitation(result.originalValue);
      this.invitation = JSON.stringify(bootstrap);
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
      const input = this.invitation.trim();
      if (/^\d{6}$/.test(input) && this.numericTrust === null) {
        this.numericTrust = await readPairingTrust(this.selected);
        this.details = '请核对协调中心配对窗口的证书指纹，一致后再次点击连接：\n' + this.numericTrust.fingerprint;
        return;
      }
      const bootstrap = /^\d{6}$/.test(input) && this.numericTrust !== null
        ? await resolvePairingCode(input, this.numericTrust, getContext(this) as common.UIAbilityContext)
        : await this.resolveInvitation(this.invitation);
      await openAgent(getContext(this) as common.UIAbilityContext, bootstrap);
      this.desktopSection = 'quota';
      this.invitation = '';
      this.pairingOpen = false;
    } catch (e) {
      this.numericTrust = null;
      this.details = '';
      const code = (e as Error).message;
      this.error = code === 'PAIRING_RECONCILIATION_REQUIRED'
        ? '配对失败：该邀请上次配对结果未知，可能已被使用。请在协调中心重新生成邀请后再连接。'
        : '配对失败：' + code;
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

  private async leave():Promise<void>{
    if(this.pairing)return;this.pairing=true;this.error='';
    try{await leaveAgent(getContext(this) as common.UIAbilityContext);this.desktopSection='discover';void this.discover();}
    catch(e){this.error='退出未完成：'+(e as Error).message;}finally{this.pairing=false;}
  }
  @Builder
  private spaceActions(){
    Button('退出当前协作空间').backgroundColor('#583437').enabled(!this.pairing).onClick(()=>{void this.leave();})
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
      if (this.status === '协调中心已断开，请重新配对') {
        Text('协调中心已关闭，本机已断开并清除配对。请重新扫码或输入配对码。')
          .fontSize(14).fontColor('#FDBA74').padding(14).width('100%')
          .borderRadius(18).backgroundColor('#2A1E12')
      }
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
              Text('扫码或输入配对码').fontSize(12).fontColor('#A1A1AA')
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
      Button('输入配对码或邀请链接').backgroundColor('#1C1C1E')
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
      this.spaceActions()
      Column({ space: 7 }) {
        Text(this.status.startsWith('已连接') ? '已连接' : '已配对').fontColor('#30D158').fontSize(14)
        Text(this.center || '协调中心').fontSize(20).fontWeight(FontWeight.Bold).fontColor(Color.White)
        Text(this.status).fontSize(13).fontColor('#A1A1AA')
      }.width('100%').alignItems(HorizontalAlign.Start).padding(18).borderRadius(20).backgroundColor('#1C1C1E')
      Row({ space: 12 }) {
        this.quota('CPU 槽位', this.maxCpu > 0 ? String(this.maxCpu) : '待分配')
        this.quota('内存', this.maxMemory > 0 ? this.maxMemory + ' MiB' : '待分配')
      }.width('100%')
      Text(this.deviceMemory > 0
        ? '本机运行内存 ' + this.deviceMemory + ' MiB。额度由协调中心按上报的运行内存自动确定，预留系统及日常应用所需后分配；存储空间不计入。'
        : '额度由协调中心按本机上报的运行内存自动确定，连接后更新。')
        .fontSize(14).fontColor('#A1A1AA')
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
          TextInput({ placeholder: '协调中心地址（发现失败时填写）', text: this.selected })
            .enabled(!this.pairing && !this.scanning)
            .onChange(value => { this.selected = value.trim(); this.numericTrust = null; })
          TextArea({ placeholder: '输入 6 位配对码，或粘贴邀请链接', text: this.invitation })
            .height(96).maxLength(16384).backgroundColor('#121216').fontColor(Color.White)
            .enabled(!this.pairing && !this.scanning)
            .onChange(value => { this.invitation = value; this.numericTrust = null; })
          Button('扫描邀请二维码').backgroundColor('#25252A').enabled(!this.pairing && !this.scanning)
            .onClick(() => { void this.scan(); })
        }
        if (this.error) Text(this.error).fontSize(14).fontColor('#FDA4AF')
        Row({ space: 10 }) {
          Button('取消').layoutWeight(1).backgroundColor('#303038').enabled(!this.pairing && !this.scanning)
            .onClick(() => { this.pairingOpen = false; this.invitation = ''; this.error = ''; })
          Button(this.pairing ? '连接中…' : this.numericTrust !== null ? '确认指纹并连接' : '连接').layoutWeight(1).backgroundColor('#0A59F7')
            .enabled(this.invitation.trim().length > 0 && !this.pairing && !this.scanning)
            .onClick(() => { void this.join(); })
        }.width('100%')
      }.width('100%').alignItems(HorizontalAlign.Start).padding(22)
    }.width(this.desktop ? '80%' : '100%').constraintSize({ maxHeight: '80%', maxWidth: this.desktop ? 520 : '100%' })
      .borderRadius({ topLeft: 24, topRight: 24 }).backgroundColor('#1C1C1E')
  }

  // Native desktop translation of apps/runtime-desktop/agent.html.
  @Builder
  private desktopPage() {
    Row() {
      Column({ space: 14 }) {
        Text('智调鸿枢').fontSize(19).fontWeight(FontWeight.Bold).fontColor('#F1F5F9')
        Text('HarmonyOS 设备调度件').fontSize(14).fontColor('#A0ABC0')
        Button('搜索协调中心').width('100%').backgroundColor('#162647')
          .onClick(() => { this.desktopSection = 'discover'; void this.discover(); })
        Button('输入配对码或邀请链接').width('100%').backgroundColor('#25314A')
          .onClick(() => { this.openPair(''); })
        Button('扫一扫').width('100%').backgroundColor('#25314A').enabled(!this.scanning && !this.pairing)
          .onClick(() => { this.selected = ''; void this.scan(); })
        Button('贡献上限').width('100%').backgroundColor('#25314A').enabled(this.paired)
          .onClick(() => { this.desktopSection = 'quota'; })
      }.width(this.viewportWidth < 800 ? 170 : 220).height('100%').padding({ top: 24, left: 16, right: 16 })
        .alignItems(HorizontalAlign.Start).backgroundColor('#11141C')
      Scroll() {
        Column({ space: 16 }) {
          Row({ space: 12 }) {
            Column({ space: 4 }) {
              Text('设备接入与调度控制台').fontSize(23).fontWeight(FontWeight.Bold).fontColor('#F1F5F9')
              Text(this.status || '未连接协调中心').fontSize(14).fontColor('#A0ABC0')
            }.layoutWeight(1).alignItems(HorizontalAlign.Start)
            Button('重新搜索').backgroundColor('#25314A').enabled(!this.searching)
              .onClick(() => { this.desktopSection = 'discover'; void this.discover(); })
          }.width('100%').padding({ bottom: 16 })
          if (this.paired && this.desktopSection !== 'discover') {
            this.spaceActions()
            Column({ space: 16 }) {
              Row({ space: 12 }) {
                Column({ space: 6 }) {
                  Text('贡献上限').fontSize(17).fontColor('#F1F5F9')
                  Text(this.center).fontSize(14).fontColor('#A0ABC0')
                }.layoutWeight(1).alignItems(HorizontalAlign.Start)
                Button(this.contributing ? '停止设备调度件' : '开启设备调度件').backgroundColor('#1756D4')
                  .enabled(!this.changingContribution).onClick(() => { void this.setContribution(!this.contributing); })
              }.width('100%')
              Row({ space: 12 }) {
                this.quota('CPU 槽位', this.maxCpu > 0 ? String(this.maxCpu) : '待分配')
                this.quota('内存', this.maxMemory > 0 ? this.maxMemory + ' MiB' : '待分配')
              }.width('100%')
              Text('额度由协调中心按本机上报的运行内存和 CPU 自动确定，预留系统及日常应用所需后分配。实际在线状态请在调度盘查看。')
                .fontSize(14).fontColor('#A0ABC0')
              Text('鸿蒙调度件切到后台时暂停接收新任务。').fontSize(13).fontColor('#A0ABC0')
            }.width('100%').padding(20).borderRadius(16).backgroundColor('#161B26')
          } else {
            Column({ space: 16 }) {
              Text('局域网自动发现').fontSize(16).fontColor('#F1F5F9')
              Text(this.searchMessage).fontSize(14).fontColor('#A0ABC0')
              Text('附近的协调中心').fontSize(17).fontColor('#F1F5F9')
              Flex({ wrap: FlexWrap.Wrap }) {
                ForEach(this.centers, (address: string) => {
                  Column({ space: 10 }) {
                    Text('协调中心').fontSize(17).fontColor('#F1F5F9')
                    Text(address).fontSize(13).fontColor('#A0ABC0')
                    Text('输入配对码连接 ›').fontSize(14).fontColor('#93C5FD')
                  }.width(this.viewportWidth < 800 ? '100%' : 260).padding(16).margin({ right: 12, bottom: 12 }).borderRadius(12)
                    .backgroundColor('#131926').alignItems(HorizontalAlign.Start)
                    .onClick(() => { this.openPair(address); })
                }, (address: string) => address)
              }.width('100%')
              if (!this.searching && this.centers.length === 0) {
                Text('未发现协调中心，请确认处于同一局域网，或输入地址和配对码。').fontColor('#A0ABC0')
              }
            }.width('100%').padding(20).borderRadius(16).backgroundColor('#161B26').alignItems(HorizontalAlign.Start)
          }
          if (this.error && !this.pairingOpen) Text(this.error).fontColor('#FDA4AF')
          Column({ space: 8 }) {
            Text('运行状态').fontSize(17).fontColor('#F1F5F9')
            Text(this.status || '暂无运行信息').fontSize(14).fontColor('#A0ABC0')
          }.width('100%').padding(20).borderRadius(16).backgroundColor('#161B26').alignItems(HorizontalAlign.Start)
        }.width('100%').padding(this.viewportWidth < 800 ? 16 : 28).alignItems(HorizontalAlign.Start)
      }.layoutWeight(1).height('100%').align(Alignment.Top)
    }.width('100%').height('100%').backgroundColor('#0B0E14')
  }

  build() {
    Stack({ alignContent: this.desktop ? Alignment.Center : Alignment.Bottom }) {
      if (this.desktop) {
        this.desktopPage()
      } else {
        Scroll() {
          if (this.paired) {
            this.contributionPage()
          } else {
            this.discoveryPage()
          }
        }.width('100%').height('100%').align(Alignment.Top)
      }
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
      .onAreaChange((_old: Area, area: Area) => { this.viewportWidth = Number(area.width); })
  }
}
