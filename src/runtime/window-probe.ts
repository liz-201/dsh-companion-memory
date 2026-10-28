import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export interface WindowIdentity { windowId: number; processId: number; app: string; startedAt: string; foreground: boolean; minimized: boolean }
export interface WindowObservation { window: WindowIdentity; facts: {text:string;source:'uia'|'ocr';control:string}[]; image?: string;mediaType?:string;ocrError?:string|null;truncated?:boolean }
export function probeWindow(mode:'windows', window?:undefined,signal?:AbortSignal): Promise<{windows:WindowIdentity[]}>
export function probeWindow(mode:'uia'|'image',window:WindowIdentity,signal?:AbortSignal):Promise<WindowObservation>
export function probeWindow(mode:'windows'|'uia'|'image',window?:WindowIdentity,signal?:AbortSignal):Promise<{windows:WindowIdentity[]}|WindowObservation> {
  if(process.platform!=='win32')return Promise.reject(Error('Windows perception is unavailable on this platform'))
  if(window&&(!Number.isSafeInteger(window.windowId)||window.windowId<=0||!Number.isSafeInteger(window.processId)||window.processId<=0||typeof window.app!=='string'||window.app.length>80||!/^\d{1,22}$/.test(window.startedAt)))return Promise.reject(Error('Invalid window identity'))
  const args=['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',fileURLToPath(new URL('../../scripts/windows-perception.ps1',import.meta.url)),'-Mode',mode]
  if(window)args.push('-WindowId',String(window.windowId),'-ExpectedProcessId',String(window.processId),'-ExpectedProcessName',window.app,'-ExpectedStartedAt',window.startedAt)
  return new Promise((resolve,reject)=>{
    execFile('powershell.exe',args,{windowsHide:true,timeout:12000,maxBuffer:8*1024*1024,encoding:'utf8',...(signal?{signal}:{})},(error,stdout)=>{
      if(error){reject(Error(signal?.aborted?'perception-cancelled':'window-probe-unavailable'));return}
      try{const result=JSON.parse(stdout.trim());if(result.error)throw Error(result.error);resolve(result)}catch{reject(Error('Invalid window probe result'))}
    })
  })
}
