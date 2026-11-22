"""Reuse the authenticated front-half RPC server; select extraction role adapter."""
import asyncio,json,time
import psycopg
from pathlib import Path
from ontoweave_front_half.native import NativeTransport
from ontoweave_cq.store import require
ROOT=Path(__file__).resolve().parents[2]
class ExtractionTransport(NativeTransport):
    def __init__(self,*args,on_unknown=None,**kwargs):
        self.on_unknown=on_unknown or (lambda:None)
        super().__init__(*args,**kwargs)
    def call(self,scope,op,args):
        try:
            result=super().call(scope,op,args)
            if op=='settle' and args.get('outcome')=='UNKNOWN':self.on_unknown()
            return result
        except (psycopg.Error,OSError) as error:
            # Never turn a connection/commit uncertainty into a skipped record or
            # a provider retry. The caller will hold this logical task.
            self.active[scope].tools.database_unknown=True
            self.on_unknown()
            require(False,'EXTRACTION_PG_OUTCOME_UNKNOWN')
    async def invoke(self,request):
        self.active[request.agent_scope]=request
        payload={k:getattr(request,k) for k in ('agent_scope','prompt','skill_paths','model','runtime_directory')}
        payload.update(rpc_url='http://127.0.0.1:'+str(self.server.server_port),rpc_token=self.token,definitions=request.tools.definitions,generation=self.config['models']['generation'],runtime_binding=self.config['runtime_binding'],api_key=self.credential,mode=request.mode,simulation=request.simulation)
        started=time.perf_counter()
        proc=await asyncio.create_subprocess_exec('node',str(ROOT/'python/ontoweave_extraction/native.mjs'),stdin=asyncio.subprocess.PIPE,stdout=asyncio.subprocess.PIPE,stderr=asyncio.subprocess.PIPE,cwd=ROOT)
        stdout,stderr=await proc.communicate(json.dumps(payload).encode())
        self.repo.put_record('native_process',request.agent_scope,dict(wall_ms=(time.perf_counter()-started)*1000,exit_code=proc.returncode,stderr_bytes=len(stderr),mode=request.mode))
        result=json.loads(stdout);self.repo.put_record('native_receipt',request.agent_scope,result)
        require(not proc.returncode,result.get('error','EXTRACTION_NATIVE_FAILED'));return result
