export * from '../client/index.js';
import initSqlJs from 'sql.js';
import {readState,writeState,accountLock} from '../client/storage.js';
export async function ageCache(account: string){await accountLock(account,async()=>{const state=await readState(account);const SQL=await initSqlJs({locateFile:()=>'/runtime/sql-wasm.wasm'});const db=new SQL.Database(new Uint8Array(state.bytes));db.run('UPDATE source_read_cache SET fetched=fetched-360000');state.bytes=db.export();state.stamp=crypto.randomUUID();await writeState(account,state);db.close();});}
