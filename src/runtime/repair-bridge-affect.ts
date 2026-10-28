import type { Config } from '../config.js'
import type { Repositories } from '../storage/repositories.js'
import { detectSourceKind } from '../memory/source-policy.js'
import { rebuildAffect } from '../domain/affect-projector.js'
import { backupNow, backupDirectory } from '../storage/backup.js'

/** Repair only deterministic technical-prefix misclassification; retain source and audit history. */
export function repairBridgeAffect(repos: Repositories, config: Config, nowMs: number): { events: number; owners: number; backup: string | null } {
  const rows = repos.db.all<{id:string;principal_id:string;content:string;source_kind:string}>("SELECT e.id,e.principal_id,r.content,r.source_kind FROM affect_events e LEFT JOIN appraisals a ON a.id=e.appraisal_id JOIN raw_messages r ON r.id=COALESCE(a.source_message_id,CASE WHEN json_valid(e.payload_json) THEN json_extract(e.payload_json,'$.appraisal.sourceMessageId') END) WHERE e.status='active'")
    .filter(row=>detectSourceKind(row.content,row.source_kind)==='codex-bridge')
  if (!rows.length) return {events:0,owners:0,backup:null}
  const backup = repos.db.file === ':memory:' ? null : backupNow(repos.db,{directory:backupDirectory(repos.db.file),keepDays:config.storage.backupRetentionDays,label:`bridge-affect-repair-${nowMs}`},nowMs).file
  return repos.db.transaction(()=>{
    const owners=new Set(rows.map(row=>row.principal_id))
    for(const row of rows)repos.db.run("UPDATE affect_events SET status='retracted' WHERE id=? AND status='active'",row.id)
    for(const id of owners){const previous=repos.getSnapshot(id);repos.putSnapshot(rebuildAffect(repos,config,id,nowMs),previous?.revision??0)}
    repos.audit({principalId:null,kind:'bridge-affect-repair',entityId:null,payload:{events:rows.length,owners:owners.size},createdAtMs:nowMs})
    return {events:rows.length,owners:owners.size,backup}
  })
}
