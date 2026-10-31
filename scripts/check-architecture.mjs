import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
export const rules = JSON.parse(fs.readFileSync(path.join(root,'scripts/architecture-rules.json'),'utf8'));
const slash = s => s.replaceAll('\\','/');
const within = (file,dir) => file===dir || file.startsWith(dir+'/');

/** Conservative: nonliteral module loads and external core dependencies fail closed. */
export function inspectSource(source, file, core, config=rules) {
  const ast=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS), errors=[], imports=[];
  const fail=(n,code)=>errors.push(`${slash(file)}:${ast.getLineAndCharacterOfPosition(n.getStart(ast)).line+1} ${code}`);
  const dependency=n=>{
    if(!n||!ts.isStringLiteralLike(n)){fail(n??ast,'DYNAMIC_DEPENDENCY');return;}
    imports.push(n.text);
    if(core&&!n.text.startsWith('.'))fail(n,'CORE_EXTERNAL_DEPENDENCY');
    if(config.forbiddenServicePaths.some(p=>slash(n.text).includes(p)))fail(n,'V1_DEPENDENCY');
  };
  const filename=slash(file),name=n=>ts.isIdentifier(n)||ts.isStringLiteralLike(n)?n.text:null;
  const credentialScope=(config.credentialIdentityRoots??[]).some(dir=>within(filename,dir));
  const candidateScope=config.candidateSelectionRoot&&within(filename,config.candidateSelectionRoot)&&!(config.candidateReaders??[]).includes(filename);
  const literal=n=>ts.isStringLiteralLike(n)||ts.isNumericLiteral(n)||n.kind===ts.SyntaxKind.NullKeyword;
  function visit(n){
    if(candidateScope&&((ts.isPropertyAccessExpression(n)&&n.name.text==='candidates')||
      (ts.isElementAccessExpression(n)&&n.argumentExpression&&name(n.argumentExpression)==='candidates')||
      (ts.isBindingElement(n)&&name(n.propertyName??n.name)==='candidates')))fail(n,'DISPATCH_OUTSIDE_PLANNING');
    if(credentialScope&&((ts.isPropertyAssignment(n)&&(config.credentialIdentityFields??[]).includes(name(n.name))&&literal(n.initializer))||
      ((ts.isVariableDeclaration(n)||ts.isPropertyDeclaration(n)||ts.isBindingElement(n))&&n.initializer&&(config.credentialIdentityFields??[]).includes(name(n.name))&&literal(n.initializer))||
      (ts.isBinaryExpression(n)&&n.operatorToken.kind===ts.SyntaxKind.EqualsToken&&literal(n.right)&&
        ((ts.isPropertyAccessExpression(n.left)&&(config.credentialIdentityFields??[]).includes(n.left.name.text))||
        (ts.isElementAccessExpression(n.left)&&n.left.argumentExpression&&(config.credentialIdentityFields??[]).includes(name(n.left.argumentExpression)))))))fail(n,'HARDCODED_CREDENTIAL_IDENTITY');
    if(ts.isImportDeclaration(n)||ts.isExportDeclaration(n)){if(n.moduleSpecifier)dependency(n.moduleSpecifier);}
    if(ts.isImportEqualsDeclaration(n)&&ts.isExternalModuleReference(n.moduleReference))dependency(n.moduleReference.expression);
    if(ts.isImportTypeNode(n)&&ts.isLiteralTypeNode(n.argument))dependency(n.argument.literal);
    if(ts.isCallExpression(n)&&(n.expression.kind===ts.SyntaxKind.ImportKeyword||(ts.isIdentifier(n.expression)&&n.expression.text==='require')))dependency(n.arguments[0]);
    if(core){
      if(ts.isStringLiteralLike(n)&&config.forbiddenLiterals.some(s=>n.text.toLowerCase().includes(s)))fail(n,'CONCRETE_IDENTITY');
      if(ts.isIdentifier(n)&&config.forbiddenGlobals.includes(n.text))fail(n,'AMBIENT_RUNTIME');
      if(ts.isIdentifier(n)&&n.text==='Math'&&!((ts.isPropertyAccessExpression(n.parent)||ts.isElementAccessExpression(n.parent))&&n.parent.expression===n))fail(n,'AMBIENT_RUNTIME');
      if(ts.isPropertyAccessExpression(n)&&config.forbiddenMembers.includes(n.getText(ast)))fail(n,'AMBIENT_RUNTIME');
      if(ts.isElementAccessExpression(n)&&ts.isIdentifier(n.expression)&&n.expression.text==='Math'&&(!n.argumentExpression||!ts.isStringLiteralLike(n.argumentExpression)||n.argumentExpression.text==='random'))fail(n,'AMBIENT_RUNTIME');
      if(ts.isVariableDeclaration(n)&&n.initializer&&ts.isIdentifier(n.initializer)&&n.initializer.text==='Math'&&ts.isObjectBindingPattern(n.name)&&n.name.elements.some(e=>(e.propertyName??e.name).getText(ast)==='random'))fail(n,'AMBIENT_RUNTIME');
    }
    ts.forEachChild(n,visit);
  }
  visit(ast);
  return {errors,imports};
}
function files(dir){return !fs.existsSync(dir)?[]:fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?files(path.join(dir,e.name)):/\.(?:ts|mts|cts|js|mjs|ets)$/.test(e.name)?[path.join(dir,e.name)]:[]);}
export function checkArchitecture(treeRoot=root){
  const errors=[];let count=0;
  for(const dir of rules.coreRoots)if(!files(path.join(treeRoot,dir)).length)errors.push(`${dir} CORE_SOURCE_MISSING`);
  const visited=new Set();
  function follow(file){
    if(visited.has(file))return;visited.add(file);
    const relative=slash(path.relative(treeRoot,file));
    if(relative.startsWith('..')||relative.startsWith('node_modules/')||relative.includes('/node_modules/')||relative.includes('/generated/')||relative.includes('/dist/')||relative.endsWith('.d.ts'))return;
    const source=fs.readFileSync(file,'utf8'),checked=inspectSource(source,relative,false);
    errors.push(...checked.errors);
    const configPath=ts.findConfigFile(path.dirname(file),ts.sys.fileExists);
    const options=configPath?ts.parseJsonConfigFileContent(ts.readConfigFile(configPath,ts.sys.readFile).config,ts.sys,path.dirname(configPath)).options:{};
    for(const spec of checked.imports){
      const resolved=ts.resolveModuleName(spec,file,{...options,moduleResolution:ts.ModuleResolutionKind.Node10},ts.sys).resolvedModule?.resolvedFileName;
      if(!resolved)continue;
      const destination=slash(path.relative(treeRoot,resolved));
      if(rules.forbiddenServicePaths.some(p=>within(destination,p)))errors.push(`${relative} TRANSITIVE_V1_DEPENDENCY ${spec}`);
      else if(/\.[cm]?[jt]s$/.test(resolved))follow(resolved);
    }
  }
  for(const [roots,core] of [[rules.coreRoots,true],[rules.serviceRoots,false]])for(const dir of roots)for(const file of files(path.join(treeRoot,dir))){
    count++;
    const checked=inspectSource(fs.readFileSync(file,'utf8'),path.relative(treeRoot,file),core);errors.push(...checked.errors);
    if(!core)follow(file);
    for(const spec of checked.imports){
      const resolved=ts.resolveModuleName(spec,file,{moduleResolution:ts.ModuleResolutionKind.Node10},ts.sys).resolvedModule?.resolvedFileName;
      const destination=slash(path.relative(treeRoot,resolved??path.resolve(path.dirname(file),spec)));
      if(core&&!within(destination,dir))errors.push(`${slash(path.relative(root,file))} CORE_ESCAPING_DEPENDENCY ${spec}`);
      if(rules.forbiddenServicePaths.some(p=>within(destination,p)))errors.push(`${slash(path.relative(root,file))} V1_DEPENDENCY ${spec}`);
    }
  }
  return {count,errors};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const checked=checkArchitecture(process.argv[2]?path.resolve(process.argv[2]):root);
  if(checked.errors.length){console.error(checked.errors.join('\n'));process.exitCode=1;}
  else console.log(`PASS architecture dependencies (${checked.count} files)`);
}
