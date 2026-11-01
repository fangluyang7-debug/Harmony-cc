@Entry
@Component
struct Index {
  @StorageLink('probeResult') result: string = '正在运行 HAR 原生验证…';
  build() { Column({space:20}) { Text('Harmony · HAR 验证').fontSize(26).fontWeight(FontWeight.Bold); Text(this.result).fontSize(16) }.padding(24).width('100%').height('100%').justifyContent(FlexAlign.Center) }
}
