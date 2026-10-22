// 分場大綱（Treatment）：.docx 產生器
//
// 每場為標題加3至5句事件描述。
// 可選用問題標籤：⚠ [因果]／[價值]／[設定]／[節奏]。
//
// 用法：
//   0. 先在技能根目錄執行一次 npm install。
//   1. 將本檔複製到工作目錄。
//   2. 在 treatment 陣列中使用 ...scene("標題", "描述") 填寫。
//   3. 執行 node build_treatment.js。

const fs = require("fs");
let docx;

try {
  docx = require("docx");
} catch (error) {
  console.error('缺少依賴套件 "docx"，請先在技能根目錄執行 `npm install`。');
  throw error;
}

const {
  Document, Packer, Paragraph, TextRun,
  AlignmentType, HeadingLevel, Header, PageNumber
} = docx;

const FONT = "Calibri";
const SIZE = 22; // 11pt

let _sceneNum = 0;

function act(title) {
  return new Paragraph({
    spacing: { before: 480, after: 240 },
    alignment: AlignmentType.CENTER,
    children: [new TextRun({ text: title.toUpperCase(), font: FONT, size: 32, bold: true })]
  });
}

function scene(title, body, audit) {
  _sceneNum++;
  const titlePara = new Paragraph({
    spacing: { before: 360, after: 60 },
    children: [
      new TextRun({ text: `第${_sceneNum}場：`, font: FONT, size: SIZE, bold: true }),
      new TextRun({ text: title, font: FONT, size: SIZE, bold: true })
    ]
  });
  const bodyPara = new Paragraph({
    spacing: { before: 0, after: 120, line: 280 },
    children: [new TextRun({ text: body, font: FONT, size: SIZE })]
  });
  const out = [titlePara, bodyPara];
  if (audit) {
    out.push(new Paragraph({
      spacing: { before: 0, after: 240, line: 280 },
      children: [new TextRun({ text: `⚠ ${audit}`, font: FONT, size: SIZE - 2, italics: true, color: "C00000" })]
    }));
  }
  return out;
}

// ============ 分場大綱 ============

const treatment = [
  new Paragraph({
    spacing: { after: 240 },
    alignment: AlignmentType.CENTER,
    children: [new TextRun({ text: "專案名稱", font: FONT, size: 44, bold: true })]
  }),
  new Paragraph({
    spacing: { after: 480 },
    alignment: AlignmentType.CENTER,
    children: [new TextRun({ text: "分場大綱 v1", font: FONT, size: 24, italics: true })]
  }),

  act("第一幕"),

  ...scene(
    "地點 — 時段 — 狀態",
    "用3至5句交代事件、在場角色、起始價值、具體動作及結束時的價值。使用動作動詞，不直接描述情緒。"
  ),

  ...scene(
    "下一場",
    "若結構有問題，可在此加入問題標籤。",
    "[因果] 本場無法由前場推導，需要補上銜接。"
  ),

  // 在下方加入你的場景。
  // 用 act("第二幕")、act("第三幕") 分隔各幕。
];

// ============ 組裝文件 ============

const doc = new Document({
  creator: "Screenwriter",
  title: "分場大綱",
  styles: { default: { document: { run: { font: FONT, size: SIZE } } } },
  sections: [{
    properties: {
      page: {
        size: { width: 12240, height: 15840 },
        margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 }
      }
    },
    headers: {
      default: new Header({
        children: [new Paragraph({
          alignment: AlignmentType.RIGHT,
          children: [new TextRun({ children: [PageNumber.CURRENT], font: FONT, size: 20 })]
        })]
      })
    },
    children: treatment
  }]
});

Packer.toBuffer(doc).then(buf => {
  const out = "./treatment.docx";
  fs.writeFileSync(out, buf);
  console.log(`已寫入 ${out}`);
}).catch(e => { console.error(e); process.exit(1); });
