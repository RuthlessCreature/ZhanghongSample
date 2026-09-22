import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root=process.cwd();
const pages=[
  "index.html","version-diff.html","drawing-review.html","comment-check.html",
  "history-search.html","reference-assistant.html","geotech-conditions.html","design-briefing.html"
];
const modulePages=pages.slice(1);
const banned=[
  "狠狠干","扔进来","最恶心","谁记得在哪","背规范","拎出来",
  "别再靠肉眼硬找","别靠人脑逐条翻图","AI REVIEW","AI预审问题"
];

for(const file of pages){
  const full=path.join(root,"public",file);
  assert.ok(fs.existsSync(full),file+" missing");
  const html=fs.readFileSync(full,"utf8");
  assert.match(html,/<title>[^<]{4,}<\/title>/,file+" title missing");
  assert.match(html,/<meta\s+name="description"\s+content="[^"]{20,}"\s*\/?>/,file+" description missing");
  assert.equal((html.match(/\/product-theme\.css/g)||[]).length,1,file+" must load product-theme.css exactly once");
  assert.equal((html.match(/<h1\b/g)||[]).length,1,file+" should contain one primary h1");
  assert.ok(html.includes("<main"),file+" main missing");
  assert.ok(html.includes("<footer"),file+" footer missing");
  for(const word of banned) assert.ok(!html.includes(word),file+" contains banned wording: "+word);
  for(const img of html.match(/<img\b[^>]*>/g)||[]) assert.match(img,/\balt="[^"]*"/,file+" image without alt");
}

const home=fs.readFileSync(path.join(root,"public","index.html"),"utf8");
assert.ok(home.includes("7 / 7 MODULES ONLINE"),"home module status must be 7/7");
assert.ok(home.includes("class=\"system-overview\""),"home system overview missing");
for(const page of modulePages) assert.ok(home.includes('href="/'+page+'"'),"home missing link to "+page);

const themePath=path.join(root,"public","product-theme.css");
assert.ok(fs.existsSync(themePath),"product theme missing");
const theme=fs.readFileSync(themePath,"utf8");
for(const token of ["--cyan:","backdrop-filter","system-overview","prefers-reduced-motion","brief-section","condition.found"]){
  assert.ok(theme.includes(token),"theme missing token "+token);
}
const opens=(theme.match(/\{/g)||[]).length,closes=(theme.match(/\}/g)||[]).length;
assert.equal(opens,closes,"theme CSS braces unbalanced");

console.log(JSON.stringify({ok:true,pages:pages.length,modulePages:modulePages.length,bannedTerms:banned.length,themeBytes:theme.length},null,2));
