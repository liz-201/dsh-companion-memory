import {spawn} from 'node:child_process'
import {existsSync,readFileSync,writeFileSync,mkdirSync} from 'node:fs'
import {resolve} from 'node:path'
import assert from 'node:assert/strict'
import {probeWindow} from '../lib/runtime/window-probe.js'
if(process.platform!=='win32')throw Error('Native verification requires Windows')
mkdirSync('artifacts',{recursive:true})
const path=resolve(`artifacts/perception-fixture-${process.pid}.json`)
const child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',resolve('scripts/perception-fixture.ps1'),'-OutputPath',path],{windowsHide:true,stdio:['ignore','ignore','pipe']})
let diagnostic='';child.stderr.on('data',chunk=>{diagnostic+=chunk.toString()})
const report={fixtureOnly:true,startedAt:new Date().toISOString()}
try{
 for(let i=0;i<100&&!existsSync(path);i++)await new Promise(r=>setTimeout(r,100))
 assert.ok(existsSync(path),'Fixture window started: '+diagnostic.slice(0,1000))
 const target=JSON.parse(readFileSync(path,'utf8').replace(/^\uFEFF/,''))
 const started=performance.now(),uia=await probeWindow('uia',target)
 report.uiaMs=Math.round(performance.now()-started);report.uiaFacts=uia.facts.length
 assert.ok(uia.facts.some(f=>f.text.includes('Build failed 42')),'UIA reads only fixture text')
 assert.ok(!JSON.stringify(uia).includes('fixture-secret-7291'),'Password value omitted: '+JSON.stringify(uia.facts))
 const imageStarted=performance.now(),image=await probeWindow('image',target)
 report.imageOcrMs=Math.round(performance.now()-imageStarted);report.pngBytes=Buffer.from(image.image,'base64').length;report.ocrError=image.ocrError??null
 assert.ok(report.pngBytes>100)
 assert.ok(!image.facts.some(f=>f.text.includes('fixture-secret-7291')))
 writeFileSync('artifacts/perception-fixture.png',Buffer.from(image.image,'base64'))
 await assert.rejects(probeWindow('uia',{...target,processId:target.processId+1}))
 report.identityReuseRejected=true;report.ok=true
 writeFileSync('artifacts/perception-native-report.json',JSON.stringify(report,null,2))
 console.log(JSON.stringify(report))
}finally{child.kill()}
