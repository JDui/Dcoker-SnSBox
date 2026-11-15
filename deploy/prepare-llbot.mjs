// Prepare a NEW isolated LLBot directory. Never import an official QQ profile.
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {randomBytes,createHash} from 'node:crypto';
const uin=process.argv[2];
if(!uin||!/^\d{5,20}$/.test(uin))throw Error('Usage: node deploy/prepare-llbot.mjs EXPECTED_QQ_UIN');
const root=resolve('private/qq-llbot');
await mkdir(resolve('private'),{recursive:true,mode:0o700});
await mkdir(root,{mode:0o700}); // EEXIST deliberately refuses overwriting existing credentials.
await mkdir(join(root,'data'),{mode:0o700});
const password=randomBytes(32).toString('base64url');
const milky=randomBytes(32).toString('base64url');
const write=(name,value)=>writeFile(join(root,name),value,{flag:'wx',mode:0o600});
await write('data/webui_token.txt',password);
// Upstream's X-Webui-Token authentication scheme; this is NOT file checksum verification.
await write('management-token',createHash('sha256').update(password).digest('hex'));
await write('milky-token',milky);
await write('default_config.json',JSON.stringify({
 webui:{enable:true,host:'127.0.0.1',port:3080},
 milky:{enable:true,reportSelfMessage:false,http:{host:'127.0.0.1',port:3010,prefix:'',accessToken:milky},webhook:{urls:[],accessToken:''}},
 ob11:{enable:false,connect:[]},satori:{enable:false,host:'127.0.0.1',port:5600,token:''},
 enableLocalFile2Url:false,log:false,logLevel:'warn',autoDeleteFile:false,ffmpeg:'/usr/bin/ffmpeg'
},null,2));
await write('account-entry.json',JSON.stringify({id:'qq-main',platform:'qq',displayName:'QQ',baseUrl:'http://127.0.0.1:3010',tokenFile:'/run/secrets/llbot-milky-token',managementUrl:'http://127.0.0.1:3080',managementTokenFile:'/run/secrets/llbot-management-token',upstreamAccountId:uin},null,2));
console.log('Prepared private/qq-llbot. Merge account-entry.json into private/accounts.json. No token contents printed; no source profile read.');
