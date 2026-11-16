/** Neo4j projection. Every identifier is version-scoped; all Cypher is application-owned. */
import assert from 'node:assert/strict';
import neo4j from 'neo4j-driver';
import { sha, answerPlan, validateSchema, validateClaims, queryPlanIssues } from './engine.mjs';

export function graphConfig(body) {
  assert(body && typeof body.uri === 'string', '需要 Neo4j Bolt 地址');
  const url = new URL(body.uri);
  assert(['bolt:', 'neo4j:', 'bolt+s:', 'neo4j+s:'].includes(url.protocol)
    && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    && !url.username && !url.password && !url.search && !url.hash && ['', '/'].includes(url.pathname),
  '当前仅支持无内嵌凭据的本机 Bolt 连接');
  assert(typeof body.username === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(body.username), '数据库用户名无效');
  assert(typeof body.password === 'string' && body.password.length > 0 && body.password.length <= 1024, '需要数据库密码');
  const database = body.database || 'neo4j';
  assert(/^[a-zA-Z][a-zA-Z0-9._-]{0,62}$/.test(database), '数据库名称无效');
  return { uri: body.uri, username: body.username, password: body.password, database };
}

export function projection(job, workspace) {
  assert(['READY', 'REVIEW_REQUIRED'].includes(job.status), '仅完整候选版本可以入图');
  const { input, result } = job;
  validateSchema(result.schema, input);
  const checked = validateClaims({ claims: result.claims }, result.schema, input);
  // Do not accept edited task JSON whose quote or identity no longer matches the validation output.
  assert(checked.claims.length === result.claims.length && checked.claims.every((c, i) =>
    c.id === result.claims[i].id && c.quote === result.claims[i].quote && c.start === result.claims[i].start
    && c.end === result.claims[i].end), '声明与原文定位或稳定ID不一致');
  const version = `${workspace}:${job.id}`;
  const key = (kind, id) => `${version}:${kind}:${id}`;
  const sources = input.sources.map(s => ({ key: key('source', s.id), props: {
    id: s.id, title: s.title, sha256: s.sha256, content: s.content,
    parsing_json: JSON.stringify(s.parsing || null) } }));
  const entities = result.schema.entities.map(e => ({ key: key('entity', e.id), props: { id: e.id, name: e.name, type: e.type } }));
  const predicates = result.schema.predicates.map(p => ({ key: key('predicate', p.id), props: {
    id: p.id, label: p.label, value_type: p.value_type, unit: p.unit, cardinality: p.cardinality || 'MANY' } }));
  const claims = result.claims.map(c => ({ key: key('claim', c.id),
    subject: key('entity', c.subject_id), predicate: key('predicate', c.predicate_id),
    object: result.schema.predicates.find(p => p.id === c.predicate_id).value_type === 'ENTITY' ? key('entity', c.value) : null,
    evidence: key('evidence', c.evidence_id), source: key('source', c.source_id),
    props: { id: c.id, subject_id: c.subject_id, predicate_id: c.predicate_id, value: c.value,
      modality: c.modality, comparator: c.comparator, unit: c.unit, scope: c.scope,
      effective_from: c.effective_from, payload_json: JSON.stringify(c) },
    evidence_props: { id: c.evidence_id, quote: c.quote, start: c.start, end: c.end,
      source_sha256: input.sources.find(s => s.id === c.source_id).sha256,
      offset_unit: c.offset_unit, independently_verified: false } }));
  const fingerprint = sha({ contract: 'cqforge_graph_v1', input, schema: result.schema,
    claims: result.claims, gate: result.gate, status: job.status });
  return { version, fingerprint, sources, entities, predicates, claims,
    props: { task_id: job.id, workspace, name: input.name, status: job.status, fingerprint,
      contract: 'cqforge_graph_v1', created_at: job.created_at,
      schema_json: JSON.stringify(result.schema), revision_json: JSON.stringify(job.revision || null),
      parent_key: job.revision ? `${workspace}:${job.revision.parent_id}` : null,
      publication_approved: false, independently_verified: false } };
}

