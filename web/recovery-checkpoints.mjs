/** Preserve not-yet-reached checkpoints across repeated technical recovery attempts.
 * These are candidates only: the pipeline still checks fingerprints, hashes and validators.
 */
export function recoveryCheckpointBank(job) {
  const bank=new Map();
  for(const row of [...(job.recovery_checkpoints||[]),...(job.result?.checkpoints||[]),...(job.checkpoints||[])]) {
    if(!row||typeof row.key!=='string'||typeof row.fingerprint!=='string')continue;
    bank.set(row.key+'\0'+row.fingerprint,row);
  }
  return structuredClone([...bank.values()]);
}

export function technicalSuccessor(job,head,getTask){
 const seen=new Set();let current=head;
 while(current&&!seen.has(current.id)&&current.revision?.kind==='TECHNICAL_RESUME'){
  seen.add(current.id);const id=current.revision.parent_id;if(id===job.id)return head.id;current=getTask(id);
 }
 return null;
}
