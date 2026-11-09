import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {mkdirSync,readFileSync,readdirSync} from 'node:fs';
import {dirname,join} from 'node:path';

// Implements the D1 surface used by the Worker. Batch operations never yield
// between BEGIN and COMMIT, so other HTTP requests cannot enter a transaction.
export function openDatabase(filename,migrationsDirectory){
  if(filename!==':memory:')mkdirSync(dirname(filename),{recursive:true,mode:0o700});
  const raw=new DatabaseSync(filename);
  raw.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
  if(filename!==':memory:')raw.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;');
  raw.exec('CREATE TABLE IF NOT EXISTS __guild_migrations(name TEXT PRIMARY KEY,checksum TEXT NOT NULL,applied_at TEXT NOT NULL)');
  for(const name of readdirSync(migrationsDirectory).filter(name=>/^\d+_[\w-]+\.sql$/.test(name)).sort()){
    const sql=readFileSync(join(migrationsDirectory,name),'utf8'),checksum=createHash('sha256').update(sql).digest('hex');
    const applied=raw.prepare('SELECT checksum FROM __guild_migrations WHERE name=?').get(name);
    if(applied){if(applied.checksum!==checksum){raw.close();throw Error('An applied migration changed; restore the matching source before starting.');}continue;}
    raw.exec('BEGIN IMMEDIATE');
    try{
      raw.exec(sql);
      raw.prepare('INSERT INTO __guild_migrations VALUES(?,?,?)').run(name,checksum,new Date().toISOString());
      raw.exec('COMMIT');
    }catch(error){raw.exec('ROLLBACK');raw.close();throw Error('Database migration failed; no migration details were printed.',{cause:error});}
  }
  const meta=()=>{const result=raw.prepare('SELECT changes() changes,last_insert_rowid() rowid').get();return {changes:Number(result.changes),last_row_id:Number(result.rowid)};};
  class Statement{
    constructor(sql,params=[]){this.sql=sql;this.params=params;}
    bind(...params){return new Statement(this.sql,params.map(value=>value instanceof ArrayBuffer?new Uint8Array(value):value));}
    async first(column){const row=raw.prepare(this.sql).get(...this.params);return row?(column===undefined?row:row[column]??null):null;}
    async all(){return {success:true,results:raw.prepare(this.sql).all(...this.params),meta:meta()};}
    async run(){raw.prepare(this.sql).run(...this.params);return {success:true,results:[],meta:meta()};}
  }
  let closed=false;
  return {
    raw,prepare:sql=>new Statement(sql),
    async batch(statements){
      if(statements.length>200)throw Error('Database batch is too large');
      raw.exec('BEGIN IMMEDIATE');
      try{
        const results=statements.map(statement=>{
          if(!(statement instanceof Statement))throw Error('Invalid database statement');
          const prepared=raw.prepare(statement.sql),rows=prepared.columns().length?prepared.all(...statement.params):null;
          if(rows===null)prepared.run(...statement.params);
          return {success:true,results:rows||[],meta:meta()};
        });
        raw.exec('COMMIT');return results;
      }catch(error){raw.exec('ROLLBACK');throw error;}
    },
    close(){if(!closed){closed=true;raw.close();}}
  };
}
