"""Single-attempt provider port. Durable checkpoint forbids automatic resend.

This small adapter uses the existing native embedding wire contract. An injected
external ledger port may replace FileLedger; it must reserve before transport and
settle only known outcomes. No global product ledger or generation call is made.
"""
import json
import hashlib
import urllib.error
import os
import time
import urllib.request
from pathlib import Path
from .core import canonical,digest,require,vector,normalize,space_ref


class FileLedger:
    """Dedicated CLI checkpoint, not the product-wide external-call ledger."""
    def __init__(self,path): self.path=Path(path)
    def reserve(self, metadata):
        # O_EXCL makes parallel/restarted invocations fail closed, including UNKNOWN.
        fd=os.open(self.path,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600)
        with os.fdopen(fd,'w') as f:
            json.dump(dict(status='STARTED',**metadata),f); f.flush(); os.fsync(f.fileno())
    def settle(self, status, **fields):
        old=json.loads(self.path.read_text()); require(old['status']=='STARTED','LEDGER_ALREADY_SETTLED')
        tmp=self.path.with_suffix('.tmp')
        with tmp.open('w') as f:
            json.dump({**old,'status':status,**fields},f); f.flush(); os.fsync(f.fileno())
        os.replace(tmp,self.path)


def public_space(config):
    public={k:v for k,v in config.items() if k!='api_key'}
    require(config.get('protocol') in ('dashscope-native','openai-compatible') and config.get('endpoint_mode') in ('base','full'),'PROTOCOL_INVALID')
    require(config['base_url'].startswith('https://') and config.get('dimensions') and config.get('model'),'CONFIG_INVALID')
    return dict(provider='QWEN_CONFIGURED',model=config['model'],deployment=digest({'endpoint':config['base_url'],'protocol':config['protocol'],'text_type':'document'}),
                revision=config.get('model_revision') or 'configuration-sha256:'+digest(public),dimensions=config['dimensions'],normalization='NONE',input_version='cq-question-only/1')


def embed_once(texts, config, ledger, response_path, transport=None):
    require(0<len(texts)<=20 and texts==[normalize(t) for t in texts],'EMBEDDING_INPUT_INVALID')
    space=public_space(config); space_ref(space)
    native=config['protocol']=='dashscope-native'
    body=({'model':config['model'],'input':{'texts':texts},'parameters':{'text_type':'document','dimension':config['dimensions']}} if native else {'model':config['model'],'input':texts})
    wire=canonical(body).encode(); require(config.get('api_key'),'CREDENTIAL_REQUIRED')
    endpoint=config['base_url'].rstrip('/')+('/embeddings' if config['endpoint_mode']=='base' else '')
    ledger.reserve(dict(space_ref=space_ref(space),request_sha256=digest(body),items=len(texts),actual_requests=1))
    started=time.perf_counter(); received=False
    try:
        if transport: raw=transport(wire)
        else:
            class NoRedirect(urllib.request.HTTPRedirectHandler):
                def redirect_request(self,*args,**kwargs): return None
            request=urllib.request.Request(endpoint,data=wire,headers={'Content-Type':'application/json','Authorization':'Bearer '+config['api_key']},method='POST')
            try:
                with urllib.request.build_opener(NoRedirect).open(request,timeout=60) as response:
                    raw=response.read(16000001)
            except urllib.error.HTTPError as error:
                received=True
                raw=error.read(16000001).replace(config['api_key'].encode(),b'[REDACTED]')
                fd=os.open(response_path,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600)
                with os.fdopen(fd,'wb') as f: f.write(raw); f.flush(); os.fsync(f.fileno())
                raise ValueError('PROVIDER_HTTP_'+str(error.code)) from None
        received=True
        require(len(raw)<=16000000,'RESPONSE_TOO_LARGE')
        # Sanitize literal credential before retaining provider bytes.
        retained=raw.replace(config['api_key'].encode(),b'[REDACTED]')
        fd=os.open(response_path,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600)
        with os.fdopen(fd,'wb') as f: f.write(retained); f.flush(); os.fsync(f.fileno())
        parsed=json.loads(raw)
        require(not parsed.get('code'),'PROVIDER_ERROR')
        rows=parsed.get('output',{}).get('embeddings',[]) if native else parsed.get('data',[])
        index=lambda r:r.get('text_index',r.get('index'))
        require(all(not ('text_index'in r and 'index'in r) or r['text_index']==r['index'] for r in rows),'RESPONSE_INDEX_CONFLICT')
        rows=sorted(rows,key=index)
        require([index(r) for r in rows]==list(range(len(texts))),'RESPONSE_COVERAGE_INVALID')
        vectors=[vector(r['embedding'],space['dimensions']) for r in rows]
        receipt=dict(usage=parsed.get('usage'),usage_status='PROVIDED' if parsed.get('usage') else 'NOT_PROVIDED',request_id=parsed.get('request_id',parsed.get('id')),embedding_ms=(time.perf_counter()-started)*1000,response_sha256=hashlib.sha256(retained).hexdigest(),response_json_sha256=digest(json.loads(retained)),actual_requests=1)
        ledger.settle('RETURNED',**receipt)
        return vectors,receipt
    except Exception as exc:
        ledger.settle('FAILED' if received else 'UNKNOWN',error_type=type(exc).__name__,embedding_ms=(time.perf_counter()-started)*1000,new_dispatch_stopped=True)
        raise ValueError('EMBEDDING_FAILED' if received else 'EMBEDDING_OUTCOME_UNKNOWN') from None
