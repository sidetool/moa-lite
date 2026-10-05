// SPDX-License-Identifier: GPL-3.0-or-later
export const MAX_SYNC_BYTES = 3 * 1024 * 1024;
export type SyncRow = { version: number; value: Record<string, unknown> | null };
export type SyncDocument = { revision: number; rows: Record<string, SyncRow> };
export type SyncChange = { key: string; base: number; value: SyncRow['value'] };
export function validateSync(input: any): { since: number; changes: SyncChange[] } {
  if (!input || !Number.isSafeInteger(input.since) || input.since < 0 || !Array.isArray(input.changes) || input.changes.length > 100) throw new Error('invalid_sync');
  const seen = new Set();
  for (const row of input.changes) {
    if (!row || typeof row.key !== 'string' || row.key.length > 12000 || !Number.isSafeInteger(row.base) || row.base < 0 || seen.has(row.key)) throw new Error('invalid_sync');
    seen.add(row.key);
    let key: unknown; try { key = JSON.parse(row.key); } catch { throw new Error('invalid_sync'); }
    if (!Array.isArray(key) || !['repo','pin','recent','progress','mark'].includes(key[0]) || key.length !== ({repo:2,pin:3,recent:4,progress:4,mark:5} as any)[key[0]]) throw new Error('invalid_sync');
    for (let i=1;i<key.length;i++) {
      if (typeof key[i] !== 'string' || !key[i].length || key[i].length > 4096 || /[\u0000-\u001f\u007f]/.test(key[i])) throw new Error('invalid_sync');
      if (i===2) { if (!/^[\w-]{1,80}$/.test(key[i])) throw new Error('invalid_sync'); continue; }
      // Extensions also use relative paths as work/chapter identities. Validate
      // against a dummy base without changing the identity sent back to them.
      // Repository URLs still require an absolute HTTPS URL.
      let url: URL; try { url=i===1 ? new URL(key[i]) : new URL(key[i], 'https://source.invalid/'); } catch { throw new Error('invalid_sync'); }
      if (!['https:','http:'].includes(url.protocol) || (i===1 && url.protocol!=='https:') || url.username || url.password) throw new Error('invalid_sync');
    }
    if (row.value===null) continue;
    const fields: Record<string, string[]> = { repo:[], pin:['sourceName','itemType'], recent:['title','author','sourceName','chapterUrl','chapterTitle','updatedAt'], progress:['page','totalPages','ratio','readerAnchor','updatedAt'], mark:['read','updatedAt'] };
    if (!row.value || typeof row.value !== 'object' || Array.isArray(row.value) || Object.keys(row.value).some(name=>!fields[key[0]].includes(name))) throw new Error('invalid_sync');
    for (const [name,value] of Object.entries(row.value)) {
      if (name==='readerAnchor') {
        if (!value || typeof value!=='object' || Array.isArray(value)) throw new Error('invalid_sync');
        for (const [field,part] of Object.entries(value)) {
          if (['bookId','contentRevisionId','sectionId','blockId'].includes(field)) { if (typeof part!=='string' || part.length>8192) throw new Error('invalid_sync'); }
          else if (['blockIndex','offset'].includes(field)) { if (!Number.isSafeInteger(part) || (part as number)<0) throw new Error('invalid_sync'); }
          else throw new Error('invalid_sync');
        }
      } else if (['itemType','page','totalPages','ratio','updatedAt'].includes(name)) {
        if (typeof value!=='number' || !Number.isFinite(value) || value<0 || value>Number.MAX_SAFE_INTEGER || (name==='ratio' && value>1)) throw new Error('invalid_sync');
      } else if (name==='read') { if (typeof value!=='boolean') throw new Error('invalid_sync'); }
      else if (typeof value!=='string' || value.length>(name==='chapterUrl'?4096:500)) throw new Error('invalid_sync');
    }
    if (JSON.stringify(row.value).length>16000) throw new Error('invalid_sync');
  }
  return {since:input.since,changes:input.changes};
}
export function changeDocument(doc: SyncDocument, input: ReturnType<typeof validateSync>) {
  const conflicts: string[]=[];
  for (const change of input.changes) {
    if ((doc.rows[change.key]?.version || 0)!==change.base) { conflicts.push(change.key); continue; }
    doc.rows[change.key]={version:++doc.revision,value:change.value};
  }
  if (Object.keys(doc.rows).length>3000 || Buffer.byteLength(JSON.stringify(doc))>MAX_SYNC_BYTES) throw new Error('sync_limit');
  const rows=Object.fromEntries(Object.entries(doc.rows).filter(([key,row])=>row.version>input.since || conflicts.includes(key)));
  for(const key of conflicts) rows[key] ||= {version:0,value:null};
  return {revision:doc.revision,rows,conflicts};
}
// Same atomic compare-and-set semantics as the local store. Deleted rows retain their revision.
export const syncScript = `
if op=='syncRead' or op=='syncWrite' then
 local doc=get(KEYS[6]) or {revision=0,rows={}}
 local conflicts={}
 for _,change in ipairs(data.changes or {}) do
  local previous=doc.rows[change.key]
  if (previous and previous.version or 0)~=change.base then conflicts[change.key]=true
  else doc.revision=doc.revision+1;doc.rows[change.key]={version=doc.revision,value=change.value} end
 end
 local encoded=cjson.encode(doc)
 local count=0;for _ in pairs(doc.rows) do count=count+1 end
 if #encoded>${MAX_SYNC_BYTES} or count>3000 then return fail('sync_limit') end
 if op=='syncWrite' then redis.call('SET',KEYS[6],encoded) end
 local rows={};for key,row in pairs(doc.rows) do if row.version>data.since or conflicts[key] then rows[key]=row end end
 for key in pairs(conflicts) do if not rows[key] then rows[key]={version=0,value=cjson.null} end end
 return done({revision=doc.revision,rows=rows,conflicts=conflicts})
end
`;
