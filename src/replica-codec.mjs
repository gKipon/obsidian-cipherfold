// Aliases are resolved by build.mjs to the pinned, reviewed LiveSync1.0.40 /
// commonlib0.2.0 checkout. No PouchDB runtime is instantiated by this module.
import {getConfiguredFunctionsForEncryption} from 'replica-upstream/encryption';
import {path2id_base} from 'replica-upstream/path';
import {configuredIdKey,createChunkIdGenerator} from 'replica-upstream/id';
import {readContent} from 'replica-upstream/content';
import {encodeBinary} from 'replica-upstream/binary';
export async function codecFactory(settings,salt){
  const {incoming:encode,outgoing:decode}=getConfiguredFunctionsForEncryption(settings.passphrase,settings.useDynamicIterationCount,false,async()=>salt,settings.E2EEAlgorithm,true,()=>{});
  const key=configuredIdKey(settings);
  return {encode,decode,encodeBinary,content:readContent,chunkId:await createChunkIdGenerator(key),pathId:path=>path2id_base(path,settings.passphrase,!settings.handleFilenameCaseSensitive,key)};
}
