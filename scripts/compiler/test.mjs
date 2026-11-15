// Native Gradle DSL integration, including both Groovy and Kotlin project files.
import assert from 'node:assert/strict';
import {createReport} from '../report.mjs';
import {capture} from './capture.mjs';
import {mkdtempSync,realpathSync,mkdirSync,writeFileSync,readFileSync,renameSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,relative} from 'node:path';
import {runTool} from './process.mjs';
import {BackendClient,bounded} from './backend-client.mjs';
const pkg=resolve('dist/package/io.github.lithe-idea.gradle-build');
const gradle=process.env.GRADLE??'gradle';
const scratch=realpathSync(mkdtempSync(join(tmpdir(),'lithe-gradle-compiler-')));
const gradleHome=join(scratch,'gradle-home');
const report=createReport('native-compiler');
const command=(tool,args,cwd)=>runTool(tool,args,{cwd,env:{...process.env,GRADLE_USER_HOME:gradleHome},timeout:180000});
let client;
try{
 for(const kotlin of [false,true]){
  await report.step(kotlin?'Kotlin native compiler/library flow':'Groovy native compiler/library flow',async()=>{
  const root=join(scratch,kotlin?'kotlin':'groovy');mkdirSync(root);const suffix=kotlin?'.gradle.kts':'.gradle';
  writeFileSync(join(root,'settings'+suffix),kotlin?'rootProject.name="fixture"\ninclude("a", "b")\n':"rootProject.name='fixture'\ninclude 'a', 'b'\n");
  const original=kotlin?'// keep-comment\nsubprojects { apply(plugin = "java"); tasks.withType<org.gradle.api.tasks.compile.JavaCompile>().configureEach { options.release.set(11) } }\n':"// keep-comment\nsubprojects { apply plugin: 'java'; tasks.withType(org.gradle.api.tasks.compile.JavaCompile).configureEach { options.release.set(11) } }\n";
  writeFileSync(join(root,'build'+suffix),original);
  for(const name of ['a','b']){mkdirSync(join(root,name,'src/main/java'),{recursive:true});writeFileSync(join(root,name,'build'+suffix),'// module configuration\n');writeFileSync(join(root,name,'src/main/java/Main.java'),'public class Main { public static void main(String[] args) { System.out.print("ok"); } }');}
  async function run(args){return await command(gradle,['--no-daemon','--no-configuration-cache','--no-configure-on-demand',...args],root);}
  async function model(){const output=join(root,'model.json');await run(['--init-script',join(pkg,'lithe.init.gradle'),`-PlitheModelOutput=${output}`,'litheModel']);const value=JSON.parse(readFileSync(output));for(const project of value.projects)project.path=relative(root,project.path).replaceAll('\\','/')||'.';return value;}
  client=new BackendClient({java:process.env.LITHE_TEST_JAVA??'java',jar:join(pkg,'lib/lithe-gradle-backend.jar'),args:[],hostRequests:{'lithe/host/workspace/getFolders':()=>({folders:[{rootID:'r',name:'workspace',path:root}]})}});await client.initialize(root,{functions:true});let op=0;
  const invoke=(functionID,params)=>client.request('lithe/function/invoke',{functionID,operationID:`compiler-${++op}`,params,context:{contextID:'compiler',generation:1}});
  const read=async(libraries=false,language='zh-CN')=>invoke(libraries?'libraries.settings':'compiler.settings',{context:{language,builds:[{root:'.',options:{},tool:{executable:gradle},model:await model()}]}});
  let snapshot=await read();assert.equal(snapshot.sources.length,3);assert.equal(readFileSync(join(root,'build'+suffix),'utf8'),original);
  const source=snapshot.sources.find(s=>s.path==='a/build'+suffix);assert.equal(source.fields[0].effectiveValue,'11');assert.equal(source.fields[0].value,null);
  async function publish(source,values){const stage=join(scratch,'staged.gradle');writeFileSync(stage,'');await invoke('compiler.prepareSettings',{operation:'editSource',sourceID:source.id,revision:source.revision,values,outputFile:stage});renameSync(stage,join(root,source.path));}
  await publish(source,{target:'8'});await run(['compileJava']);assert.equal(readFileSync(join(root,'a/build/classes/java/main/Main.class')).readUInt16BE(6),52);assert.equal(readFileSync(join(root,'b/build/classes/java/main/Main.class')).readUInt16BE(6),55);
  snapshot=await read();assert.equal(snapshot.sources.find(s=>s.path==='a/build'+suffix).fields[0].effectiveValue,'8');assert.equal(snapshot.sources.find(s=>s.path==='a/build'+suffix).fields[0].inheritedValue,'11');
  capture('zh',snapshot);capture('en',await read(false,'en'));
  const jars=join(scratch,'jar');mkdirSync(jars,{recursive:true});writeFileSync(join(jars,'Library.java'),'package fixture; public class Library { public static String value() { return "jar-ok"; } }');await command('javac',['--release','8','-d',jars,join(jars,'Library.java')],root);const jar=join(scratch,'External Library.jar');await command('jar',['--create','--file',jar,'-C',jars,'fixture'],root);
  snapshot=await read(true);await publish(snapshot.sources.find(s=>s.path==='a/build'+suffix),{libraries:[jar]});writeFileSync(join(root,'a/src/main/java/Main.java'),'public class Main { public static void main(String[] args) { System.out.print(fixture.Library.value()); } }');await run(['compileJava']);assert.equal((await command('java',['-cp',join(root,'a/build/classes/java/main')+(process.platform==='win32'?';':':')+jar,'Main'],root)).toString(),'jar-ok');
  snapshot=await read();const live=snapshot.sources.find(s=>s.path==='a/build'+suffix);await publish(live,{target:null});snapshot=await read();assert.equal(snapshot.sources.find(s=>s.path==='a/build'+suffix).fields[0].effectiveValue,'11');assert.match(readFileSync(join(root,'a/build'+suffix),'utf8'),/module configuration/);
  assert.equal(client.diagnostics.some(f=>f.operation==='compiler.settings'&&f.kind==='operationFinished'),false);assert.equal(client.diagnostics.some(f=>f.operation==='compiler.prepareSettings'&&f.kind==='operationFinished'),true);
  assert.equal(await client.close(),0);client=undefined;
  });
 }
}finally{
 if(client){client.kill();await bounded(client.exited,'Gradle compiler backend cleanup');}
 report.write();rmSync(scratch,{recursive:true,force:true});
}
