import fs from 'node:fs';
import path from 'node:path';
import { HEARTBEAT_GRACE_PERIOD_MS } from '../config.js';

export function touchHeartbeat(filePath: string):void{
    const now=new Date();
    try{
        fs.utimesSync(filePath,now,now);
    }catch{
        try {
            const dir=path.dirname(filePath);
            if(!fs.existsSync(dir)){
                fs.mkdirSync(dir,{recursive: true});
            }
            fs.writeFileSync(filePath,'');
        } catch (error) {
            
        }
    }
}

export function readHeartbeatTime(filePath: string):number | null{
    try {
        return fs.statSync(filePath).mtimeMs;
    } catch (error) {
        return null;
    }
}

export function isHeartbeatFresh(
  filePath: string,
  maxAgeMs: number = HEARTBEAT_GRACE_PERIOD_MS
): boolean {
  const mtime = readHeartbeatTime(filePath);
  if (mtime === null) {
    return false;
  }
  return Date.now() - mtime <= maxAgeMs;
}

