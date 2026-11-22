"""Local authenticated RPC adapts the existing JS native runtime to Python ports."""
import asyncio,json,secrets,threading,time
from http.server import ThreadingHTTPServer,BaseHTTPRequestHandler
from pathlib import Path
from ontoweave_cq_similarity.core import require
from .parse import ROOT
from .native_rpc import RPCChannels
from ontoweave_cq5000.errors import CQError
from datetime import datetime,timezone
class NativeTransport:
    def __init__(self,repo,run,config,credential):
        self.repo,self.run,self.config,self.credential=repo,run,config,credential
        self.active={};self.timings=[];self.token=secrets.token_urlsafe(32);owner=self
        self.channels = RPCChannels()
        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self,*args):pass
            def do_POST(self):
                if self.headers.get('Authorization')!='Bearer '+owner.token:self.send_error(403);return
                started=time.perf_counter();op='INVALID';body={}
                try:
                    length=int(self.headers.get('Content-Length','0'));require(0<length<=64000000,'RPC_SIZE_INVALID')
                    body=json.loads(self.rfile.read(length));op=body['op']

                    def execute():
                        try:
                            return dict(result=owner.call(body['scope'], op, body.get('args', {})))
                        except Exception as error:
                            return dict(error=getattr(error, 'code', 'FRONT_HALF_RPC_FAILED'))

                    value = owner.channels.dispatch(body, execute)
                except Exception as e:value=dict(error=getattr(e,'code','FRONT_HALF_RPC_FAILED'))
                owner.timings.append(dict(op=op,scope=body.get('scope'),wall_ms=(time.perf_counter()-started)*1000,
                                          channel=body.get('rpc_channel'), sequence=body.get('rpc_sequence'),
                                          client_port=self.client_address[1]))
                wire=json.dumps(value,ensure_ascii=False).encode()
                self.send_response(200)
                self.send_header('Content-Type', 'application/json; charset=utf-8')
                self.send_header('Content-Length', str(len(wire)))
                self.end_headers()
                try:
                    self.wfile.write(wire)
                except (BrokenPipeError, ConnectionResetError):
                    # The original action and its own persisted ledger retain authority.
                    self.close_connection = True
        self.server=ThreadingHTTPServer(('127.0.0.1',0),Handler)
        self.thread=threading.Thread(target=self.server.serve_forever,daemon=True);self.thread.start()
    def close(self):self.server.shutdown();self.server.server_close();self.thread.join()
    def call(self,scope,op,args):
        require(scope in self.active,'RPC_SCOPE_UNKNOWN')
        tools=self.active[scope].tools
        if op=='get':return self.repo.get_record(args['kind'],args['key'])
        if op=='put':return self.repo.put_record(args['kind'],args['key'],args['payload'])
        if op=='rows':return self.repo.list_rows()
        if op=='batch':return self.repo.batch(args['rows'])
        if op=='list':return [r['payload'] for r in self.repo.list_rows() if r['kind']==args['kind']]
        if op=='state':return self.run.state()
        if op=='assert_open':return self.run.assert_open()
        if op=='progress':return self.run.note_progress()
        if op=='stop':return self.run.stop(args['reason'],args['status'])
        if op=='reserve':return self.run.reserve(agent_scope=scope,request_bytes=args.get('requestBytes',0))
        if op=='settle':return self.run.settle(args['ref'],outcome=args['outcome'],usage=args.get('usage'),reason=args.get('reason'))
        if op=='complete':return tools.is_complete()
        if op=='tool':
            start=time.perf_counter()
            result=tools.call(args['name'],args.get('args',{}),args.get('context'))
            self.repo.put_record('tool_timing',str(time.time_ns()),dict(scope=scope,completed=tools.is_complete(),wall_ms=(time.perf_counter()-start)*1000))
            return result
        raise ValueError('RPC_OPERATION_INVALID')
    async def invoke(self,request):
        self.active[request.agent_scope]=request
        payload={k:getattr(request,k) for k in ('agent_scope','prompt','skill_paths','model','runtime_directory','max_format_repairs','max_incomplete_continuations')}
        payload.update(rpc_url='http://127.0.0.1:'+str(self.server.server_port),rpc_token=self.token,definitions=request.tools.definitions,generation=self.config['models']['generation'],runtime_binding=self.config['runtime_binding'],api_key=self.credential)
        if getattr(request,'mode',None)=='NATIVE_SIM':
            payload.update(mode='NATIVE_SIM',simulation=request.simulation)
        started=time.perf_counter();begin=datetime.now(timezone.utc).isoformat()
        proc=await asyncio.create_subprocess_exec('node',str(ROOT/'python/ontoweave_front_half/native.mjs'),stdin=asyncio.subprocess.PIPE,stdout=asyncio.subprocess.PIPE,stderr=asyncio.subprocess.PIPE,cwd=ROOT)
        stdout,stderr=await proc.communicate(json.dumps(payload).encode())
        elapsed=(time.perf_counter()-started)*1000
        self.repo.put_record('native_process',request.agent_scope,dict(started_at=begin,ended_at=datetime.now(timezone.utc).isoformat(),wall_ms=elapsed,exit_code=proc.returncode,stderr_bytes=len(stderr),stderr_redacted=stderr.decode(errors='replace').replace(self.credential,'[REDACTED]')[:200000] if self.credential else stderr.decode(errors='replace')[:200000]))
        if proc.returncode:
            try:code=json.loads(stdout).get('error','NATIVE_TRANSPORT_FAILED')
            except Exception:code='NATIVE_TRANSPORT_FAILED'
            self.repo.put_record('native_receipt',request.agent_scope,dict(error=code))
            raise CQError(code)
        result=json.loads(stdout)
        self.repo.put_record('native_receipt',request.agent_scope,result)
        return result