export const templateCypher = Object.freeze({
  FACTS: `MATCH (v:CQFVersion {key:$version})-[:HAS_CLAIM]->(c:CQFClaim)-[:ABOUT]->(s:CQFEntity)
    MATCH (c)-[:USES_PREDICATE]->(p:CQFPredicate)
    MATCH (c)-[:SUPPORTED_BY]->(e:CQFEvidence)-[:IN_SOURCE]->(d:CQFSource)
    WHERE v.status = 'READY' AND p.id = $predicate AND ($subject IS NULL OR s.id = $subject)
      AND ($object IS NULL OR c.value = $object)
    RETURN c.payload_json AS payload, e.quote AS quote, e.start AS start, e.end AS end, d.sha256 AS source_hash`,
  ENTITIES: `MATCH (v:CQFVersion {key:$version})-[:HAS_CLAIM]->(c:CQFClaim)-[:ABOUT]->(s:CQFEntity)
    MATCH (c)-[:USES_PREDICATE]->(p:CQFPredicate)
    MATCH (c)-[:SUPPORTED_BY]->(e:CQFEvidence)-[:IN_SOURCE]->(d:CQFSource)
    WHERE v.status = 'READY' AND p.id = $predicate AND ($subject IS NULL OR s.id = $subject)
      AND ($object IS NULL OR c.value = $object)
    RETURN c.payload_json AS payload, e.quote AS quote, e.start AS start, e.end AS end, d.sha256 AS source_hash`,
  COMPARE: `MATCH (v:CQFVersion {key:$version})-[:HAS_CLAIM]->(c:CQFClaim)-[:ABOUT]->(s:CQFEntity)
    MATCH (c)-[:USES_PREDICATE]->(p:CQFPredicate)
    MATCH (c)-[:SUPPORTED_BY]->(e:CQFEvidence)-[:IN_SOURCE]->(d:CQFSource)
    WHERE v.status = 'READY' AND p.id = $predicate AND s.id IN $subjects
      AND ($object IS NULL OR c.value = $object)
    RETURN c.payload_json AS payload, e.quote AS quote, e.start AS start, e.end AS end, d.sha256 AS source_hash`
});

