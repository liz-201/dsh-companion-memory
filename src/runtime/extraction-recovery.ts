import type { Repositories } from '../storage/repositories.js'

/** Receipt per job: an older cloud snapshot can arrive after the startup recovery pass. */
export function recoverCapabilityExtractions(repos:Repositories,nowMs=Date.now()):number{
  return repos.db.transaction(()=>{
    const jobs=repos.db.all<{id:string}>("SELECT j.id FROM background_jobs j JOIN raw_messages r ON r.id=json_extract(j.payload_json,'$.messageId') WHERE j.kind='extract' AND j.status='failed' AND j.last_error LIKE '%没有声明关闭思考%' AND r.role='user' AND r.deleted_at_ms IS NULL")
    const ids:string[]=[]
    for(const job of jobs){
      const key=`local.extract.recovery:${job.id}:capability-v1`
      if(repos.getSetting(key))continue
      if(repos.db.run("UPDATE background_jobs SET status='pending',attempts=0,lease_until_ms=NULL,available_at_ms=? WHERE id=? AND status='failed'",nowMs,job.id).changes){repos.setSetting(key,'1',nowMs);ids.push(job.id)}
    }
    if(ids.length)repos.audit({principalId:null,kind:'extract.capability-recovery',entityId:'capability-v1',payload:{recovered:ids.length,jobIds:ids},createdAtMs:nowMs})
    repos.setSetting('local.extract.capability-recovery','1',nowMs)
    return ids.length
  })
}
