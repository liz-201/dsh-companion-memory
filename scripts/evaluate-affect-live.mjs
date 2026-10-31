import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AFFECT_EVALUATION_CASES } from '../lib/runtime/affect-evaluation.js'
import { EMOTION_CONTRACT } from '../lib/runtime/emotion-observation.js'
import { createHash } from 'node:crypto'
const arg = name => process.argv.find(value=>value.startsWith(`--${name}=`))?.slice(name.length+3)
const file = arg('panel-file') ?? path.join(os.homedir(),'.dsh','companions','control-panel.json')
let panel,page
for(let i=0;i<30;i++) {
  try {panel=JSON.parse(fs.readFileSync(file,'utf8'));const response=await fetch(panel.url,{signal:AbortSignal.timeout(1500)});if(!response.ok)throw Error('Panel not ready');page=await response.text();break}
  catch(error) {if(i===29)throw error;await new Promise(resolve=>setTimeout(resolve,1000))}
}
const match = /const token=("[^"]+")/.exec(page)
if(!match)throw Error('Unable to authenticate with local companion diagnostics')
const token=JSON.parse(match[1]),results=[]
const selected=arg('cases')?.split(',')??AFFECT_EVALUATION_CASES.map(scene=>scene.id)
if(selected.some(id=>!AFFECT_EVALUATION_CASES.some(scene=>scene.id===id)))throw Error('Unknown case ID')
for(const caseId of selected){
  try{
    const response=await fetch(new URL('/companion-memory/api/panel-action',panel.url),{method:'POST',headers:{'content-type':'application/json','x-companion-token':token},body:JSON.stringify({action:'affect-evaluate',caseId,contract:EMOTION_CONTRACT}),signal:AbortSignal.timeout(125000)})
    const result=await response.json()
    if(!response.ok)throw Error(`HTTP ${response.status}`)
    results.push(result)
    console.log(JSON.stringify({caseId,passed:result.passed,labels:result.labels,missing:result.missing,validationError:result.validationError,elapsedMs:result.elapsedMs}))
  }catch(error){results.push({caseId,passed:false,error:error.message});console.log(JSON.stringify({caseId,passed:false,error:error.message}))}
  const output=arg('output')??'artifacts/affect-live-evaluation.json'
  fs.mkdirSync(path.dirname(output),{recursive:true})
  fs.writeFileSync(output,JSON.stringify({at:new Date().toISOString(),mode:'live',synthetic:true,datasetVersion:'affect-development-v2',contractSha256:createHash('sha256').update(EMOTION_CONTRACT).digest('hex'),privateHistoryUsed:false,humanQualityVerified:false,results},null,2)+'\n')
}
console.log(JSON.stringify({total:results.length,passed:results.filter(r=>r.passed).length,humanQualityVerified:false}))
if(results.some(result=>!result.passed))process.exitCode=1
