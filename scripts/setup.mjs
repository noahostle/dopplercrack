import{spawnSync}from"node:child_process";import{fileURLToPath}from"node:url";
const root=fileURLToPath(new URL("../",import.meta.url));
if(!process.env.npm_execpath)throw new Error("Run npm run setup.");
function run(command,args){const result=spawnSync(command,args,{cwd:root,stdio:"inherit",windowsHide:true});if(result.error)throw result.error;if(result.status!==0)process.exit(result.status??1);}
run(process.execPath,[process.env.npm_execpath,"ci","--no-audit","--no-fund"]);
run(process.execPath,[fileURLToPath(new URL("./install-doppler.mjs",import.meta.url)),...process.argv.slice(2)]);
run(process.execPath,[process.env.npm_execpath,"run","build"]);
console.log("Dopplercrack is ready. Run npm start and open http://127.0.0.1:3857.");
