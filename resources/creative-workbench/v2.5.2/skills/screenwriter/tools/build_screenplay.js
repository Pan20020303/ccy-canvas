// 好萊塢格式劇本：.docx 產生器
//
// 用法：
//   0. 先在技能根目錄執行一次 npm install。
//   1. 將本檔複製到工作目錄，重新命名，例如 build_my_scene.js。
//   2. 在 screenplay 陣列中，使用 slug/action/character/dial 等函式填入場景。
//   3. 執行 node build_my_scene.js。
//   4. 工作目錄會產生 screenplay.docx。
//
// 好萊塢格式：
//   紙張：8.5 × 11英吋（US Letter）。
//   頁邊距：上、下、右各1英吋，左1.5英吋。
//   Courier New 12 pt；對白與動作混合時，一頁約一分鐘只是粗估。
//   場景標題：靠左、粗體；英文使用全大寫。
//   動作：靠左，使用現在式。
//   角色名：左縮排2.2英吋（3168 DXA）。
//   括號提示：左縮排1.6英吋（2304 DXA）。
//   對白：左縮排1英吋、右縮排1.5英吋（1440／2160 DXA）。
//   轉場：靠右；英文使用全大寫。

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
  AlignmentType, Header, PageNumber, PageBreak
} = docx;

const FONT = "Courier New";
const SIZE = 24; // 12 pt，以半點為單位

// ============ 輔助函式 ============

// 啟用自動場次編號；若不是從第一場開始，可調整起始編號。
const ENABLE_SCENE_NUMBERS = true;
const START_SCENE_NUMBER = 1;
let _sceneNum = START_SCENE_NUMBER - 1;

function slug(t) {
  let text = t.toUpperCase();
  if (ENABLE_SCENE_NUMBERS) {
    _sceneNum++;
    text = `${_sceneNum}  ${text}`;
  }
  return new Paragraph({
    spacing: { before: 360, after: 240, line: 240 },
    keepNext: true,
    children: [new TextRun({ text, font: FONT, size: SIZE, bold: true })]
  });
}

function action(t) {
  return new Paragraph({
    spacing: { before: 0, after: 240, line: 240 },
    children: [new TextRun({ text: t, font: FONT, size: SIZE })]
  });
}

function character(name, ext) {
  const txt = ext ? `${name.toUpperCase()} (${ext})` : name.toUpperCase();
  return new Paragraph({
    spacing: { before: 240, after: 0, line: 240 },
    indent: { left: 3168 }, // 2.2"
    keepNext: true,
    children: [new TextRun({ text: txt, font: FONT, size: SIZE })]
  });
}

function paren(t) {
  return new Paragraph({
    spacing: { before: 0, after: 0, line: 240 },
    indent: { left: 2304, right: 2880 }, // 左1.6英吋，右約2.0英吋
    keepNext: true,
    children: [new TextRun({ text: t.startsWith("(") ? t : `(${t})`, font: FONT, size: SIZE })]
  });
}

function dial(t) {
  return new Paragraph({
    spacing: { before: 0, after: 0, line: 240 },
    indent: { left: 1440, right: 2160 }, // 左1英吋，右1.5英吋
    children: [new TextRun({ text: t, font: FONT, size: SIZE })]
  });
}

function trans(t) {
  return new Paragraph({
    spacing: { before: 240, after: 240, line: 240 },
    alignment: AlignmentType.RIGHT,
    children: [new TextRun({ text: t.toUpperCase(), font: FONT, size: SIZE, bold: true })]
  });
}

function pageBreak() { return new Paragraph({ children: [new PageBreak()] }); }
function blank() { return new Paragraph({ spacing: { before: 0, after: 0, line: 240 }, children: [new TextRun({ text: "", font: FONT, size: SIZE })] }); }

function center(t, opts = {}) {
  return new Paragraph({
    spacing: { before: opts.before ?? 240, after: opts.after ?? 240, line: 240 },
    alignment: AlignmentType.CENTER,
    children: [new TextRun({ text: t, font: FONT, size: opts.size || SIZE, bold: !!opts.bold })]
  });
}

// ============ 填入你的場景 ============

const screenplay = [
  blank(), blank(),
  center("我的專案", { bold: true, size: 32 }),
  center("場景段落 — 暫定片名"),
  blank(),

  // 場景示例：請替換為自己的內容。
  slug("外景 — 地點 — 時段"),
  action("描述畫面中可見的內容，只寫具體動作。"),
  action("如有需要，加入第二個動作。"),

  character("主角"),
  dial("主角的台詞。"),

  character("第二個角色"),
  paren("輕聲"),
  dial("第二個角色的台詞。"),

  trans("切至："),

  // 在下方加入你的場景。
];

// ============ 組裝文件 ============

const doc = new Document({
  creator: "Screenwriter",
  title: "劇本",
  styles: { default: { document: { run: { font: FONT, size: SIZE } } } },
  sections: [{
    properties: {
      page: {
        size: { width: 12240, height: 15840 }, // 8.5" x 11"
        margin: { top: 1440, right: 1440, bottom: 1440, left: 2160 } // 左1.5英吋，其餘各1英吋
      }
    },
    headers: {
      default: new Header({
        children: [new Paragraph({
          alignment: AlignmentType.RIGHT,
          children: [new TextRun({ children: [PageNumber.CURRENT, "."], font: FONT, size: 22 })]
        })]
      })
    },
    children: screenplay
  }]
});

Packer.toBuffer(doc).then(buf => {
  const out = "./screenplay.docx";
  fs.writeFileSync(out, buf);
  console.log(`已寫入 ${out}`);
}).catch(e => { console.error(e); process.exit(1); });
