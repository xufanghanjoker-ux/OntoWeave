/** Composable route for independent retrieval. Mount behind the product auth boundary. */
import {need} from './cq-discovery-store-v2.mjs';
import {openNativeQueryEvents} from './native-query-sse-delivery-v1.mjs';
export function createNativeQueryHttp({product,json,parseBody,authorize=async()=>false}){
  return async function handle({req,res,pathname}){
    const match=pathname.match(/^\/api\/product\/libraries\/([A-Za-z0-9_-]{1,160})\/native-query\/(ask|capabilities|conversations(?:\/([A-Za-z0-9_-]{1,160}))?|queries(?:\/([A-Za-z0-9_-]{1,160})(?:\/(cancel|events)|\/citations\/([A-Za-z0-9_-]{1,160}))?)?)$/);
    if(!match)return false;
    try{
      const [,libraryId,action,conversationId,queryId,subaction,citationRef]=match;
      need(await authorize({req,libraryId,action}),'QUERY_HTTP_FORBIDDEN');
      if(action==='capabilities'&&req.method==='GET'){json(res,200,await product.capabilities({libraryId,...readTemporalUrl(req.url??pathname)}));return true;}
      if(action==='queries'&&req.method==='GET'){json(res,200,await product.list({libraryId}));return true;}
      if(action==='conversations'&&req.method==='GET'){json(res,200,await product.conversations({libraryId}));return true;}
      if(conversationId&&req.method==='GET'){json(res,200,await product.conversation({libraryId,conversationId}));return true;}
      if(action==='ask'&&req.method==='POST'){
        const body=await parseBody(req);need(body&&typeof body==='object'&&!Array.isArray(body)&&Object.keys(body).every(k=>['question','request_id','context','conversation_id','at','as_of','view_revision'].includes(k)),'QUERY_HTTP_ARGUMENTS_INVALID');
        const result=await product.ask({libraryId,question:body.question,requestId:body.request_id,context:body.context??[],conversationId:body.conversation_id??null,at:body.at,as_of:body.as_of,viewRevision:body.view_revision??null});json(res,result.idempotent?200:202,result);return true;
      }
      if(queryId&&subaction==='events'&&req.method==='GET'){
        const url=new URL(req.url,'http://localhost'),cursors=[url.searchParams.get('after'),req.headers['last-event-id']].filter(v=>v!==null&&v!==undefined&&v!=='');
        need(cursors.every(v=>typeof v==='string'&&/^(?:0|[1-9]\d{0,12})$/.test(v)),'QUERY_EVENT_CURSOR_INVALID');const after=Math.max(0,...cursors.map(Number));
        // Validate authorization, query and cursor before committing SSE headers.
        await product.assertReadable?.({libraryId,queryId});
        const state=product.eventState({libraryId,queryId});need(Number.isSafeInteger(state.last_event_seq)&&after<=state.last_event_seq,'QUERY_EVENT_CURSOR_INVALID');
        // Let Node choose connection persistence from the mounted server policy.
        // Explicit keep-alive conflicts with mainProduct maxRequestsPerSocket=1.
        res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-cache, no-transform','X-Accel-Buffering':'no'});res.flushHeaders?.();
        openNativeQueryEvents({req,res,product,libraryId,queryId,after});return true;
      }
      if(queryId&&citationRef&&req.method==='GET'){json(res,200,await product.citation({libraryId,queryId,citationRef}));return true;}
      if(queryId&&!subaction&&req.method==='GET'){json(res,200,await product.status({libraryId,queryId}));return true;}
      if(queryId&&subaction==='cancel'&&req.method==='POST'){json(res,200,await product.cancel({libraryId,queryId}));return true;}
      need(false,'QUERY_HTTP_METHOD_NOT_ALLOWED');
    }catch(error){if(res.headersSent){res.end();return true;}json(res,['QUERY_HTTP_FORBIDDEN','QUERY_AUTHORIZATION_REVOKED'].includes(error.code)?403:['QUERY_NOT_FOUND','QUERY_CITATION_NOT_FOUND','QUERY_CONVERSATION_NOT_FOUND'].includes(error.code)?404:['QUERY_CONCURRENT_BUSY','QUERY_REQUEST_CONFLICT'].includes(error.code)?409:400,{error:{code:error.code??'QUERY_HTTP_FAILED'}});return true;}
  };
}

function readTemporalUrl(url){const query=new URL(url,'http://localhost').searchParams,value={};if(query.has('view_revision'))value.viewRevision=query.get('view_revision');if(query.has('at'))value.at=query.get('at');if(query.has('as_of')){try{value.as_of=JSON.parse(query.get('as_of'));}catch{need(false,'QUERY_TEMPORAL_AS_OF_INVALID');}}return value;}
