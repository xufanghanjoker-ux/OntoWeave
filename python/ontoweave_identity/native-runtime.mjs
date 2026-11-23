/** Load the pinned shared runtime with one identity-only Skill registration. */
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {registerHooks} from 'node:module';

export const BASE_SHA256 = '2ffa1229a5dc40fe3e966689ed6d382edf3e9ca1aea36d371f1a58fd11e1d58d';
export const IDENTITY_SHA256 = 'ce04271e9abe681729f3fded194a72e5625dc1647166da6b538a96cf86fed311';
const REGISTERED_BASE_SHA256 = 'b8d0dbcf21aeb033cf23b1287bcee24270dcb29c1b36dc14cdb15861cbff5161';
const REGISTERED_IDENTITY_SHA256 = 'd97d2a4b21f999c4fe115c62dd9f88b6fbf6ee7f221a1e8083a6d059cfa781b7';
const STABILITY_BASE_SHA256 = 'd566d1683c195b8a0fa7c006230da519f05ea41801f72844b5226d9897958f96';
const STABILITY_IDENTITY_SHA256 = '002f1dee1371c09163259dc3a7f1a546e50266f4b394e15aa92945fa986f1bf6';
const WORKBENCH_IDENTITY_SHA256 = '27cdfd6a555a2344f1bb41119c554f7c491349b4bb27fcab5369262a6abcce72';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const original = new URL('../../web/native-agent-runtime-v1.mjs', import.meta.url);
const derived = new URL('identity-native-runtime-v1.mjs', original).href;
const before = "'ontoweave-semantic-extraction-v2'].map(name=>join(root,'docs/skill-drafts',name,'SKILL.md'))";
const registeredBefore = "'ontoweave-ontology-alignment-v1'].map(name=>join(root,'docs/skill-drafts',name,'SKILL.md'))";

function verify(condition, code) {
  if (!condition) throw Object.assign(new Error(code), {code});
}

function verifySuccessor(incoming) {
  // The host verifies the packaged source inventory before Node
  // starts. Also enforce the compiled file and transform source pins here.
  const path = process.env.ONTOWEAVE_NATIVE_SUCCESSOR_MANIFEST;
  const expected = process.env.ONTOWEAVE_NATIVE_SUCCESSOR_SHA256;
  verify(path && expected, 'IDENTITY_SHARED_RUNTIME_BASELINE_CHANGED');
  const raw = readFileSync(path);
  verify(hash(raw) === expected, 'IDENTITY_SUCCESSOR_MANIFEST_CHANGED');
  const manifest = JSON.parse(raw.toString('utf8'));
  verify(manifest.contract === 'ontoweave-workbench-source-lock/1' &&
    manifest.baseline_id === 'ontoweave-workbench-0.2.0-alpha.2' &&
    Array.isArray(manifest.files), 'IDENTITY_WORKBENCH_SOURCE_LOCK_INVALID');
  const pins = new Map(manifest.files.map(row => [row.path, row.sha256]));
  verify(pins.size === manifest.files.length &&
    pins.get('web/native-agent-runtime-v1.mjs') === incoming &&
    pins.get('python/ontoweave_identity/native-runtime.mjs') === hash(readFileSync(new URL(import.meta.url))),
    'IDENTITY_SUCCESSOR_SOURCE_UNPINNED');
}

export function deriveIdentityRuntime(bytes) {
  const incoming = hash(bytes);
  const stability = incoming === STABILITY_BASE_SHA256;
  const registered = stability || incoming === REGISTERED_BASE_SHA256;
  const successor = !registered && incoming !== BASE_SHA256;
  if (successor) verifySuccessor(incoming);
  const source = bytes.toString('utf8');
  const marker = registered || successor ? registeredBefore : before;
  verify(source.split(marker).length === 2, 'IDENTITY_RUNTIME_REGISTRATION_POINT_CHANGED');
  const result = source.replace(marker, marker.replace("'].map", "','ontoweave-entity-resolution-v1'].map"));
  const expected = successor ? WORKBENCH_IDENTITY_SHA256 : stability ? STABILITY_IDENTITY_SHA256 :
    registered ? REGISTERED_IDENTITY_SHA256 : IDENTITY_SHA256;
  verify(hash(result) === expected, 'IDENTITY_DERIVED_RUNTIME_SHA_MISMATCH');
  return result;
}

export async function loadIdentityRuntime() {
  const source = deriveIdentityRuntime(readFileSync(original));
  // Give the derivation its own module identity while preserving relative imports
  // and the shared runtime's repository-root calculation.
  const hook = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === derived) return {url: derived, format: 'module', shortCircuit: true};
      return nextResolve(specifier, context);
    },
    load(url, context, nextLoad) {
      if (url === derived) return {format: 'module', source, shortCircuit: true};
      return nextLoad(url, context);
    },
  });
  try {
    return await import(derived);
  } finally {
    hook.deregister();
  }
}
