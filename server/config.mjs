import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
export const projectRoot=fileURLToPath(new URL("../",import.meta.url));
// Project-local options only. Never import another application's environment.
try{for(const line of readFileSync(new URL("../.env.local",import.meta.url),"utf8").split(/\r?\n/)){
  const match=/^\s*([A-Z_][A-Z_0-9]*)\s*=\s*(.*?)\s*$/.exec(line);
  if(match&&(/^(DOPPLER_|GOOGLE_MAPS_BROWSER_KEY$)/.test(match[1]))&&process.env[match[1]]===undefined)process.env[match[1]]=match[2].replace(/^(['"])(.*)\1$/,"$2");
}}catch{}
export function localPort(value,fallback){const port=value===""||value===undefined?fallback:Number(value);if(!Number.isInteger(port)||port<0||port>65535)throw new Error("Port must be between 0 and 65535");return port;}
