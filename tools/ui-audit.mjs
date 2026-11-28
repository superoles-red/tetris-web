const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright-core');
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const ROM_PATH=process.env.ROM_PATH;
const BASE_URL = process.env.BASE_URL ?? 'http://127.0.0.1:8085/';
const sha=createHash('sha256').update(await readFile(ROM_PATH)).digest('hex');
const browser=await chromium.launch({executablePath: process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
const report={};
async function boot(viewport={width:390,height:844}){
  const ctx=await browser.newContext({viewport,locale:'ru-RU'});
  const page=await ctx.newPage();
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(BASE_URL,{waitUntil:'load'});
  await page.waitForTimeout(400);
  await page.evaluate(([k])=>{localStorage.setItem(k, JSON.stringify([{language:'ru',score:4321,lines:21,name:'TEST'}]));},['tetris-web:records:'+sha]);
  await page.reload({waitUntil:'load'});
  await page.waitForTimeout(500);
  await page.setInputFiles('#rom-file',ROM_PATH);
  for(let i=0;i<120;i++){if(await page.evaluate(()=>document.getElementById('overlay').dataset.menu)==='home')break;await page.waitForTimeout(300);}
  await page.waitForTimeout(1200);
  return {ctx,page,errors};
}
// ---------- title: firework regions + border symmetry ----------
{
  const {ctx,page}=await boot();
  const regions=await page.evaluate(async () => {
    const canvas=document.getElementById('art-canvas');
    const ctx=canvas.getContext('2d');
    const snap=()=>ctx.getImageData(0,0,canvas.width,canvas.height).data;
    const first=snap();
    let x0=1e9,x1=-1,y0=1e9,y1=-1,n=0;
    const regions=[];
    for(let t=0;t<10;t++){
      await new Promise(r=>setTimeout(r,600));
      const data=snap();
      let bx0=1e9,bx1=-1,by0=1e9,by1=-1;
      for(let y=0;y<canvas.height;y++)for(let x=0;x<canvas.width;x++){
        const i=(y*canvas.width+x)*4;
        if(data[i]!==first[i]||data[i+1]!==first[i+1]||data[i+2]!==first[i+2]){
          n++; if(x<bx0)bx0=x; if(x>bx1)bx1=x; if(y<by0)by0=y; if(y>by1)by1=y;
        }
      }
      if(bx1>=0) regions.push([bx0,bx1,by0,by1]);
    }
    // симметрия рамки: сравниваем 16 px слева и 16 px справа (зеркально)
    const w=canvas.width,h=canvas.height;
    const frame=snap();
    let diff=0,total=0;
    for(let y=0;y<h;y++){
      for(let d=0;d<16;d++){
        const li=((y*w)+d)*4, ri=((y*w)+(w-1-d))*4;
        total++;
        if(frame[li]!==frame[ri]||frame[li+1]!==frame[ri+1]||frame[li+2]!==frame[ri+2]) diff++;
      }
    }
    return {regions, borderDiff:diff, borderTotal:total, size:[w,h]};
  });
  report.title={regions:regions.regions, distinctRegions:[...new Set(regions.regions.map(r=>r.join(',')))].length, borderDiffRatio:regions.borderDiff/regions.borderTotal, canvas:regions.size};
  await page.screenshot({path:'/tmp/audit-home.png'});
  // safe area simulation
  await page.evaluate(()=>{const r=document.documentElement;r.style.setProperty('--device-safe-top','59px');r.style.setProperty('--ui-safe-top','59px');r.style.setProperty('--device-safe-bottom','34px');});
  await page.waitForTimeout(300);
  await page.screenshot({path:'/tmp/audit-safe.png'});
  await ctx.close();
}
// ---------- menu ornament ----------
{
  const {ctx,page}=await boot();
  await page.locator('#home-settings').click();await page.waitForTimeout(500);
  report.settingsPanel=await page.evaluate(()=>{const p=document.getElementById('panel');const r=p.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height};});
  await page.screenshot({path:'/tmp/audit-settings.png'});
  await ctx.close();
}
// ---------- records ----------
{
  const {ctx,page}=await boot();
  await page.locator('#records').click();await page.waitForTimeout(500);
  report.records=await page.evaluate(()=>{
    const slot=document.querySelector('.record-name-slot');const name=slot?.firstElementChild;
    return {text:name?.textContent||null, slotWidth:slot?.getBoundingClientRect().width||0, fontSize:name?getComputedStyle(name).fontSize:null, fontFamily:name?getComputedStyle(name).fontFamily:null};
  });
  await page.screenshot({path:'/tmp/audit-records.png'});
  await ctx.close();
}
// ---------- WITH mode ----------
{
  const {ctx,page}=await boot();
  await page.locator('#play').click();await page.waitForTimeout(300);
  if(await page.locator('#confirm-yes').isVisible().catch(()=>false))await page.locator('#confirm-yes').click();
  await page.evaluate(()=>{const r=[...document.querySelectorAll('#setup-choices .choice-row')];r[0].querySelector('.choice-arrow.next').click();});
  await page.waitForTimeout(120);
  await page.evaluate(()=>{const r=[...document.querySelectorAll('#setup-choices .choice-row')];r[0].querySelector('.choice-arrow.next').click();});
  await page.waitForTimeout(120);
  await page.locator('#start').click();
  for(let i=0;i<40;i++){if(await page.evaluate(()=>document.getElementById('game').dataset.scene)==='play')break;await page.waitForTimeout(400);}
  await page.waitForTimeout(900);
  await page.screenshot({path:'/tmp/audit-with.png'});
  await page.waitForTimeout(2500);
  await page.screenshot({path:'/tmp/audit-with-late.png'});
  await ctx.close();
}
// ---------- VS mode ----------
{
  const {ctx,page}=await boot();
  await page.locator('#play').click();await page.waitForTimeout(300);
  if(await page.locator('#confirm-yes').isVisible().catch(()=>false))await page.locator('#confirm-yes').click();
  await page.evaluate(()=>{const r=[...document.querySelectorAll('#setup-choices .choice-row')];r[0].querySelector('.choice-arrow.next').click();});
  await page.waitForTimeout(120);
  await page.locator('#start').click();
  for(let i=0;i<40;i++){if(await page.evaluate(()=>document.getElementById('game').dataset.scene)==='play')break;await page.waitForTimeout(400);}
  await page.waitForTimeout(2000);
  await page.screenshot({path:'/tmp/audit-vs.png'});
  await ctx.close();
}
// ---------- Continue (WITH, after reload, simulated safe areas) ----------
{
  const {ctx,page}=await boot();
  await page.evaluate(()=>{const r=document.documentElement;r.style.setProperty('--device-safe-top','59px');r.style.setProperty('--ui-safe-top','59px');r.style.setProperty('--device-safe-bottom','34px');});
  await page.locator('#play').click();await page.waitForTimeout(300);
  if(await page.locator('#confirm-yes').isVisible().catch(()=>false))await page.locator('#confirm-yes').click();
  for(let i=0;i<2;i++){await page.evaluate(()=>{const r=[...document.querySelectorAll('#setup-choices .choice-row')];r[0].querySelector('.choice-arrow.next').click();});await page.waitForTimeout(120);}
  await page.locator('#start').click();
  for(let i=0;i<40;i++){if(await page.evaluate(()=>document.getElementById('game').dataset.scene)==='play')break;await page.waitForTimeout(400);}
  await page.waitForTimeout(6000);
  await page.locator('#pause-key').click();await page.waitForTimeout(400);
  await page.locator('#main-menu').click();await page.waitForTimeout(300);
  if(await page.locator('#confirm-yes').isVisible().catch(()=>false))await page.locator('#confirm-yes').click();
  await page.waitForTimeout(700);
  await page.reload({waitUntil:'load'});await page.waitForTimeout(2500);
  if(await page.locator('#continue-run').isVisible().catch(()=>false)){
    await page.locator('#continue-run').click();await page.waitForTimeout(300);
    if(await page.locator('#confirm-yes').isVisible().catch(()=>false))await page.locator('#confirm-yes').click();
    await page.waitForTimeout(3000);
    report.continueState=await page.evaluate(()=>{const c=document.getElementById('picture');const r=c.getBoundingClientRect();return {canvasW:c.width,canvasH:c.height,cssW:Math.round(r.width),cssH:Math.round(r.height),scene:document.getElementById('game').dataset.scene};});
    await page.screenshot({path:'/tmp/audit-continue.png'});
  } else report.continueState={error:'no continue button'};
  await ctx.close();
}
report.errors=(await Promise.all([])).length?null:undefined;
await browser.close();
await writeFile('/tmp/audit-report.json', JSON.stringify(report,null,1));
console.log(JSON.stringify(report,null,1));
