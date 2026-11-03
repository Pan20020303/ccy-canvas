// 雙語劇本：.docx 產生器
//
// 每句對白分成兩行：
//   1. 主要語言，例如英文。
//   2. 翻譯，例如中文；以括號、灰色斜體呈現。
//
// 動作、括號提示與場景標題使用使用者選定的語言，依下方場景陣列填寫。
//
// 用法：
//   0. 先在技能根目錄執行一次 npm install。
//   1. 將本檔複製到工作目錄。
//   2. 每句雙語對白使用 ...dialB("主要語言台詞", "譯文")。
//   3. 執行 node build_bilingual.js。

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
  AlignmentType, Header, PageNumber
} = docx;

const FONT = "Courier New";
const SIZE = 24;

// ============ 輔助函式 ============

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
    indent: { left: 3168 },
    keepNext: true,
    children: [new TextRun({ text: txt, font: FONT, size: SIZE })]
  });
}

function paren(t) {
  return new Paragraph({
    spacing: { before: 0, after: 0, line: 240 },
    indent: { left: 2304, right: 2880 },
    keepNext: true,
    children: [new TextRun({ text: t.startsWith("(") ? t : `(${t})`, font: FONT, size: SIZE })]
  });
}

function dialMain(t) {
  return new Paragraph({
    spacing: { before: 0, after: 0, line: 240 },
    indent: { left: 1440, right: 2160 },
    children: [new TextRun({ text: t, font: FONT, size: SIZE })]
  });
}

function dialTranslation(t) {
  return new Paragraph({
    spacing: { before: 0, after: 120, line: 240 },
    indent: { left: 1440, right: 2160 },
    children: [new TextRun({ text: `(${t})`, font: FONT, size: SIZE, italics: true, color: "666666" })]
  });
}

// 雙語對白函式：使用展開運算子加入陣列，例如 ...dialB("...", "...")。
function dialB(main, translation) {
  return [dialMain(main), dialTranslation(translation)];
}

function trans(t) {
  return new Paragraph({
    spacing: { before: 240, after: 240, line: 240 },
    alignment: AlignmentType.RIGHT,
    children: [new TextRun({ text: t.toUpperCase(), font: FONT, size: SIZE, bold: true })]
  });
}

function center(t, opts = {}) {
  return new Paragraph({
    spacing: { before: opts.before ?? 240, after: opts.after ?? 240, line: 240 },
    alignment: AlignmentType.CENTER,
    children: [new TextRun({ text: t, font: FONT, size: opts.size || SIZE, bold: !!opts.bold })]
  });
}

function blank() {
  return new Paragraph({ spacing: { before: 0, after: 0, line: 240 }, children: [new TextRun({ text: "", font: FONT, size: SIZE })] });
}

// ============ 填入你的場景 ============

const screenplay = [
  blank(), blank(),
  center("我的專案", { bold: true, size: 32 }),
  center("雙語草稿（主要語言／譯文）"),
  blank(),

  slug("外景 — 地點 — 日"),
  action("以主要語言描述場景，只寫具體動作。"),

  character("主角"),
  ...dialB(
    "Main-language dialogue line.",
    "主要語言台詞。"
  ),

  character("另一角色"),
  paren("輕聲"),
  ...dialB(
    "Another line.",
    "另一句台詞。"
  ),

  trans("切至："),

  // 在此加入你的場景。
];

// ============ 組裝文件 ============

const doc = new Document({
  creator: "Screenwriter",
  title: "雙語劇本",
  styles: { default: { document: { run: { font: FONT, size: SIZE } } } },
  sections: [{
    properties: {
      page: {
        size: { width: 12240, height: 15840 },
        margin: { top: 1440, right: 1440, bottom: 1440, left: 2160 }
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
  const out = "./screenplay-bilingual.docx";
  fs.writeFileSync(out, buf);
  console.log(`已寫入 ${out}`);
}).catch(e => { console.error(e); process.exit(1); });