export async function connectGraph(body, workspace, { driverFactory = neo4j.driver } = {}) {
  const config = graphConfig(body);
  const driver = driverFactory(config.uri, neo4j.auth.basic(config.username, config.password), {
    connectionTimeout: 5000, maxTransactionRetryTime: 5000, disableLosslessIntegers: true });
  const options = { database: config.database };
  try {
    await driver.verifyConnectivity();
    await driver.executeQuery('RETURN 1 AS ok', {}, options);
    // One constraint covers the shared CQForge key namespace; unrelated graph labels are untouched.
    await driver.executeQuery('CREATE CONSTRAINT cqforge_node_key IF NOT EXISTS FOR (n:CQFNode) REQUIRE n.key IS UNIQUE', {}, options);
  } catch (error) { await driver.close(); throw new Error('Neo4j 连接失败：' + (error.code || 'NETWORK_OR_CONFIGURATION')); }
  return {
    info: { connected: true, uri: config.uri, database: config.database, workspace },
    async close() { await driver.close(); },
    async removeVersions(ids){
      const versions=ids.map(id=>`${workspace}:${id}`),session=driver.session(options);
      try{await session.executeWrite(tx=>tx.run('MATCH (n:CQFNode) WHERE any(v IN $versions WHERE n.key = v OR n.key STARTS WITH v + ":") DETACH DELETE n',{versions}));}finally{await session.close();}
    },
    async sync(job) {
      const graph = projection(job, workspace), session = driver.session(options);
      try { await session.executeWrite(async tx => {
        const v = await tx.run(`MERGE (v:CQFNode:CQFVersion {key:$version})
          WITH v WHERE v.fingerprint IS NULL OR v.fingerprint = $fingerprint
          SET v += $props RETURN v.fingerprint AS fingerprint`, { version: graph.version, props: graph.props, fingerprint: graph.fingerprint });
        assert(v.records[0]?.get('fingerprint') === graph.fingerprint, '已入图版本内容不同；请创建新版本，不能覆盖');
        await tx.run(`MATCH (v:CQFVersion {key:$version}) UNWIND $rows AS row
          MERGE (n:CQFNode:CQFSource {key:row.key}) ON CREATE SET n += row.props MERGE (v)-[:HAS_SOURCE]->(n)`, { version: graph.version, rows: graph.sources });
        await tx.run(`MATCH (v:CQFVersion {key:$version}) UNWIND $rows AS row
          MERGE (n:CQFNode:CQFEntity {key:row.key}) ON CREATE SET n += row.props MERGE (v)-[:HAS_ENTITY]->(n)`, { version: graph.version, rows: graph.entities });
        await tx.run(`MATCH (v:CQFVersion {key:$version}) UNWIND $rows AS row
          MERGE (n:CQFNode:CQFPredicate {key:row.key}) ON CREATE SET n += row.props MERGE (v)-[:HAS_PREDICATE]->(n)`, { version: graph.version, rows: graph.predicates });
        await tx.run(`MATCH (v:CQFVersion {key:$version}) UNWIND $rows AS row
          MATCH (s:CQFEntity {key:row.subject}), (p:CQFPredicate {key:row.predicate}), (d:CQFSource {key:row.source})
          MERGE (c:CQFNode:CQFClaim {key:row.key}) ON CREATE SET c += row.props
          MERGE (e:CQFNode:CQFEvidence {key:row.evidence}) ON CREATE SET e += row.evidence_props
          MERGE (v)-[:HAS_CLAIM]->(c) MERGE (c)-[:ABOUT]->(s) MERGE (c)-[:USES_PREDICATE]->(p)
          MERGE (c)-[:SUPPORTED_BY]->(e) MERGE (e)-[:IN_SOURCE]->(d)
          FOREACH (_ IN CASE WHEN row.object IS NULL THEN [] ELSE [1] END |
            MERGE (o:CQFNode:CQFEntity {key:row.object}) MERGE (c)-[:OBJECT]->(o))`, { version: graph.version, rows: graph.claims });
        if (graph.props.parent_key) await tx.run(`MATCH (v:CQFVersion {key:$version})
          MERGE (p:CQFNode:CQFVersion {key:$parent})
          ON CREATE SET p.status = 'NOT_IMPORTED', p.workspace = $workspace, p.task_id = $parent_id
          MERGE (v)-[:REVISES]->(p)`, { version: graph.version, parent: graph.props.parent_key,
          workspace, parent_id: job.revision.parent_id });
      }); } finally { await session.close(); }
      return { status: 'SYNCED', version_key: graph.version, fingerprint: graph.fingerprint,
        claims: graph.claims.length, at: new Date().toISOString(), backend: 'NEO4J' };
    },
    async query(job, cqId) {
      const plan = job.result?.schema?.cq_plans.find(p => p.cq_id === cqId);
      if (job.status !== 'READY' || !plan || plan.template === 'UNKNOWN' || queryPlanIssues({ cq_plans: [plan] }, job.input).length)
        return { ...answerPlan(job.result || { status: job.status }, job.input, plan), backend: 'NEO4J', query_executed: false };
      const expected = projection(job, workspace);
      const version = await driver.executeQuery('MATCH (v:CQFVersion {key:$version}) RETURN v.fingerprint AS fingerprint, v.status AS status', { version: expected.version }, options);
      assert(version.records[0]?.get('fingerprint') === expected.fingerprint && version.records[0]?.get('status') === 'READY', '图版本不存在或与本地版本不一致，请先同步');
      assert(Object.hasOwn(templateCypher, plan.template), '未支持的图查询模板');
      const records = await driver.executeQuery(templateCypher[plan.template], { version: expected.version,
        subject: plan.subject_id ?? null, subjects: plan.subject_ids || [], predicate: plan.predicate_id, object: plan.object_value ?? null }, options);
      const claims = records.records.map(r => {
        const c = JSON.parse(r.get('payload')), source = job.input.sources.find(s => s.id === c.source_id);
        assert(source?.sha256 === r.get('source_hash') && c.quote === r.get('quote')
          && c.start === r.get('start') && c.end === r.get('end'), '图谱证据链不一致');
        const original = job.result.claims.find(item => item.id === c.id);
        assert(original && sha(original) === sha(c), '图谱声明与受审版本不一致');
        return c;
      });
      return { ...answerPlan({ ...job.result, claims }, job.input, plan), backend: 'NEO4J',
        template: plan.template, version_key: expected.version };
    }
  };
}
