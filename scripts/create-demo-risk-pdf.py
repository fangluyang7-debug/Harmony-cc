from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "提交文件" / "competition-deliverables" / "20260930-harmony-architecture-packages-final-clean-v3" / "演示外部因素说明.pdf"
FONT_PATH = Path("C:/Windows/Fonts/msyh.ttc")


def register_fonts() -> tuple[str, str]:
    if FONT_PATH.exists():
        pdfmetrics.registerFont(TTFont("MicrosoftYaHei", str(FONT_PATH), subfontIndex=0))
        pdfmetrics.registerFont(TTFont("MicrosoftYaHeiBold", str(FONT_PATH), subfontIndex=1))
        return "MicrosoftYaHei", "MicrosoftYaHeiBold"
    return "Helvetica", "Helvetica-Bold"


def make_story(font_name: str, bold_name: str):
    styles = getSampleStyleSheet()
    title = ParagraphStyle(
        "CnTitle",
        parent=styles["Title"],
        fontName=bold_name,
        fontSize=18,
        leading=24,
        textColor=colors.HexColor("#172033"),
        spaceAfter=8,
    )
    meta = ParagraphStyle(
        "CnMeta",
        parent=styles["Normal"],
        fontName=font_name,
        fontSize=9,
        leading=14,
        textColor=colors.HexColor("#6B7280"),
        spaceAfter=10,
    )
    body = ParagraphStyle(
        "CnBody",
        parent=styles["Normal"],
        fontName=font_name,
        fontSize=10.2,
        leading=16,
        textColor=colors.HexColor("#222222"),
        spaceAfter=7,
    )
    h2 = ParagraphStyle(
        "CnHeading",
        parent=body,
        fontName=bold_name,
        fontSize=12,
        leading=17,
        textColor=colors.HexColor("#111827"),
        spaceBefore=8,
        spaceAfter=6,
    )

    return [
        Paragraph("harmony-agent 演示外部因素说明", title),
        Paragraph("适用于 2026-09-30 最终提交包。本文只说明可能影响现场演示的外部条件，不改变项目源码能力和分包定位。", meta),
        Paragraph("可能影响演示的情况", h2),
        Paragraph(
            "SoleAI 演示链路依赖手机 App、Zeabur 云端 API、电脑调度盘、局域网和目标设备状态。当前提交包已经包含可运行 HAP、应用源码、微观调度 HAR、电脑调度盘和云端宏观调度源码；现场演示是否顺利，仍可能受到外部运行环境影响。",
            body,
        ),
        Spacer(1, 3),
        Paragraph(
            "Zeabur 云端实例的运行状态可能影响演示。若云端实例发生休眠、重启、额度限制、环境变量失效或部署平台短时异常，SoleAI 的文字搜索、图片检索、宏观调度接口和运行记录返回可能出现超时、失败或结果延迟。",
            body,
        ),
        Paragraph(
            "网络和 DNS 状态可能影响演示。手机网络、电脑网络、云端访问链路或 DNS 解析发生波动时，可能出现请求无法发出、图片上传失败、云端响应时间变长、调度链路状态更新不及时等情况。",
            body,
        ),
        Paragraph(
            "电脑调度盘依赖本地端口和局域网连接。默认的 8765 端口如果被其他程序占用，或被 Windows 防火墙、路由器隔离策略拦截，手机端就可能无法把实时遥测推送到电脑调度盘。手机端如果把电脑地址误填为 localhost，也会导致连接失败。",
            body,
        ),
        Paragraph(
            "HAP 安装和签名环境可能影响演示。调试签名包的安装范围受证书、设备授权和系统版本限制；目标手机的权限状态、前后台状态、电量、网络权限和系统资源状态，也可能影响任务采样、上传和调度状态展示。",
            body,
        ),
        Paragraph(
            "第三方模型、图片处理、对象存储或外部 API 的可用性可能影响演示。若相关服务出现限流、响应变慢、鉴权异常或临时不可用，演示中的商品理解、图片检索、结果生成和云端阶段耗时可能受到影响。",
            body,
        ),
        Paragraph(
            "双机或多设备演示还会受到设备在线状态影响。参与设备如果熄屏、断网、后台受限、连接中断或设备画像未及时更新，宏观调度记录、设备回执和电脑端观测结果可能无法完整对应到同一次演示任务。",
            body,
        ),
    ]


def main() -> None:
    font_name, bold_name = register_fonts()
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    doc = SimpleDocTemplate(
        str(OUTPUT),
        pagesize=A4,
        rightMargin=18 * mm,
        leftMargin=18 * mm,
        topMargin=17 * mm,
        bottomMargin=16 * mm,
        title="harmony-agent 演示外部因素说明",
        author="harmony-agent",
    )
    doc.build(make_story(font_name, bold_name))
    print(OUTPUT)


if __name__ == "__main__":
    main()
