import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const tool=path.join(repo,'tools','hyperframes');
const stage=path.join(tool,'stage');
const runtime=path.join(stage,'runtime');
const require=createRequire(path.join(tool,'package.json'));const AdmZip=require('adm-zip');
const {versions}=await import(pathToFileURL(path.join(tool,'runtime.mjs')));
const cache=path.join(repo,'work','hyperframes-cache');await fsp.mkdir(cache,{recursive:true});await fsp.mkdir(runtime,{recursive:true});
const sha=async file=>{const digest=crypto.createHash('sha256');for await(const chunk of fs.createReadStream(file))digest.update(chunk);return digest.digest('hex');};
async function download(url,name,expected){const target=path.join(cache,name);if(fs.existsSync(target)&&(!expected||await sha(target)===expected))return target;console.log(`Downloading ${name}`);const response=await fetch(url,{signal:AbortSignal.timeout(300000)});if(!response.ok)throw Error(`${response.status} downloading ${url}`);const temp=target+'.partial';await pipeline(Readable.fromWeb(response.body),fs.createWriteStream(temp));if(expected&&await sha(temp)!==expected)throw Error(`SHA256 mismatch: ${name}`);await fsp.rename(temp,target);return target;}
async function copyVerified(source,target,expected){if(await sha(source)!==expected)throw Error(`Cached runtime SHA256 mismatch: ${source}`);await fsp.mkdir(path.dirname(target),{recursive:true});await fsp.copyFile(source,target);}
const nodeSha='ba4e6d110e8c1592a1ecd390f6b05f3da124b13871a5be62b341a07a853c6c32';
const nodeExe=process.env.MEDIAHUB_NODE_CACHE?path.join(process.env.MEDIAHUB_NODE_CACHE,'node.exe'):await download('https://nodejs.org/dist/v24.21.0/win-x64/node.exe','node-24.21.0.exe',nodeSha);
await copyVerified(nodeExe,path.join(runtime,'node','node.exe'),nodeSha);
const nodeLicense=process.env.MEDIAHUB_NODE_CACHE?path.join(process.env.MEDIAHUB_NODE_CACHE,'LICENSE'):await download('https://raw.githubusercontent.com/nodejs/node/v24.21.0/LICENSE','Node-LICENSE.txt');await fsp.copyFile(nodeLicense,path.join(runtime,'node','LICENSE'));
const chromeUrl='https://storage.googleapis.com/chrome-for-testing-public/152.0.7977.30/win64/chrome-headless-shell-win64.zip';
const chromeZip=await download(chromeUrl,'chrome-headless-shell-152.0.7977.30.zip');
if(!fs.existsSync(path.join(runtime,'chrome','chrome-headless-shell.exe'))){console.log('Extracting Chrome');const zip=new AdmZip(chromeZip);for(const entry of zip.getEntries()){if(entry.isDirectory)continue;const relative=entry.entryName.replace(/^chrome-headless-shell-win64\//,'');const output=path.resolve(runtime,'chrome',relative);if(!output.startsWith(path.join(runtime,'chrome')+path.sep))throw Error('Unsafe Chrome archive path');await fsp.mkdir(path.dirname(output),{recursive:true});await fsp.writeFile(output,entry.getData());}}
const ffmpegHashes={'ffmpeg.exe':'09948d4cdd0650da6ff5a87577469f2a218dc2615ae379f8f734d24c49de0f73','ffprobe.exe':'a6618e99bb58869ded3c6f37b53aa1a8d701c3591dbb7b5b317d47369c112be2'};
let ffmpegSource=process.env.MEDIAHUB_FFMPEG_CACHE;
await fsp.mkdir(path.join(runtime,'ffmpeg'),{recursive:true});
if(!ffmpegSource){const archive=await download('https://www.gyan.dev/ffmpeg/builds/packages/ffmpeg-8.1.1-full_build.7z','ffmpeg-8.1.1-full_build.7z');const sevenZip=process.env.MEDIAHUB_7ZIP;if(!sevenZip)throw Error('Set MEDIAHUB_7ZIP to a trusted 7z executable, or MEDIAHUB_FFMPEG_CACHE to the pinned extracted Gyan full build');const extracted=path.join(cache,'ffmpeg-extracted');execFileSync(sevenZip,['x','-y',`-o${extracted}`,archive],{windowsHide:true,stdio:'inherit'});const dir=(await fsp.readdir(extracted)).find(n=>n.startsWith('ffmpeg'));ffmpegSource=path.join(extracted,dir,'bin');await fsp.copyFile(path.join(extracted,dir,'LICENSE'),path.join(runtime,'ffmpeg','LICENSE'));await fsp.copyFile(path.join(extracted,dir,'README.txt'),path.join(runtime,'ffmpeg','README.txt'));}
await fsp.mkdir(path.join(runtime,'ffmpeg'),{recursive:true});
for(const[name,hash]of Object.entries(ffmpegHashes))await copyVerified(path.join(ffmpegSource,name),path.join(runtime,'ffmpeg',name),hash);
for(const name of ['LICENSE','README.txt'])if(fs.existsSync(path.join(ffmpegSource,name)))await fsp.copyFile(path.join(ffmpegSource,name),path.join(runtime,'ffmpeg',name));
const fontRef='66928797f271fed5ee428544e7229685e2d90127';const fontBase=`https://raw.githubusercontent.com/google/fonts/${fontRef}/ofl/notosanssc/`;
const font=await download(fontBase+'NotoSansSC%5Bwght%5D.ttf','NotoSansSC.ttf');const ofl=await download(fontBase+'OFL.txt','NotoSansSC-OFL.txt');await fsp.mkdir(path.join(runtime,'fonts'),{recursive:true});await fsp.copyFile(font,path.join(runtime,'fonts','NotoSansSC.ttf'));await fsp.copyFile(ofl,path.join(runtime,'fonts','OFL.txt'));
const runtimeLock={schemaVersion:1,versions,sources:{node:{url:'https://nodejs.org/dist/v24.21.0/win-x64/node.exe',sha256:nodeSha,license:'MIT and included third-party licenses'},chrome:{url:chromeUrl,archiveSha256:await sha(chromeZip),license:'BSD-3-Clause and included Chromium credits'},ffmpeg:{url:'https://www.gyan.dev/ffmpeg/builds/packages/ffmpeg-8.1.1-full_build.7z',hashes:ffmpegHashes,license:'GPL-3.0-or-later',source:'https://github.com/FFmpeg/FFmpeg/commit/239f2c733d'},font:{url:fontBase+'NotoSansSC%5Bwght%5D.ttf',sha256:await sha(font),license:'OFL-1.1',sourceCommit:fontRef}}};
await fsp.writeFile(path.join(tool,'runtime-lock.json'),JSON.stringify(runtimeLock,null,2));
if(process.argv.includes('--prepare-only')){console.log('Runtime prepared: '+runtime);process.exit(0);}
console.log('Preparing independent component');
for(const name of ['adapter.mjs','service-entry.mjs','render-worker.mjs','runtime.mjs','template.mjs','studio.mjs','README.md','package.json','package-lock.json','runtime-lock.json'])if(fs.existsSync(path.join(tool,name)))await fsp.copyFile(path.join(tool,name),path.join(stage,name));
await fsp.cp(path.join(tool,'node_modules'),path.join(stage,'node_modules'),{recursive:true});
await fsp.mkdir(path.join(stage,'licenses'),{recursive:true});
const hfLicense=path.join(tool,'node_modules','@hyperframes','core','LICENSE');await fsp.copyFile(hfLicense,path.join(stage,'licenses','HyperFrames-APACHE-2.0.txt'));
const provenance={schemaVersion:1,componentVersion:versions.tool,hyperframes:{version:versions.hyperframes,repository:'https://github.com/heygen-com/hyperframes',commit:'7c73b3c',license:'Apache-2.0'},runtime:runtimeLock,dependencies:JSON.parse(await fsp.readFile(path.join(tool,'package-lock.json'),'utf8')).packages};
await fsp.writeFile(path.join(stage,'source-provenance.json'),JSON.stringify(provenance,null,2));
await fsp.writeFile(path.join(stage,'licenses','THIRD-PARTY-NOTICES.txt'),`MediaHub HyperFrames component ${versions.tool}\nMediaHub adapter: MIT\nHyperFrames ${versions.hyperframes}: Apache-2.0, exact upstream commit and npm integrity recorded in source-provenance.json.\nNode ${versions.node}: runtime/node/LICENSE.\nChromium ${versions.chrome}: runtime/chrome/LICENSE.headless_shell and credits supplied by Chrome for Testing.\nFFmpeg/FFprobe ${versions.ffmpeg} Gyan full build: GPL-3.0-or-later. See runtime/ffmpeg/LICENSE, README.txt, pinned binary hashes and source links in runtime-lock.json. It is a separate process executable. Full build includes static external libraries listed in its README.\nNoto Sans SC: OFL-1.1, runtime/fonts/OFL.txt; pinned source repository revision in runtime-lock.json.\nGSAP ${versions.gsap}: Standard License, node_modules/gsap/LICENSE and npm package metadata.\nAll npm dependency versions, integrity and sources are recorded in package-lock.json/source-provenance.json; distributed package license files are retained inside node_modules.\n`);
const files=[];async function inventory(dir){for(const entry of await fsp.readdir(dir,{withFileTypes:true})){const file=path.join(dir,entry.name);if(entry.isDirectory())await inventory(file);else{const relative=path.relative(stage,file).replaceAll('\\','/');if(relative==='manifest.json')continue;files.push({path:relative,size:(await fsp.stat(file)).size,sha256:await sha(file)});}}}await inventory(stage);files.sort((a,b)=>a.path.localeCompare(b.path));
const manifest={schemaVersion:1,id:'hyperframes',version:versions.tool,platform:'win32',arch:'x64',upstreamVersion:versions.hyperframes,entry:'service-entry.mjs',runtime:{node:'runtime/node/node.exe',chrome:'runtime/chrome/chrome-headless-shell.exe',ffmpeg:'runtime/ffmpeg/ffmpeg.exe',ffprobe:'runtime/ffmpeg/ffprobe.exe'},capabilities:['create','preview','lint','check','render','import','cancel','status','shutdown'],files};await fsp.writeFile(path.join(stage,'manifest.json'),JSON.stringify(manifest,null,2));
const release=path.join(repo,'release');await fsp.mkdir(release,{recursive:true});const zipPath=path.join(release,`MediaHub-HyperFrames-${versions.tool}-win-x64.zip`);if(fs.existsSync(zipPath))throw Error('Release assets are immutable; remove local unpublished staging asset explicitly or increment the component version');console.log('Compressing tool ZIP');const zip=new AdmZip();zip.addLocalFolder(stage);zip.writeZip(zipPath);const digest=await sha(zipPath);await fsp.writeFile(zipPath+'.sha256',`${digest}  ${path.basename(zipPath)}\n`);await fsp.copyFile(path.join(stage,'manifest.json'),path.join(release,`HyperFrames-${versions.tool}.manifest.json`));await fsp.copyFile(path.join(stage,'source-provenance.json'),path.join(release,`HyperFrames-${versions.tool}.sources.json`));console.log(JSON.stringify({zipPath,sha256:digest,size:(await fsp.stat(zipPath)).size,files:files.length}));
