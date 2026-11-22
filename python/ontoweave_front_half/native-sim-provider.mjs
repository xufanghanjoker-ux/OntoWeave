/** In-process Responses fixtures. These requests never reach a provider. */
export function simulatedResponses({role, model, turns, readTool}) {
  let next = 0;
  const frame = event => 'data: ' + JSON.stringify(event) + '\n\n';
  const calls = (fixture, index) => (
    fixture.tool_calls ?? (fixture.read_arguments ?? (fixture.read_material ? ['{}'] : []))
      .map(args => ({name: readTool, arguments: args}))
  ).map((call, ordinal) => {
    const suffix = index + (ordinal ? '_' + ordinal : '');
    return {
      id: role + '_function_' + suffix, type: 'function_call',
      call_id: call.call_id ?? role + '_call_' + suffix, namespace: 'mcp__lightog_native',
      name: call.name, arguments: call.arguments, status: 'completed',
    };
  });
  return async ({body}) => {
    const index = next++;
    const fixture = turns[index];
    if (!fixture) throw Error('NATIVE_FIXTURE_EXHAUSTED');
    if (fixture.expect_tool_output) {
      const items = JSON.parse(Buffer.from(body).toString('utf8')).input;
      const expected = calls(turns[index - 1], index - 1);
      if (!expected.length || expected.some(call => !items.some(item =>
        item.type === 'function_call_output' && item.call_id === call.call_id))) throw Error('NATIVE_FIXTURE_TOOL_OUTPUT_MISSING');
    }
    const outcome = fixture.outcome ?? 'RETURNED';
    const toolCalls = calls(fixture, index);
    const messages = toolCalls.length ? toolCalls : (fixture.messages ?? [fixture.text ?? '']).map((text, i) => ({
      id: role + '_msg_' + index + '_' + i, type: 'message', role: 'assistant', phase: 'final_answer',
      status: 'completed', content: [{type: 'output_text', text, annotations: []}],
    }));
    const response = {id: role + '_resp_' + index, object: 'response', model, status: 'completed',
      output: messages, usage: {input_tokens: 10, output_tokens: 5, total_tokens: 15}};
    const events = [{type: 'response.created', response: {...response, status: 'in_progress', output: []}}];
    for (const [output_index, item] of messages.entries()) {
      if (item.type === 'function_call') {
        events.push({type: 'response.output_item.added', output_index, item: {...item, status: 'in_progress', arguments: ''}});
        events.push({type: 'response.function_call_arguments.delta', item_id: item.id, output_index, delta: item.arguments});
        events.push({type: 'response.function_call_arguments.done', item_id: item.id, output_index, arguments: item.arguments});
      } else {
        events.push({type: 'response.output_item.added', output_index, item: {...item, status: 'in_progress', content: []}});
        events.push({type: 'response.output_text.delta', item_id: item.id, output_index, content_index: 0, delta: item.content[0].text});
      }
      events.push({type: 'response.output_item.done', output_index, item});
    }
    if (outcome === 'RETURNED') events.push({type: 'response.completed', response});
    else if (outcome === 'FAILED') events.push({type: 'response.failed', response: {...response, status: 'failed'}});
    return {status: fixture.http_status ?? 200, headers: {'content-type': 'text/event-stream'},
      body: (async function* () {
        const bytes = Buffer.from(events.map(frame).join(''));
        for (let offset = 0; offset < bytes.length; offset += 17) yield bytes.subarray(offset, offset + 17);
      })()};
  };
}

